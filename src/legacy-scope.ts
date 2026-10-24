import type { PluginContext } from "@paperclipai/plugin-sdk";

// Set once the host refuses a fallback read, so later fallbacks skip the call
// instead of logging another refusal on the host.
let fallbackRefused = false;

/** For tests: forget a previous refusal. */
export function resetLegacyDefaultRefusal(): void {
  fallbackRefused = false;
}

/**
 * Read a key from the legacy "default" scope, which predates company scoping.
 *
 * When a real company was already checked, this is only a fallback. Newer
 * Paperclip hosts refuse state access for a scope that is not a real company,
 * so a refused fallback read means there is no legacy data to return, and
 * later fallback reads are skipped. Other errors propagate, as they do when
 * there is no company and "default" is the primary scope.
 */
export async function readLegacyDefault(
  ctx: PluginContext,
  stateKey: string,
  checkedCompanyId?: string,
): Promise<unknown> {
  const read = () => ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey });
  if (!checkedCompanyId || checkedCompanyId === "default") return read();
  if (fallbackRefused) return null;
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && /is not allowed to perform/.test(error.message)) {
      fallbackRefused = true;
      return null;
    }
    // Any other failure may hide real legacy data, so callers must not treat
    // it as an empty result.
    throw error;
  }
}
