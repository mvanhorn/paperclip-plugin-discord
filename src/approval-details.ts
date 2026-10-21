import type { PluginContext } from "@paperclipai/plugin-sdk";
import { paperclipFetch } from "./paperclip-fetch.js";

/** Read the approval row behind an `approval.created` event, returning null on any failure. */
const APPROVAL_LOOKUP_TIMEOUT_MS = 5_000;

export interface ApprovalRecord {
  id: string;
  type?: string | null;
  status?: string | null;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The slice of `PluginApprovalsClient` this module uses, when the host exposes it. */
interface ApprovalsClientLike {
  get?: (approvalId: string, companyId: string) => Promise<unknown>;
}

function toRecord(value: unknown): ApprovalRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  return {
    id,
    type: typeof row.type === "string" ? row.type : null,
    status: typeof row.status === "string" ? row.status : null,
    requestedByAgentId: typeof row.requestedByAgentId === "string" ? row.requestedByAgentId : null,
    requestedByUserId: typeof row.requestedByUserId === "string" ? row.requestedByUserId : null,
    payload:
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null,
  };
}

export async function fetchApprovalRecord(
  ctx: PluginContext,
  approvalId: string,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<ApprovalRecord | null> {
  if (!approvalId) return null;

  const approvals = (ctx as unknown as { approvals?: ApprovalsClientLike }).approvals;
  if (companyId && typeof approvals?.get === "function") {
    try {
      const record = toRecord(await approvals.get(approvalId, companyId));
      if (record) return record;
    } catch (err) {
      ctx.logger.debug("Approval unavailable via ctx.approvals.get; trying the API", {
        approvalId,
        error: String(err),
      });
    }
  }

  const api = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!api) return null;

  try {
    const response = await paperclipFetch(
      `${api}/api/approvals/${encodeURIComponent(approvalId)}`,
      { method: "GET", signal: AbortSignal.timeout(APPROVAL_LOOKUP_TIMEOUT_MS) },
      apiKey || undefined,
    );
    return toRecord(await response.json());
  } catch (err) {
    ctx.logger.warn("Failed to read the approval behind approval.created; the card will show less detail", {
      approvalId,
      error: String(err),
    });
    return null;
  }
}
