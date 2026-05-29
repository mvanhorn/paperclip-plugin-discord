/**
 * Shared types for the war-room voice client (Phase 1, STT-inbound only).
 * Spec: ../../../docs/superpowers/specs/2026-05-28-war-room-voice-design.md
 *       (in the MRTek mrt-ai-agent-platform repo)
 */

import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

export interface VoiceClientConfig {
  /** Discord guild (server) ID. */
  guildId: string;
  /** Discord voice channel ID to join on startup. */
  voiceChannelId: string;
  /** Webhook URL in the war-room text channel for posting transcripts as @Michael (voice). */
  textChannelWebhookUrl: string;
  /** Deepgram API key. */
  deepgramApiKey: string;
  /** Silence duration (ms) that ends an utterance. Default: 800. */
  utteranceEndSilenceMs?: number;
  /** Voice connection adapter from the host SDK / gateway. See voice/discord-adapter.ts. */
  voiceAdapterCreator: DiscordGatewayAdapterCreator;
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
}

export interface STTAdapter {
  /**
   * Send a single utterance (raw 16-bit PCM at 48 kHz mono) and return the final transcript.
   * Throws on transport failure or non-2xx close. Caller decides retry policy.
   */
  transcribeUtterance(pcm: Buffer): Promise<string>;
}

export interface TextChannelRelay {
  /** Post a transcript message to the war-room text channel as @Michael (voice). */
  postTranscript(text: string, metadata: { durationSec: number }): Promise<void>;
}
