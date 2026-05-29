/**
 * Bridge between paperclip-plugin-discord's gateway primitives and
 * @discordjs/voice's expected DiscordGatewayAdapter interface.
 *
 * @discordjs/voice doesn't ship with a built-in gateway — every consumer
 * has to provide an adapter that knows how to (a) send op-4 voice-state
 * updates and (b) deliver VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE events.
 * Our `gateway.ts` exposes exactly those primitives via the `voice` handle
 * (introduced in Phase 1 Task 1.5).
 *
 * See ../../../docs/superpowers/research/2026-05-28-plugin-sdk-voice-feasibility.md
 * (in the MRTek repo) for the architecture rationale.
 *
 * Known Phase 1 limitation: handlers registered via gatewayVoice.onVoice*Update
 * cannot currently be removed (gateway handler list is append-only). For Phase 1
 * the bot joins one voice channel for the plugin's lifetime, so this doesn't
 * leak. If we add reconnect/rejoin semantics in later phases, add a remove-handler
 * primitive to gateway.ts and call it from destroy() below.
 */

import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

import type { GatewayVoiceHandle } from "../gateway.js";

// @discordjs/voice declares its dispatch-data types internally (via discord-api-types)
// but doesn't re-export them. We use Parameters<typeof methods.onVoice*Update>[0]
// to read them off the function signatures we pass to — this keeps the cast
// honest without importing an internal type.
export function createPluginDiscordAdapter(
  gatewayVoice: GatewayVoiceHandle,
): DiscordGatewayAdapterCreator {
  return (methods) => {
    type StateData = Parameters<typeof methods.onVoiceStateUpdate>[0];
    type ServerData = Parameters<typeof methods.onVoiceServerUpdate>[0];

    gatewayVoice.onVoiceStateUpdate((event) => {
      methods.onVoiceStateUpdate(event as unknown as StateData);
    });
    gatewayVoice.onVoiceServerUpdate((event) => {
      methods.onVoiceServerUpdate(event as unknown as ServerData);
    });

    return {
      sendPayload(payload) {
        return gatewayVoice.sendPayload(payload);
      },
      destroy() {
        // No-op: handler list is append-only in gateway.ts today.
        // See file header note.
      },
    };
  };
}
