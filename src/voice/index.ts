/**
 * Public exports for the voice subsystem (Phase 1, STT inbound only).
 *
 * Everything here depends on the optional voice peer dependencies
 * (@discordjs/voice, prism-media, opusscript, libsodium-wrappers, ws). Import
 * this module dynamically, inside a try/catch, so a plugin installed without
 * them keeps working — see src/worker.ts.
 */

export { VoiceClient, assertOpusEngineAvailable, VOICE_DEPS_INSTALL_HINT } from "./client.js";
export { createPluginDiscordAdapter } from "./discord-adapter.js";
export { WhisperSTTAdapter } from "./stt-whisper.js";
export { WebhookTextChannelRelay, NO_MENTIONS } from "./text-channel-relay.js";
export { DEFAULT_RELAY_USERNAME } from "./types.js";
export type {
  STTAdapter,
  TextChannelRelay,
  UtteranceFinalized,
  VoiceClientConfig,
  VoiceUnavailableReason,
} from "./types.js";
