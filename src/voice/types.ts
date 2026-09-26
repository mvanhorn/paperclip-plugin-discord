/**
 * Shared types for the Discord voice client (Phase 1, STT-inbound only).
 *
 * Phase 1 scope: join one voice channel, transcribe what is said there, hand
 * each utterance to the plugin's inbound ingress, and post the transcript into a
 * text channel so the room can see what was heard.
 */

import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

/** Default webhook display name for relayed transcripts. */
export const DEFAULT_RELAY_USERNAME = "Voice";

/**
 * Why voice is not currently available, in words safe to put in plugin health.
 *
 * Fixed phrases, never interpolated values: this text reaches operators through
 * the health surface, so it must not be able to carry a webhook URL, an API key,
 * or anything else a failure happened to be holding.
 */
export type VoiceUnavailableReason =
  | "waiting for the Discord gateway to be ready"
  | "the voice connection did not become ready"
  | "the voice channel could not be joined";

export interface VoiceClientConfig {
  /** Discord guild (server) ID. */
  guildId: string;
  /** Discord voice channel ID to join on startup. */
  voiceChannelId: string;
  /** Webhook URL of the text channel that transcripts are posted to. */
  textChannelWebhookUrl: string;
  /** Webhook display name for relayed transcripts. Default: "Voice". */
  relayUsername?: string;
  /** Silence duration (ms) that ends an utterance. Default: 800. */
  utteranceEndSilenceMs?: number;
  /** Voice connection adapter built over the plugin gateway. See voice/discord-adapter.ts. */
  voiceAdapterCreator: DiscordGatewayAdapterCreator;
  /**
   * Subscribe to the gateway's READY/RESUMED boundary; returns an unsubscribe
   * function. Joining is driven from this and from nothing else — see
   * `GatewayVoiceHandle.onGatewayReady` in src/gateway.ts.
   */
  onGatewayReady: (handler: () => void) => () => void;
  /**
   * Whether a speaker is worth listening to at all, checked BEFORE
   * subscribing to their audio, decoding it, or transcribing it — a speaker
   * this rejects is never recorded, never sent to Whisper, and never posted
   * to the text channel. Omit to process every speaker (unchanged default).
   */
  isAllowedSpeaker?: (userId: string) => boolean;
  /**
   * Hand a finished utterance to the plugin's inbound ingress. This is the ONLY
   * path by which a spoken utterance reaches Paperclip: the webhook post is
   * display, not transport.
   */
  ingestUtterance: (utterance: UtteranceFinalized) => Promise<void>;
  /** Voice availability transitions, for the plugin health surface. */
  onAvailabilityChange?: (available: boolean, reason?: VoiceUnavailableReason) => void;
}

export interface UtteranceFinalized {
  /** Discord user ID who spoke. */
  userId: string;
  /** Transcript text (final, post-VAD-endpoint). */
  text: string;
  /** Approximate utterance duration in seconds (computed from PCM length). */
  durationSec: number;
  /** ISO timestamp at finalize. */
  finalizedAt: string;
  /** Voice session key, stable for one join of one channel. */
  threadKey: string;
}

export interface STTAdapter {
  /**
   * Send a single utterance (raw 16-bit PCM at 48 kHz mono) and return the final transcript.
   * Throws on transport failure or non-2xx close. Caller decides retry policy.
   */
  transcribeUtterance(pcm: Buffer): Promise<string>;
}

export interface TextChannelRelay {
  /** Post a transcript message to the configured text channel. */
  postTranscript(
    text: string,
    metadata: {
      durationSec: number;
      /**
       * Whether the caller still has standing to write, asked again before any
       * attempt beyond the first. Posting spans an await, and a retry launched
       * after that await is a NEW write, not the completion of an old one.
       */
      isLive?: () => boolean;
    },
  ): Promise<void>;
}
