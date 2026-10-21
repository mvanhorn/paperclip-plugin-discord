import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reportPluginError } from "./error-reporting.js";

/** Mirrors `PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED`; pinned by tests/legacy-state-errors.test.ts. */
export const INVOCATION_SCOPE_DENIED_CODE = -32005;

/** Mirrors the message `InvocationScopeDeniedError` builds in the SDK's host client. */
const INVOCATION_SCOPE_DENIED_MESSAGE = / is not allowed to perform "/;

/** True only for the host refusing a cross-company scope. */
export function isInvocationScopeDenied(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "InvocationScopeDeniedError") return true;
  if (candidate.code === INVOCATION_SCOPE_DENIED_CODE) return true;
  return (
    typeof candidate.message === "string" &&
    INVOCATION_SCOPE_DENIED_MESSAGE.test(candidate.message)
  );
}

/** Read state written under the legacy literal company scope `"default"`; null when refused, throws otherwise. */
export async function readLegacyDefaultScopeState(
  ctx: PluginContext,
  stateKey: string,
): Promise<unknown> {
  try {
    return await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey });
  } catch (err) {
    if (!isInvocationScopeDenied(err)) throw err;
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
