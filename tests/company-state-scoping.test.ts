import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getThreadSessions,
  handleAcpOutput,
  type AgentSessionEntry,
  type TransportKind,
} from "../src/session-registry.js";
import {
  type EscalationRecord,
  getEscalation,
  saveEscalation,
  trackPendingEscalation,
  untrackPendingEscalation,
  collectPendingEscalationIds,
} from "../src/escalation-state.js";
import { resetLegacyDefaultRefusal } from "../src/legacy-scope.js";

// ---------------------------------------------------------------------------
// Scope-aware state mock
// ---------------------------------------------------------------------------

/** Keys like "company:comp-1:sessions_thread-1" */
function scopedKey(scopeId: string, stateKey: string): string {
  return `company:${scopeId}:${stateKey}`;
}

const stateStore = new Map<string, unknown>();

function makeScopedCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-new" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ scopeId, stateKey }: { scopeId: string; stateKey: string }) => {
        return Promise.resolve(stateStore.get(scopedKey(scopeId, stateKey)) ?? null);
      }),
      set: vi.fn().mockImplementation(({ scopeId, stateKey }: { scopeId: string; stateKey: string }, value: unknown) => {
        if (value === null) {
          stateStore.delete(scopedKey(scopeId, stateKey));
        } else {
          stateStore.set(scopedKey(scopeId, stateKey), value);
        }
        return Promise.resolve(undefined);
      }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "thread-1" }),
        text: () => Promise.resolve(""),
      }),
    },
    events: { emit: vi.fn(), on: vi.fn() },
    ...overrides,
  } as any;
}

function makeSession(overrides: Partial<AgentSessionEntry> = {}): AgentSessionEntry {
  return {
    sessionId: "sess-1",
    agentId: "agent-1",
    agentName: "CodeBot",
    agentDisplayName: "CodeBot",
    companyId: "comp-1",
    transport: "native" as TransportKind,
    spawnedAt: "2026-03-15T12:00:00Z",
    status: "running",
    lastActivityAt: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    escalationId: "esc-1",
    companyId: "comp-1",
    agentName: "SupportBot",
    reason: "Customer needs human help",
    channelId: "ch-1",
    messageId: "msg-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: company-aware state scoping
// ---------------------------------------------------------------------------

describe("company-aware state scoping", () => {
  let ctx: ReturnType<typeof makeScopedCtx>;

  beforeEach(() => {
    ctx = makeScopedCtx();
  });

  describe("getThreadSessions", () => {
    it("reads from company-scoped key when companyId is provided", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession()];
      stateStore.set(scopedKey("comp-1", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe("CodeBot");
    });

    it("falls back to 'default' scope when company-scoped read returns null", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession({ companyId: "default" })];
      // Only stored under "default" scope (legacy data)
      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].companyId).toBe("default");
    });

    it("returns empty array when neither scope has data", async () => {
      const result = await getThreadSessions(ctx, "thread-nonexistent", "comp-1");
      expect(result).toEqual([]);
    });

    it("reads from 'default' scope when companyId is omitted", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession({ companyId: "default" })];
      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId);
      expect(result).toHaveLength(1);
    });

    it("prefers company-scoped data over legacy default-scoped data", async () => {
      const threadId = "thread-1";
      const legacySessions = [makeSession({ companyId: "default", agentName: "LegacyBot" })];
      const companySessions = [makeSession({ companyId: "comp-1", agentName: "NewBot" })];

      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions: legacySessions });
      stateStore.set(scopedKey("comp-1", `sessions_${threadId}`), { sessions: companySessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe("NewBot");
    });
  });

  describe("handleAcpOutput with companyId", () => {
    it("writes session state under company scope when companyId is provided", async () => {
      const event = {
        sessionId: "sess-acp-1",
        threadId: "thread-1",
        agentName: "AcpBot",
        output: "Hello",
        companyId: "comp-1",
      };

      await handleAcpOutput(ctx, "bot-token", event);

      // Should have written under company scope
      const stored = stateStore.get(scopedKey("comp-1", "sessions_thread-1")) as { sessions: AgentSessionEntry[] };
      expect(stored).toBeDefined();
      expect(stored.sessions).toHaveLength(1);
      expect(stored.sessions[0].agentName).toBe("AcpBot");
      expect(stored.sessions[0].companyId).toBe("comp-1");
    });

    it("uses 'default' scope when companyId is not provided", async () => {
      const event = {
        sessionId: "sess-acp-2",
        threadId: "thread-2",
        agentName: "AcpBot",
        output: "Hello",
      };

      await handleAcpOutput(ctx, "bot-token", event);

      const stored = stateStore.get(scopedKey("default", "sessions_thread-2")) as { sessions: AgentSessionEntry[] };
      expect(stored).toBeDefined();
      expect(stored.sessions).toHaveLength(1);
      expect(stored.sessions[0].companyId).toBe("default");
    });
  });

  describe("multi-company isolation", () => {
    it("keeps sessions from different companies separate", async () => {
      const threadId = "shared-thread";
      const sessionsA = [makeSession({ sessionId: "sess-a", companyId: "company-a", agentName: "BotA" })];
      const sessionsB = [makeSession({ sessionId: "sess-b", companyId: "company-b", agentName: "BotB" })];

      stateStore.set(scopedKey("company-a", `sessions_${threadId}`), { sessions: sessionsA });
      stateStore.set(scopedKey("company-b", `sessions_${threadId}`), { sessions: sessionsB });

      const resultA = await getThreadSessions(ctx, threadId, "company-a");
      const resultB = await getThreadSessions(ctx, threadId, "company-b");

      expect(resultA).toHaveLength(1);
      expect(resultA[0].agentName).toBe("BotA");
      expect(resultB).toHaveLength(1);
      expect(resultB[0].agentName).toBe("BotB");
    });
  });

  // =========================================================================
  // Escalation state scoping
  // =========================================================================

  describe("getEscalation", () => {
    it("reads from company-scoped key when companyId is provided", async () => {
      const record = makeEscalation();
      stateStore.set(scopedKey("comp-1", "escalation_esc-1"), record);

      const result = await getEscalation(ctx, "esc-1", "comp-1");
      expect(result).toEqual(record);
    });

    it("falls back to 'default' scope when company-scoped read returns null", async () => {
      const record = makeEscalation({ companyId: "default" });
      stateStore.set(scopedKey("default", "escalation_esc-1"), record);

      const result = await getEscalation(ctx, "esc-1", "comp-1");
      expect(result).toEqual(record);
      expect(result!.companyId).toBe("default");
    });

    it("returns null when neither scope has data", async () => {
      const result = await getEscalation(ctx, "esc-nonexistent", "comp-1");
      expect(result).toBeNull();
    });

    it("reads from 'default' scope when companyId is omitted", async () => {
      const record = makeEscalation({ companyId: "default" });
      stateStore.set(scopedKey("default", "escalation_esc-1"), record);

      const result = await getEscalation(ctx, "esc-1");
      expect(result).toEqual(record);
    });

    it("prefers company-scoped data over legacy default-scoped data", async () => {
      const legacyRecord = makeEscalation({ companyId: "default", agentName: "OldBot" });
      const companyRecord = makeEscalation({ companyId: "comp-1", agentName: "NewBot" });

      stateStore.set(scopedKey("default", "escalation_esc-1"), legacyRecord);
      stateStore.set(scopedKey("comp-1", "escalation_esc-1"), companyRecord);

      const result = await getEscalation(ctx, "esc-1", "comp-1");
      expect(result!.agentName).toBe("NewBot");
    });
  });

  describe("saveEscalation", () => {
    it("writes under company scope when companyId is present", async () => {
      const record = makeEscalation({ companyId: "comp-1" });

      await saveEscalation(ctx, record);

      const stored = stateStore.get(scopedKey("comp-1", "escalation_esc-1"));
      expect(stored).toEqual(record);
      // Should NOT exist under "default" scope
      expect(stateStore.get(scopedKey("default", "escalation_esc-1"))).toBeUndefined();
    });

    it("writes under 'default' scope when companyId is empty", async () => {
      const record = makeEscalation({ companyId: "" });

      await saveEscalation(ctx, record);

      const stored = stateStore.get(scopedKey("default", "escalation_esc-1"));
      expect(stored).toEqual(record);
    });
  });

  describe("trackPendingEscalation", () => {
    it("adds escalation id to company-scoped pending list", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("does not duplicate escalation ids", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");
      await trackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("appends to existing pending list", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");
      await trackPendingEscalation(ctx, "esc-2", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1", "esc-2"]);
    });

    it("falls back to legacy list on first track for a company", async () => {
      // Legacy data exists under "default" scope
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-legacy"]);

      await trackPendingEscalation(ctx, "esc-new", "comp-1");

      // Should have read legacy list and written to company scope
      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-legacy", "esc-new"]);
    });

    it("defaults to 'default' scope when companyId is omitted", async () => {
      await trackPendingEscalation(ctx, "esc-1");

      const stored = stateStore.get(scopedKey("default", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });
  });

  describe("untrackPendingEscalation", () => {
    it("removes escalation id from company-scoped pending list", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1", "esc-2"]);

      await untrackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-2"]);
    });

    it("handles removal of non-existent id gracefully", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1"]);

      await untrackPendingEscalation(ctx, "esc-nonexistent", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("falls back to legacy list when company scope is empty", async () => {
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-1", "esc-2"]);

      await untrackPendingEscalation(ctx, "esc-1", "comp-1");

      // Should have read from default, filtered, and written to company scope
      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-2"]);
    });
  });

  describe("collectPendingEscalationIds", () => {
    it("collects from company scope only when no legacy data", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1", "esc-2"]);

      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual(["esc-1", "esc-2"]);
    });

    it("merges company-scoped and legacy pending ids", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1"]);
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-2"]);

      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual(["esc-1", "esc-2"]);
    });

    it("deduplicates ids that appear in both scopes", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1", "esc-2"]);
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-2", "esc-3"]);

      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual(["esc-1", "esc-2", "esc-3"]);
    });

    it("returns only legacy ids when companyId is undefined", async () => {
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-1"]);

      const ids = await collectPendingEscalationIds(ctx, undefined);
      expect(ids).toEqual(["esc-1"]);
    });

    it("returns only legacy ids when companyId is 'default'", async () => {
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-1"]);

      const ids = await collectPendingEscalationIds(ctx, "default");
      expect(ids).toEqual(["esc-1"]);
    });

    it("returns empty array when no pending ids exist", async () => {
      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual([]);
    });
  });

  describe("escalation multi-company isolation", () => {
    it("keeps escalation records from different companies separate", async () => {
      const recordA = makeEscalation({ escalationId: "esc-a", companyId: "company-a", agentName: "BotA" });
      const recordB = makeEscalation({ escalationId: "esc-b", companyId: "company-b", agentName: "BotB" });

      await saveEscalation(ctx, recordA);
      await saveEscalation(ctx, recordB);

      const resultA = await getEscalation(ctx, "esc-a", "company-a");
      const resultB = await getEscalation(ctx, "esc-b", "company-b");

      expect(resultA!.agentName).toBe("BotA");
      expect(resultB!.agentName).toBe("BotB");

      // Cross-company reads should not find the other company's records
      const crossRead = await getEscalation(ctx, "esc-a", "company-b");
      expect(crossRead).toBeNull();
    });

    it("keeps pending lists from different companies separate", async () => {
      await trackPendingEscalation(ctx, "esc-a", "company-a");
      await trackPendingEscalation(ctx, "esc-b", "company-b");

      const idsA = stateStore.get(scopedKey("company-a", "escalation_pending_ids")) as string[];
      const idsB = stateStore.get(scopedKey("company-b", "escalation_pending_ids")) as string[];

      expect(idsA).toEqual(["esc-a"]);
      expect(idsB).toEqual(["esc-b"]);
    });
  });

  // Newer Paperclip hosts refuse state reads for a scope that is not a real
  // company, so the legacy "default" fallback throws instead of returning null.
  describe("when the host refuses the legacy 'default' scope", () => {
    let ctx: ReturnType<typeof makeScopedCtx>;

    beforeEach(() => {
      resetLegacyDefaultRefusal();
      ctx = makeScopedCtx();
      const allowed = ctx.state.get.getMockImplementation()!;
      ctx.state.get.mockImplementation((key: { scopeId: string; stateKey: string }) => {
        if (key.scopeId === "default") {
          return Promise.reject(new Error(
            'Plugin "p" is not allowed to perform "state.get": company context is required',
          ));
        }
        return allowed(key);
      });
    });

    it("collectPendingEscalationIds returns the company's ids", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1"]);
      await expect(collectPendingEscalationIds(ctx as any, "comp-1")).resolves.toEqual(["esc-1"]);
    });

    it("getEscalation returns null for an unknown company record", async () => {
      await expect(getEscalation(ctx as any, "esc-missing", "comp-1")).resolves.toBeNull();
    });

    it("getEscalation still returns the company record", async () => {
      const record = makeEscalation();
      stateStore.set(scopedKey("comp-1", "escalation_esc-1"), record);
      await expect(getEscalation(ctx as any, "esc-1", "comp-1")).resolves.toEqual(record);
    });

    it("trackPendingEscalation starts a new company list", async () => {
      await trackPendingEscalation(ctx as any, "esc-1", "comp-1");
      expect(stateStore.get(scopedKey("comp-1", "escalation_pending_ids"))).toEqual(["esc-1"]);
    });

    it("getThreadSessions returns no sessions for a thread without company data", async () => {
      await expect(getThreadSessions(ctx as any, "thread-x", "comp-1")).resolves.toEqual([]);
    });

    it("asks the host for the legacy scope only once after a refusal", async () => {
      await collectPendingEscalationIds(ctx as any, "comp-1");
      await collectPendingEscalationIds(ctx as any, "comp-1");
      const defaultReads = ctx.state.get.mock.calls.filter(([key]: [{ scopeId: string }]) => key.scopeId === "default");
      expect(defaultReads).toHaveLength(1);
    });

    it("propagates a legacy read failure that is not a refusal", async () => {
      ctx.state.get.mockImplementation((key: { scopeId: string; stateKey: string }) =>
        key.scopeId === "default"
          ? Promise.reject(new Error("worker RPC timed out"))
          : Promise.resolve(stateStore.get(scopedKey(key.scopeId, key.stateKey)) ?? null));
      await expect(getThreadSessions(ctx as any, "thread-x", "comp-1")).rejects.toThrow(/timed out/);
    });

    it("getThreadSessions still propagates the refusal without a company", async () => {
      await expect(getThreadSessions(ctx as any, "thread-x")).rejects.toThrow(/not allowed/);
    });

    it("untrackPendingEscalation works on an empty company list", async () => {
      await untrackPendingEscalation(ctx as any, "esc-1", "comp-1");
      expect(stateStore.get(scopedKey("comp-1", "escalation_pending_ids"))).toEqual([]);
    });
  });
});
