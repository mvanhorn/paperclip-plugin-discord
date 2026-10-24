import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readLegacyDefault } from "./legacy-scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationRecord {
  escalationId: string;
  companyId: string;
  agentName: string;
  reason: string;
  confidenceScore?: number;
  agentReasoning?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  suggestedReply?: string;
  channelId: string;
  messageId: string;
  status: "pending" | "resolved" | "timed_out";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

// ---------------------------------------------------------------------------
// State helpers — company-aware with backward-compat fallback
// ---------------------------------------------------------------------------

export async function getEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId?: string,
): Promise<EscalationRecord | null> {
  const key = `escalation_${escalationId}`;
  if (escalationCompanyId) {
    const raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
    if (raw) return raw as EscalationRecord;
  }
  // Backward-compat fallback
  const fallback = await readLegacyDefault(ctx, key, escalationCompanyId);
  return (fallback as EscalationRecord) ?? null;
}

export async function saveEscalation(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  const scopeId = record.companyId || "default";
  await ctx.state.set(
    { scopeKind: "company", scopeId, stateKey: `escalation_${record.escalationId}` },
    record,
  );
}

export async function trackPendingEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId: string = "default",
): Promise<void> {
  const key = "escalation_pending_ids";
  let raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
  // Backward-compat fallback for reads
  if (!raw && escalationCompanyId !== "default") {
    raw = await readLegacyDefault(ctx, key, escalationCompanyId);
  }
  const ids = (raw as string[]) ?? [];
  if (!ids.includes(escalationId)) {
    ids.push(escalationId);
    await ctx.state.set(
      { scopeKind: "company", scopeId: escalationCompanyId, stateKey: key },
      ids,
    );
  }
}

export async function untrackPendingEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId: string = "default",
): Promise<void> {
  const key = "escalation_pending_ids";
  let raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
  // Backward-compat fallback for reads
  if (!raw && escalationCompanyId !== "default") {
    raw = await readLegacyDefault(ctx, key, escalationCompanyId);
  }
  const ids = (raw as string[]) ?? [];
  const filtered = ids.filter((id) => id !== escalationId);
  await ctx.state.set(
    { scopeKind: "company", scopeId: escalationCompanyId, stateKey: key },
    filtered,
  );
}

/**
 * Collect pending escalation IDs across both company-scoped and legacy scopes,
 * deduplicating by escalation ID.
 */
export async function collectPendingEscalationIds(
  ctx: PluginContext,
  companyId: string | undefined,
): Promise<string[]> {
  const scopeIds = companyId && companyId !== "default" ? [companyId, "default"] : ["default"];
  const seenIds = new Set<string>();
  const pendingIds: string[] = [];
  for (const sid of scopeIds) {
    const raw = sid === "default"
      ? await readLegacyDefault(ctx, "escalation_pending_ids", companyId)
      : await ctx.state.get({
        scopeKind: "company",
        scopeId: sid,
        stateKey: "escalation_pending_ids",
      });
    for (const id of ((raw as string[]) ?? [])) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        pendingIds.push(id);
      }
    }
  }
  return pendingIds;
}
