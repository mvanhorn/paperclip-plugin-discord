/**
 * Discord voice client (Phase 1, STT inbound only).
 *
 * Joins a Discord voice channel via @discordjs/voice using the custom gateway
 * adapter from ./discord-adapter.ts. For each speaker, listens for an Opus
 * stream that ends after 800 ms of silence (the silence detection IS the VAD —
 * no separate VAD library), decodes to PCM via prism-media, transcribes via a
 * local Whisper adapter (see ./stt-whisper.ts — no audio leaves the machine),
 * hands the utterance to the plugin's inbound ingress, and posts the
 * transcript into a text channel by webhook so the room can see what was heard.
 *
 * The webhook post is DISPLAY ONLY. Nothing re-reads it: the utterance reaches
 * Paperclip through `ingestUtterance`, never by being routed back in as a
 * message. A transcript therefore cannot loop, and the inbound router keeps its
 * trust boundary — no webhook is ever accepted as a message source.
 *
 * Out of scope for Phase 1: TTS outbound (Phase 2), per-agent voice lookup
 * (Phase 2), cost guard (Phase 3), latency CI checks (Phase 4).
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import prism from "prism-media";

import { WhisperSTTAdapter } from "./stt-whisper.js";
import { WebhookTextChannelRelay } from "./text-channel-relay.js";
import type {
  STTAdapter,
  TextChannelRelay,
  VoiceClientConfig,
  VoiceUnavailableReason,
} from "./types.js";

const DEFAULT_SILENCE_MS = 800;
const PCM_SAMPLE_RATE = 48_000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2; // 16-bit mono
const OPUS_FRAME_SIZE = 960;
const OPUS_CHANNELS = 1;
const MIN_UTTERANCE_SEC = 0.2;
const CONNECTION_READY_TIMEOUT_MS = 5_000;

/** The one-line install hint every "voice deps are missing" error ends with. */
export const VOICE_DEPS_INSTALL_HINT =
  "npm install @discordjs/voice prism-media opusscript@0.0.8 libsodium-wrappers ws";

/**
 * prism-media does not bundle an Opus codec: it looks for @discordjs/opus,
 * node-opus, opusscript or ffmpeg-static at construction time and throws if it
 * finds none. Without this preflight that failure surfaces only on the first
 * real utterance, inside a per-utterance catch — the bot joins the channel,
 * looks healthy, and silently transcribes nothing. Fail loudly at startup
 * instead, with the command that fixes it.
 */
export function assertOpusEngineAvailable(): void {
  let probe: NodeJS.WritableStream & { destroy(): void };
  try {
    probe = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    }) as unknown as NodeJS.WritableStream & { destroy(): void };
  } catch (error) {
    throw new Error(
      "voice: no Opus engine available — prism-media cannot decode incoming " +
        "audio without one, so no transcript would ever be produced. Install " +
        `the optional voice dependencies: ${VOICE_DEPS_INSTALL_HINT}. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  probe.destroy();
}

/** Destroy a stream without letting the teardown itself throw or re-enter. */
function destroyQuietly(stream: { destroy(): void; destroyed?: boolean }): void {
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // Already torn down, or torn down by the same failure we are handling.
  }
}

export class VoiceClient {
  private connection: VoiceConnection | null = null;
  private unsubscribeReady: (() => void) | null = null;
  /** Set by stop(); makes every later ready signal a no-op. */
  private stopped = false;
  /** Guards against two ready signals joining concurrently. */
  private joining = false;
  /** Identifies one join of one channel; part of each utterance's thread key. */
  private sessionId: string | null = null;
  private available = false;
  /**
   * At most one Whisper transcription in flight at a time. Several speakers
   * finishing near-simultaneously would otherwise spawn one whisper-cli
   * process per speaker, and this model is not cheap. A second utterance
   * that lands while one is already transcribing is dropped, not queued —
   * simpler, and a backlog of stale utterances is not obviously better than
   * losing the newest one.
   */
  private transcribing = false;

  private readonly ctx: PluginContext;
  private readonly config: VoiceClientConfig;
  private readonly stt: STTAdapter;
  private readonly relay: TextChannelRelay;
  private readonly silenceMs: number;

  constructor(
    ctx: PluginContext,
    config: VoiceClientConfig,
    stt?: STTAdapter,
    relay?: TextChannelRelay,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.stt = stt ?? new WhisperSTTAdapter();
    this.relay =
      relay ??
      new WebhookTextChannelRelay({
        webhookUrl: config.textChannelWebhookUrl,
        username: config.relayUsername,
      });
    this.silenceMs = config.utteranceEndSilenceMs ?? DEFAULT_SILENCE_MS;
  }

  /**
   * Arm the client. Joining does NOT happen here.
   *
   * An op-4 voice-state-update is only deliverable once the gateway socket has
   * identified, and @discordjs/voice treats a join whose first send was refused
   * as terminal — it does not retry when the adapter becomes usable later. So
   * start() verifies the decode path, subscribes to the gateway's READY/RESUMED
   * boundary, and returns; the join happens on that boundary and on every later
   * one that finds no live connection.
   *
   * Throws only for a broken decode path, which is a configuration error the
   * operator has to fix; every runtime failure after this point is reported
   * through `onAvailabilityChange` instead.
   */
  async start(): Promise<void> {
    // Before touching the network: verify the decode path can actually work.
    assertOpusEngineAvailable();

    this.setAvailability(false, "waiting for the Discord gateway to be ready");
    this.unsubscribeReady = this.config.onGatewayReady(() => {
      void this.joinWhenReady();
    });

    this.ctx.logger.info("voice: armed, waiting for the gateway to be ready", {
      guildId: this.config.guildId,
      channelId: this.config.voiceChannelId,
    });
  }

  /** Disconnect and clean up. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.unsubscribeReady) {
      this.unsubscribeReady();
      this.unsubscribeReady = null;
    }
    const hadConnection = this.connection !== null;
    this.teardownConnection();
    this.available = false;
    if (hadConnection) this.ctx.logger.info("voice: voice client stopped");
  }

  /**
   * Join on a gateway readiness boundary, or confirm the existing connection is
   * still serviceable.
   *
   * Idempotent by design: this runs on every READY and every RESUMED. A voice
   * connection survives a gateway reconnect, so a healthy one is left alone —
   * rejoining on every resume would churn the channel for no reason. Only a
   * missing, disconnected or destroyed connection is (re)established, which is
   * exactly the state a refused initial op-4 leaves behind.
   */
  private async joinWhenReady(): Promise<void> {
    if (this.stopped || this.joining) return;

    const status = this.connection?.state.status;
    if (
      status === VoiceConnectionStatus.Ready ||
      status === VoiceConnectionStatus.Connecting ||
      status === VoiceConnectionStatus.Signalling
    ) {
      return;
    }

    this.joining = true;
    try {
      // A destroyed or disconnected connection still holds its adapter
      // subscriptions; drop it before creating its replacement.
      this.teardownConnection();

      let connection: VoiceConnection;
      try {
        connection = joinVoiceChannel({
          channelId: this.config.voiceChannelId,
          guildId: this.config.guildId,
          adapterCreator: this.config.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true, // Phase 1 is inbound-only
        });
      } catch (error) {
        this.setAvailability(false, "the voice channel could not be joined");
        this.ctx.logger.error("voice: joining the voice channel failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Retained BEFORE awaiting readiness: if entersState rejects, this is the
      // only reference that can destroy the connection and unsubscribe the
      // gateway adapter it registered.
      this.connection = connection;
      this.sessionId = `${Date.now().toString(36)}`;

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_READY_TIMEOUT_MS);
      } catch {
        this.teardownConnection();
        this.setAvailability(false, "the voice connection did not become ready");
        this.ctx.logger.warn(
          "voice: the voice connection did not become ready; will retry on the next gateway ready signal",
        );
        return;
      }

      if (this.stopped) {
        this.teardownConnection();
        return;
      }

      connection.receiver.speaking.on("start", (userId) => {
        // Checked before ANY work happens for this speaker: no subscribe, no
        // decode, no STT, no relay post. A rejected speaker leaves no trace.
        if (this.config.isAllowedSpeaker && !this.config.isAllowedSpeaker(userId)) {
          this.ctx.logger.info("voice: dropping a speaker who is not the configured operator", {
            userId,
          });
          return;
        }
        this.handleUtterance(userId, connection).catch((err) => {
          this.ctx.logger.error("voice: utterance handling failed", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      this.setAvailability(true);
      this.ctx.logger.info("voice: voice client started", {
        guildId: this.config.guildId,
        channelId: this.config.voiceChannelId,
      });
    } finally {
      this.joining = false;
    }
  }

  private teardownConnection(): void {
    const connection = this.connection;
    this.connection = null;
    this.sessionId = null;
    if (!connection) return;
    try {
      // destroy() runs the adapter's destroy(), which unsubscribes the gateway
      // voice handlers registered for this connection.
      connection.destroy();
    } catch (error) {
      // Destroying an already-destroyed connection throws; that is the state we
      // wanted anyway.
      this.ctx.logger.debug("voice: destroying the voice connection failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setAvailability(available: boolean, reason?: VoiceUnavailableReason): void {
    if (this.available === available && available) return;
    this.available = available;
    this.config.onAvailabilityChange?.(available, reason);
  }

  /**
   * Collect one utterance and hand it on.
   *
   * The receive stream and the decoder are two failure surfaces, and Node does
   * NOT forward a source's `error` through `pipe()`. @discordjs/voice destroys
   * the receive stream with an error when RTP parsing or decryption fails, so an
   * unlistened source error becomes an uncaught exception and takes the whole
   * worker down with it — text routing included. Both ends are therefore
   * listened to and both settle through one guarded path, which also guarantees
   * that a failed utterance never reaches STT or the webhook.
   */
  private handleUtterance(userId: string, connection: VoiceConnection): Promise<void> {
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    });

    const chunks: Buffer[] = [];
    const threadKey = this.threadKey();

    return new Promise<void>((resolve) => {
      let settled = false;

      const cleanup = (): void => {
        destroyQuietly(opusStream);
        destroyQuietly(decoder as unknown as { destroy(): void; destroyed?: boolean });
      };

      const fail = (stage: "receive" | "decode", err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.ctx.logger.error("voice: utterance dropped", {
          userId,
          stage,
          error: err.message,
        });
        resolve();
      };

      opusStream.on("error", (err: Error) => fail("receive", err));
      decoder.on("error", (err: Error) => fail("decode", err));
      decoder.on("data", (chunk: Buffer) => chunks.push(chunk));
      decoder.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        void this.deliver(userId, Buffer.concat(chunks), threadKey).then(resolve, resolve);
      });

      opusStream.pipe(decoder);
    });
  }

  /** Transcribe one utterance, ingest it, and show it in the text channel. */
  private async deliver(userId: string, pcm: Buffer, threadKey: string): Promise<void> {
    const durationSec = pcm.length / PCM_BYTES_PER_SECOND;
    if (durationSec < MIN_UTTERANCE_SEC) {
      // Too short to be a real utterance — likely a click or a wakeword false positive.
      return;
    }

    if (this.transcribing) {
      this.ctx.logger.info("voice: dropping an utterance — a transcription is already in flight", {
        userId,
      });
      return;
    }

    let transcript: string;
    this.transcribing = true;
    try {
      transcript = await this.stt.transcribeUtterance(pcm);
    } catch (err) {
      this.ctx.logger.error("voice: STT failed for utterance", {
        userId,
        durationSec: durationSec.toFixed(2),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    } finally {
      this.transcribing = false;
    }

    // Transcription is the long wait in this pipeline, and stopping the client
    // does not reach into it. An utterance that was still being transcribed when
    // this client was retired belongs to a runtime that no longer exists: it must
    // neither be ingested — the install may since have been handed to another
    // company — nor displayed in a channel this client has left.
    if (this.stopped) {
      this.ctx.logger.info("voice: dropping an utterance transcribed after shutdown", {
        userId,
      });
      return;
    }

    if (transcript.trim().length === 0) return;

    // Ingress first, display second: what Paperclip receives must not depend on
    // a webhook that might be revoked, rate-limited, or misconfigured.
    try {
      await this.config.ingestUtterance({
        userId,
        text: transcript,
        durationSec,
        finalizedAt: new Date().toISOString(),
        threadKey,
      });
    } catch (err) {
      this.ctx.logger.error("voice: ingesting the utterance failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Ingress is an await of its own, and stopping during it is as real as
    // stopping during transcription. Posting now would put a transcript into a
    // channel this client has already left.
    if (this.stopped) {
      this.ctx.logger.info("voice: not displaying an utterance ingested after shutdown", {
        userId,
      });
      return;
    }

    try {
      await this.relay.postTranscript(transcript, {
        durationSec,
        // Carried in, for the same reason it is carried into the ingress: the
        // relay's own retry sits on the far side of an await.
        isLive: () => !this.stopped,
      });
    } catch (err) {
      this.ctx.logger.error("voice: posting the transcript to the text channel failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stable for one join of one channel; distinct across rejoins. */
  private threadKey(): string {
    return `voice:${this.config.guildId}:${this.config.voiceChannelId}:${this.sessionId ?? "pending"}`;
  }
}
