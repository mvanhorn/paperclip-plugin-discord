/**
 * Public exports for the war-room voice subsystem.
 * See ../../docs/superpowers/specs/2026-05-28-war-room-voice-design.md
 * (in the MRTek repo).
 */

export { WarRoomVoiceClient } from "./client.js";
export { createPluginDiscordAdapter } from "./discord-adapter.js";
export { DeepgramSTTAdapter } from "./stt-deepgram.js";
export { WebhookTextChannelRelay } from "./text-channel-relay.js";
export type {
  STTAdapter,
  TextChannelRelay,
  UtteranceFinalized,
  VoiceClientConfig,
} from "./types.js";
