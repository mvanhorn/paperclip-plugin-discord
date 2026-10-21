import { describe, it, expect, vi, beforeEach } from "vitest";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  readLegacyDefaultScopeState,
  isInvocationScopeDenied,
  INVOCATION_SCOPE_DENIED_CODE,
} from "../src/legacy-state.js";
import {
  getThreadSessions,
  spawnAgentInThread,
  closeAgentInThread,
  routeMessageToAgent,
  handleAcpOutput,
  handleHandoffButton,
  handleDiscussionButton,
} from "../src/session-registry.js";
import { getEscalation, untrackPendingEscalation } from "../src/escalation-state.js";
import { setPluginErrorSink, resetPluginErrorReports } from "../src/error-reporting.js";

const COMPANY_ID = "44806279-f8ba-4f28-a9c3-54ceeea43416";
const THREAD_ID = "thread-1";

/** The SDK's `InvocationScopeDeniedError` as it reaches the worker: a JsonRpcCallError carrying its code. */
function scopeDenied(method = "state.get"): Error {
  const err = new Error(
    `Plugin "paperclip-plugin-discord" is not allowed to perform "${method}": ` +
      `requested company "default" but the current invocation is scoped to company "${COMPANY_ID}"`,
  );
  (err as Error & { code: number }).code = INVOCATION_SCOPE_DENIED_CODE;
  err.name = "JsonRpcCallError";
  return err;
}

/** A read that failed for any other reason — a dropped RPC, a timeout, a bad host. */
function transientFailure(): Error {
  const err = new Error('Worker→host call "state.get" timed out after 30000ms');
  (err as Error & { code: number }).code = PLUGIN_RPC_ERROR_CODES.TIMEOUT;
  err.name = "JsonRpcCallError";
  return err;
}

/**
 * A host where the company-scoped read answers null and the legacy `"default"`
 * read fails with `legacyError`.
 */
function makeCtx(legacyError: Error) {
  const stateSet = vi.fn(async () => {});
  const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async (key: { scopeId?: string }) => {
        if (key.scopeId === "default") throw legacyError;
        return null;
      }),
      set: stateSet,
    },
    agents: {
      list: vi.fn(async () => [{ id: "agent-1", name: "Backend" }]),
      sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
      invoke: vi.fn(),
    },
    events: { emit: vi.fn() },
    metrics: { write: vi.fn() },
    http: {
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ id: "msg-1" }), text: async () => "" })),
    },
  } as unknown as PluginContext;
  return { ctx, stateSet };
}

beforeEach(() => {
  setPluginErrorSink(null);
  resetPluginErrorReports();
});

describe("isInvocationScopeDenied", () => {
  it("mirrors the SDK's INVOCATION_SCOPE_DENIED code", () => {
    expect(INVOCATION_SCOPE_DENIED_CODE).toBe(PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED);
  });

  it("accepts the code the bridge propagates", () => {
    expect(isInvocationScopeDenied(scopeDenied())).toBe(true);
  });

  it("accepts the error class name, for an in-process host", () => {
    const err = new Error("denied");
    err.name = "InvocationScopeDeniedError";
    expect(isInvocationScopeDenied(err)).toBe(true);
  });

  it("accepts the message alone, for a host that re-wraps the error", () => {
    expect(
      isInvocationScopeDenied(
        new Error('Plugin "p" is not allowed to perform "state.get": company context is required'),
      ),
    ).toBe(true);
  });

  it("rejects a timeout, a capability denial and a bare failure", () => {
    expect(isInvocationScopeDenied(transientFailure())).toBe(false);
    expect(
      isInvocationScopeDenied(
        new Error('Plugin "p" is missing required capability "plugin.state.read" for method "state.get"'),
      ),
    ).toBe(false);
    expect(isInvocationScopeDenied(new Error("socket hang up"))).toBe(false);
    expect(isInvocationScopeDenied(null)).toBe(false);
    expect(isInvocationScopeDenied("denied")).toBe(false);
  });
});

describe("readLegacyDefaultScopeState", () => {
  it("treats a scope refusal as absent", async () => {
    const { ctx } = makeCtx(scopeDenied());
    await expect(readLegacyDefaultScopeState(ctx, "sessions_thread-1")).resolves.toBeNull();
  });

  it("throws every other read failure rather than reporting it as absent", async () => {
    const { ctx } = makeCtx(transientFailure());
    await expect(readLegacyDefaultScopeState(ctx, "sessions_thread-1")).rejects.toThrow("timed out");
  });
});

describe("a thread's session list that cannot be read", () => {
  it("propagates out of getThreadSessions instead of looking empty", async () => {
    const { ctx } = makeCtx(transientFailure());
    await expect(getThreadSessions(ctx, THREAD_ID, COMPANY_ID)).rejects.toThrow("timed out");
  });

  it("stops a spawn instead of duplicating an agent that may already be running", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());

    const result = await spawnAgentInThread(ctx, "bot-token", THREAD_ID, "Backend", COMPANY_ID, "do the thing");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Backend");
    expect((ctx.agents.sessions as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
    expect(stateSet).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("still spawns when the legacy scope is merely refused", async () => {
    const { ctx } = makeCtx(scopeDenied());
    const create = vi.fn(async () => ({ sessionId: "sess-1" }));
    (ctx.agents.sessions as unknown as { create: typeof create }).create = create;
    (ctx.agents.sessions as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage =
      vi.fn(async () => {});

    const result = await spawnAgentInThread(ctx, "bot-token", THREAD_ID, "Backend", COMPANY_ID, "do the thing");

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalled();
  });

  it("stops a close instead of reporting the agent missing", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());

    const result = await closeAgentInThread(ctx, "bot-token", THREAD_ID, "Backend", COMPANY_ID);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("No running agent");
    expect(stateSet).not.toHaveBeenCalled();
  });

  it("leaves an inbound message unrouted", async () => {
    const { ctx } = makeCtx(transientFailure());

    await expect(routeMessageToAgent(ctx, THREAD_ID, "hello", COMPANY_ID)).resolves.toBe(false);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("relays ACP output without overwriting the session list", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());

    await handleAcpOutput(ctx, "bot-token", {
      sessionId: "acp-1",
      threadId: THREAD_ID,
      agentName: "Backend",
      output: "progress",
      companyId: COMPANY_ID,
    });

    expect(stateSet).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("button handlers answer instead of crashing on an unreadable record", () => {
  it("handoff", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());
    const response = (await handleHandoffButton(ctx, "bot-token", "handoff_approve_h-1", "boss")) as {
      data: { content: string };
    };
    expect(response.data.content).toContain("Could not read handoff");
    expect(stateSet).not.toHaveBeenCalled();
  });

  it("discussion", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());
    const response = (await handleDiscussionButton(ctx, "bot-token", "disc_continue_d-1", "boss")) as {
      data: { content: string };
    };
    expect(response.data.content).toContain("Could not read discussion");
    expect(stateSet).not.toHaveBeenCalled();
  });
});

describe("escalation state", () => {
  it("propagates an unreadable record rather than reporting it missing", async () => {
    const { ctx } = makeCtx(transientFailure());
    await expect(getEscalation(ctx, "esc_1", COMPANY_ID)).rejects.toThrow("timed out");
  });

  it("does not wipe the pending list when the legacy read fails", async () => {
    const { ctx, stateSet } = makeCtx(transientFailure());
    await expect(untrackPendingEscalation(ctx, "esc_1", COMPANY_ID)).rejects.toThrow("timed out");
    expect(stateSet).not.toHaveBeenCalled();
  });
});
