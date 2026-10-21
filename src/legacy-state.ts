import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reportPluginError } from "./error-reporting.js";

/** Read state written under the legacy literal company scope `"default"`, treating a refused read as absent. */
export async function readLegacyDefaultScopeState(
  ctx: PluginContext,
  stateKey: string,
): Promise<unknown> {
  try {
    return await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.logger.debug("Legacy 'default'-scope state read was refused", { stateKey, error: detail });
    await reportPluginError(ctx, {
      source: "legacy-state",
      summary: `Legacy "default"-scope state read was refused for \`${stateKey}\`; treated as absent.`,
      detail,
      dedupKey: `legacy-state:${stateKey}`,
    });
    return null;
  }
}
