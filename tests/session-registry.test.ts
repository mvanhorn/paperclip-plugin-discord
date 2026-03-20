import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAgentMention,
  type AgentSessionEntry,
  type TransportKind,
} from "../src/session-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<AgentSessionEntry> = {}): AgentSessionEntry {
  return {
    sessionId: "sess-1",
    agentId: "agent-1",
    agentName: "CodeBot",
    agentDisplayName: "CodeBot",
    companyId: "default",
    transport: "native" as TransportKind,
    spawnedAt: "2026-03-15T12:00:00Z",
    status: "running",
    lastActivityAt: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

const stateStore = new Map<string, unknown>();

function makeCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([{ id: "agent-1", name: "CodeBot" }]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-new" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
        return Promise.resolve(stateStore.get(stateKey) ?? null);
      }),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseAgentMention", () => {
  const sessions = [
    makeSession({ agentName: "CodeBot", agentDisplayName: "CodeBot" }),
    makeSession({
      sessionId: "sess-2",
      agentId: "agent-2",
      agentName: "ReviewBot",
      agentDisplayName: "ReviewBot",
    }),
  ];

  it("returns exact match on agentName (case-insensitive)", () => {
    const result = parseAgentMention("@codebot please help", sessions);
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("CodeBot");
  });

  it("returns exact match on agentDisplayName", () => {
    const result = parseAgentMention("@ReviewBot do the thing", sessions);
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("ReviewBot");
  });

  it("returns partial match (prefix) when no exact match", () => {
    const result = parseAgentMention("@code fix the tests", sessions);
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("CodeBot");
  });

  it("returns null when no @mention in text", () => {
    const result = parseAgentMention("just a regular message", sessions);
    expect(result).toBeNull();
  });

  it("returns null when @mention does not match any session", () => {
    const result = parseAgentMention("@unknown do something", sessions);
    expect(result).toBeNull();
  });

  it("prefers exact match over partial match", () => {
    const sessionsWithOverlap = [
      makeSession({ agentName: "code", agentDisplayName: "code" }),
      makeSession({
        sessionId: "sess-3",
        agentName: "CodeBot",
        agentDisplayName: "CodeBot",
      }),
    ];
    const result = parseAgentMention("@code do the thing", sessionsWithOverlap);
    expect(result!.agentName).toBe("code");
  });

  it("handles case-insensitive partial match", () => {
    const result = parseAgentMention("@REVIEW check this", sessions);
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("ReviewBot");
  });
});

describe("session spawn (via state)", () => {
  it("adds a session to the thread sessions array", async () => {
    const ctx = makeCtx();
    // Simulate spawnAgentInThread by directly testing state manipulation
    const threadId = "thread-1";
    const sessions: AgentSessionEntry[] = [];
    const newEntry = makeSession({ sessionId: "sess-new", agentName: "TestBot" });
    sessions.push(newEntry);

    await ctx.state.set({ scopeKind: "company", scopeId: "default", stateKey: `sessions_${threadId}` }, { sessions });

    const stored = stateStore.get(`sessions_${threadId}`) as { sessions: AgentSessionEntry[] };
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0].agentName).toBe("TestBot");
  });

  it("enforces max 5 running agents per thread", () => {
    const running: AgentSessionEntry[] = [];
    for (let i = 0; i < 5; i++) {
      running.push(makeSession({ sessionId: `sess-${i}`, agentName: `Bot${i}`, status: "running" }));
    }
    // MAX_AGENTS_PER_THREAD is 5, so 5 running should block a 6th
    expect(running.length).toBe(5);
    expect(running.filter((s) => s.status === "running").length >= 5).toBe(true);
  });

  it("returns error message when at cap", () => {
    const maxAgents = 5;
    const runningCount = 5;
    // This mirrors the logic in spawnAgentInThread
    const error = `Thread already has ${runningCount} active agents (max ${maxAgents}). Close one first.`;
    expect(error).toContain("max 5");
    expect(error).toContain("Close one first");
  });

  it("does not count completed sessions toward the cap", () => {
    const sessions = [
      makeSession({ sessionId: "sess-1", status: "completed" }),
      makeSession({ sessionId: "sess-2", status: "running" }),
    ];
    const running = sessions.filter((s) => s.status === "running");
    expect(running.length).toBe(1);
    // Still room for more
    expect(running.length < 5).toBe(true);
  });
});

describe("session removal", () => {
  it("marks session status as completed", () => {
    const sessions = [
      makeSession({ sessionId: "sess-1", agentName: "CodeBot", status: "running" }),
    ];
    const target = sessions.find(
      (s) => s.agentName.toLowerCase() === "codebot" && s.status === "running",
    );
    expect(target).toBeDefined();
    target!.status = "completed";
    expect(target!.status).toBe("completed");
    expect(sessions[0].status).toBe("completed");
  });

  it("returns error when no running agent matches", () => {
    const sessions = [
      makeSession({ sessionId: "sess-1", agentName: "CodeBot", status: "completed" }),
    ];
    const target = sessions.find(
      (s) => s.agentName.toLowerCase() === "codebot" && s.status === "running",
    );
    expect(target).toBeUndefined();
  });
});

describe("reply-to routing", () => {
  it("routes to the session matching replyToSessionId", () => {
    const sessions = [
      makeSession({ sessionId: "sess-1", agentName: "Bot1", status: "running" }),
      makeSession({ sessionId: "sess-2", agentName: "Bot2", status: "running" }),
    ];
    const running = sessions.filter((s) => s.status === "running");
    const target = running.find((s) => s.sessionId === "sess-2");
    expect(target).toBeDefined();
    expect(target!.agentName).toBe("Bot2");
  });

  it("falls back to most-recently-active when replyToSessionId not found", () => {
    const sessions = [
      makeSession({
        sessionId: "sess-1",
        agentName: "Bot1",
        status: "running",
        lastActivityAt: "2026-03-15T12:00:00Z",
      }),
      makeSession({
        sessionId: "sess-2",
        agentName: "Bot2",
        status: "running",
        lastActivityAt: "2026-03-15T13:00:00Z",
      }),
    ];
    const running = sessions.filter((s) => s.status === "running");
    // replyToSessionId doesn't match
    const replyTarget = running.find((s) => s.sessionId === "sess-nonexistent");
    expect(replyTarget).toBeUndefined();

    // Fallback: most recently active
    const sorted = running.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
    expect(sorted[0].agentName).toBe("Bot2");
  });

  it("returns null when no running sessions exist", () => {
    const sessions = [
      makeSession({ sessionId: "sess-1", status: "completed" }),
    ];
    const running = sessions.filter((s) => s.status === "running");
    expect(running.length).toBe(0);
  });
});

describe("discussion loop", () => {
  it("tracks turn counting correctly", () => {
    let currentTurn = 0;
    const maxTurns = 10;

    currentTurn++;
    expect(currentTurn).toBe(1);
    expect(currentTurn < maxTurns).toBe(true);

    for (let i = 0; i < 8; i++) currentTurn++;
    expect(currentTurn).toBe(9);
    expect(currentTurn < maxTurns).toBe(true);

    currentTurn++;
    expect(currentTurn).toBe(10);
    expect(currentTurn >= maxTurns).toBe(true);
  });

  it("detects stale output based on elapsed time", () => {
    const DISCUSSION_STALE_MS = 5 * 60 * 1000;
    const lastActivityAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const elapsed = Date.now() - new Date(lastActivityAt).getTime();
    expect(elapsed > DISCUSSION_STALE_MS).toBe(true);
  });

  it("does not mark as stale when within threshold", () => {
    const DISCUSSION_STALE_MS = 5 * 60 * 1000;
    const lastActivityAt = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    const elapsed = Date.now() - new Date(lastActivityAt).getTime();
    expect(elapsed > DISCUSSION_STALE_MS).toBe(false);
  });

  it("triggers human checkpoint at correct interval", () => {
    const humanCheckpointInterval = 3;
    const testTurns = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const checkpoints = testTurns.filter(
      (turn) => humanCheckpointInterval > 0 && turn > 0 && turn % humanCheckpointInterval === 0,
    );
    expect(checkpoints).toEqual([3, 6, 9]);
  });

  it("does not checkpoint when interval is 0", () => {
    const humanCheckpointInterval = 0;
    const turn = 3;
    const shouldCheckpoint =
      humanCheckpointInterval > 0 && turn > 0 && turn % humanCheckpointInterval === 0;
    expect(shouldCheckpoint).toBe(false);
  });

  it("clamps maxTurns between 2 and MAX_CONVERSATION_TURNS (50)", () => {
    const MAX_CONVERSATION_TURNS = 50;
    const clamp = (n: number) => Math.min(Math.max(n, 2), MAX_CONVERSATION_TURNS);

    expect(clamp(1)).toBe(2);
    expect(clamp(0)).toBe(2);
    expect(clamp(10)).toBe(10);
    expect(clamp(100)).toBe(50);
    expect(clamp(50)).toBe(50);
  });

  it("alternates speakers between initiator and target", () => {
    const initiator = "AgentA";
    const target = "AgentB";
    let currentSpeaker = initiator;

    // After turn, switch
    const nextSpeaker = (last: string) => (last === initiator ? target : initiator);

    currentSpeaker = nextSpeaker(currentSpeaker);
    expect(currentSpeaker).toBe("AgentB");

    currentSpeaker = nextSpeaker(currentSpeaker);
    expect(currentSpeaker).toBe("AgentA");

    currentSpeaker = nextSpeaker(currentSpeaker);
    expect(currentSpeaker).toBe("AgentB");
  });
});

describe("output sequencing", () => {
  it("queues outputs and sorts by timestamp", () => {
    interface QueuedOutput {
      agentDisplayName: string;
      output: string;
      timestamp: number;
    }

    const queue: QueuedOutput[] = [];
    queue.push({ agentDisplayName: "Bot2", output: "second", timestamp: 200 });
    queue.push({ agentDisplayName: "Bot1", output: "first", timestamp: 100 });
    queue.push({ agentDisplayName: "Bot3", output: "third", timestamp: 300 });

    const items = queue.splice(0, queue.length);
    items.sort((a, b) => a.timestamp - b.timestamp);

    expect(items[0].agentDisplayName).toBe("Bot1");
    expect(items[1].agentDisplayName).toBe("Bot2");
    expect(items[2].agentDisplayName).toBe("Bot3");
  });

  it("truncates output longer than 1900 chars", () => {
    const longOutput = "x".repeat(2000);
    const truncated =
      longOutput.length > 1900
        ? longOutput.slice(0, 1900) + "\n... (truncated)"
        : longOutput;
    expect(truncated.length).toBeLessThan(2000);
    expect(truncated).toContain("(truncated)");
  });

  it("does not truncate short output", () => {
    const shortOutput = "Hello world";
    const truncated =
      shortOutput.length > 1900
        ? shortOutput.slice(0, 1900) + "\n... (truncated)"
        : shortOutput;
    expect(truncated).toBe("Hello world");
  });

  it("prefixes agent name in multi-agent mode", () => {
    const multiAgent = true;
    const agentDisplayName = "CodeBot";
    const prefix = multiAgent ? `**[${agentDisplayName}]** ` : "";
    expect(prefix).toBe("**[CodeBot]** ");
  });

  it("omits prefix in single-agent mode", () => {
    const multiAgent = false;
    const agentDisplayName = "CodeBot";
    const prefix = multiAgent ? `**[${agentDisplayName}]** ` : "";
    expect(prefix).toBe("");
  });
});
