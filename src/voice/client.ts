/**
 * War-room voice client (Phase 1, STT inbound only).
 *
 * Joins a Discord voice channel via @discordjs/voice using the custom
 * gateway adapter from ./discord-adapter.ts. For each speaker, listens
 * for an Opus stream that ends after 800 ms of silence (the silence
 * detection IS the VAD — no separate VAD library), decodes to PCM via
 * prism-media, transcribes via Deepgram, and posts the transcript to
 * the war-room text channel via the @Michael (voice) webhook.
 *
 * Out of scope for Phase 1: TTS outbound (Phase 2), per-agent voice
 * lookup (Phase 2), cost guard (Phase 3), latency CI checks (Phase 4).
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

import { DeepgramSTTAdapter } from "./stt-deepgram.js";
import { WebhookTextChannelRelay } from "./text-channel-relay.js";
import type { STTAdapter, TextChannelRelay, VoiceClientConfig } from "./types.js";

const DEFAULT_SILENCE_MS = 800;
const PCM_SAMPLE_RATE = 48_000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2; // 16-bit mono
const MIN_UTTERANCE_SEC = 0.2;
const CONNECTION_READY_TIMEOUT_MS = 5_000;

export class WarRoomVoiceClient {
  private connection: VoiceConnection | null = null;
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
    this.stt = stt ?? new DeepgramSTTAdapter({ apiKey: config.deepgramApiKey });
    this.relay =
      relay ?? new WebhookTextChannelRelay({ webhookUrl: config.textChannelWebhookUrl });
    this.silenceMs = config.utteranceEndSilenceMs ?? DEFAULT_SILENCE_MS;
  }

  /** Join the configured voice channel and start listening. */
  async start(): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: this.config.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true, // Phase 1 is inbound-only
    });

    await entersState(
      this.connection,
      VoiceConnectionStatus.Ready,
      CONNECTION_READY_TIMEOUT_MS,
    );

    const receiver = this.connection.receiver;

    receiver.speaking.on("start", (userId) => {
      this.handleUtterance(userId).catch((err) => {
        this.ctx.logger.error("voice: utterance handling failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.ctx.logger.info("voice: war-room voice client started", {
      guildId: this.config.guildId,
      channelId: this.config.voiceChannelId,
    });
  }

  /** Disconnect and clean up. */
  stop(): void {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
      this.ctx.logger.info("voice: war-room voice client stopped");
    }
  }

  private async handleUtterance(userId: string): Promise<void> {
    if (!this.connection) return;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.silenceMs,
      },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: PCM_SAMPLE_RATE,
    });

    const chunks: Buffer[] = [];
    return new Promise<void>((resolve) => {
      opusStream
        .pipe(decoder)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", async () => {
          const pcm = Buffer.concat(chunks);
          const durationSec = pcm.length / PCM_BYTES_PER_SECOND;

          if (durationSec < MIN_UTTERANCE_SEC) {
            // Too short to be a real utterance — likely a click or wakeword false-positive.
            resolve();
            return;
          }

          try {
            const transcript = await this.stt.transcribeUtterance(pcm);
            await this.relay.postTranscript(transcript, { durationSec });
          } catch (err) {
            this.ctx.logger.error("voice: STT or relay failed for utterance", {
              userId,
              durationSec: durationSec.toFixed(2),
              error: err instanceof Error ? err.message : String(err),
            });
          }
          resolve();
        })
        .on("error", (err: Error) => {
          this.ctx.logger.error("voice: decode error", {
            userId,
            error: err.message,
          });
          resolve();
        });
    });
  }
}
