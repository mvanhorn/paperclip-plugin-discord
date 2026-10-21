import type { PluginContext } from "@paperclipai/plugin-sdk";
import { paperclipFetch } from "./paperclip-fetch.js";

const PREFIX_LOOKUP_TIMEOUT_MS = 5_000;

const cachedPrefixes = new Map<string, string>();

function normalizePrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolve a company's issue prefix for deep links; null when unavailable. */
export async function resolveCompanyIssuePrefix(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<string | null> {
  if (!companyId || companyId === "default") return null;

  const cached = cachedPrefixes.get(companyId);
  if (cached) return cached;

  try {
    const company = await ctx.companies.get(companyId);
    const prefix = normalizePrefix(company?.issuePrefix);
    if (prefix) {
      cachedPrefixes.set(companyId, prefix);
      return prefix;
    }
  } catch (err) {
    ctx.logger.debug("Company issue prefix unavailable via ctx.companies.get; trying the API", {
      companyId,
      error: String(err),
    });
  }

  const api = baseUrl.trim().replace(/\/+$/, "");
  try {
    const response = await paperclipFetch(
      `${api}/api/companies/${encodeURIComponent(companyId)}`,
      { method: "GET", signal: AbortSignal.timeout(PREFIX_LOOKUP_TIMEOUT_MS) },
      apiKey || undefined,
    );
    const body = (await response.json()) as Record<string, unknown> | null;
    const prefix = normalizePrefix(body?.issuePrefix);
    if (prefix) {
      cachedPrefixes.set(companyId, prefix);
      return prefix;
    }
    ctx.logger.warn("Company response carried no issuePrefix; dashboard links will omit the company prefix", {
      companyId,
    });
  } catch (err) {
    ctx.logger.warn("Failed to resolve the company issue prefix; dashboard links will omit it", {
      companyId,
      error: String(err),
    });
  }

  return null;
}

/** Reset cached issue prefixes (for testing). */
export function _resetCompanyPrefixCache(): void {
  cachedPrefixes.clear();
}
