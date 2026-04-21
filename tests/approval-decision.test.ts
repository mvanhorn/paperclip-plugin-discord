import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Regression tests for approval.approved / approval.rejected event handling.
//
// Before the fix:
//   - PLUGIN_EVENT_TYPES only contained "approval.decided" (never emitted)
//   - Discord plugin only subscribed to "approval.created" — no handler for
//     decision events, so Discord messages kept showing active Approve/Reject
//     buttons after a decision was made
//
// After the fix:
//   - approval.created stores a reverse mapping approval_{id} → {channelId, messageId}
//   - approval.approved edits the original message to show ✅ Approved
//   - approval.rejected edits the original message to show ❌ Rejected
// ---------------------------------------------------------------------------

const { capturedSetups } = vi.hoisted(() => {
  const capturedSetups: Array<(ctx: any) => Promise<void>> = [];
  return { capturedSetups };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedSetups.push(def.setup);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  let messageCounter = 0;
  const stateStore = new Map<string, unknown>();
  const editedMessages: Array<{ channelId: string; messageId: string; body: any }> = [];

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: "fake-secret-ref",
    defaultGuildId: "",
    defaultChannelId: "ch-approvals",
    approvalsChannelId: "ch-approvals",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: false,
    notifyOnIssueDone: false,
    notifyOnApprovalCreated: true,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "http://localhost:3100",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: false,
    escalationTimeoutMinutes: 30,
    maxAgentsPerThread: 5,
    enableMediaPipeline: false,
    mediaChannelIds: [],
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    proactiveScanIntervalMinutes: 15,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    dailyDigestTime: "09:00",
    bidailySecondTime: "17:00",
    tridailyTimes: "07:00,13:00,19:00",
    ...configOverrides,
  };

  const mockDiscordFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
    if (typeof url === "string" && url.includes("/messages/") && opts?.method === "PATCH") {
      // editMessage call
      const parts = url.split("/");
      const msgIdx = parts.indexOf("messages");
      const messageId = parts[msgIdx + 1];
      const channelIdx = parts.indexOf("channels");
      const channelId = parts[channelIdx + 1];
      editedMessages.push({ channelId, messageId, body: JSON.parse(opts.body) });
    }
    return {
      ok: true,
      json: async () => ({ id: `msg-${++messageCounter}` }),
      text: async () => "",
    };
  });

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(defaultConfig) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockImplementation(async (key: { scopeKind: string; scopeId?: string; stateKey: string }) => {
        const id = `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;
        return stateStore.get(id) ?? null;
      }),
      set: vi.fn().mockImplementation(async (key: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) => {
        const id = `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;
        stateStore.set(id, value);
      }),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn().mockImplementation((name: string, fn: (event: any) => Promise<void>) => {
        const handlers = eventHandlers.get(name) || [];
        handlers.push(fn);
        eventHandlers.set(name, handlers);
        return () => {};
      }),
    },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, editedMessages, stateStore };
}

async function emitEvent(
  eventHandlers: Map<string, Array<(event: any) => Promise<void>>>,
  eventType: string,
  event: any,
) {
  const handlers = eventHandlers.get(eventType) || [];
  for (const handler of handlers) {
    await handler(event);
  }
}

function makeApprovalEvent(
  eventType: string,
  approvalId: string,
  opts: { actorId?: string; eventId?: string } = {},
): any {
  return {
    eventId: opts.eventId ?? `evt-${Math.random()}`,
    eventType,
    occurredAt: new Date().toISOString(),
    companyId: "company-1",
    entityId: approvalId,
    entityType: "approval",
    actorId: opts.actorId,
    payload: { type: "request_board_approval", approvalId },
  };
}

describe("approval decision event handling", () => {
  it("stores reverse mapping when approval.created is posted", async () => {
    const { ctx, eventHandlers, stateStore } = buildPluginContext();
    await getSetup()(ctx);

    await emitEvent(eventHandlers, "approval.created", makeApprovalEvent("approval.created", "approval-123", { eventId: "evt-create-1" }));

    const stateKey = "instance::approval_approval-123";
    const stored = stateStore.get(stateKey) as { channelId: string; messageId: string } | undefined;
    expect(stored).toBeDefined();
    expect(stored?.channelId).toBe("ch-approvals");
    // messageId is whatever Discord assigned — just verify it's a non-empty string
    expect(stored?.messageId).toMatch(/^msg-\d+$/);
  });

  it("edits the original message with green embed when approval.approved fires", async () => {
    const { ctx, eventHandlers, editedMessages, stateStore } = buildPluginContext();
    await getSetup()(ctx);

    // Post the approval message first
    await emitEvent(eventHandlers, "approval.created", makeApprovalEvent("approval.created", "approval-456", { eventId: "evt-create-2" }));

    const stored = stateStore.get("instance::approval_approval-456") as { channelId: string; messageId: string };
    expect(stored).toBeDefined();

    // Fire decision event
    await emitEvent(eventHandlers, "approval.approved", makeApprovalEvent("approval.approved", "approval-456", { actorId: "user-board" }));

    expect(editedMessages).toHaveLength(1);
    const edit = editedMessages[0];
    expect(edit.channelId).toBe("ch-approvals");
    expect(edit.messageId).toBe(stored.messageId);
    expect(edit.body.embeds[0].title).toContain("✅");
    expect(edit.body.embeds[0].title).toContain("user-board");
    expect(edit.body.embeds[0].color).toBeGreaterThan(0); // green
    expect(edit.body.components).toEqual([]);
  });

  it("edits the original message with red embed when approval.rejected fires", async () => {
    const { ctx, eventHandlers, editedMessages, stateStore } = buildPluginContext();
    await getSetup()(ctx);

    await emitEvent(eventHandlers, "approval.created", makeApprovalEvent("approval.created", "approval-789", { eventId: "evt-create-3" }));
    const stored = stateStore.get("instance::approval_approval-789") as { channelId: string; messageId: string };
    expect(stored).toBeDefined();

    await emitEvent(eventHandlers, "approval.rejected", makeApprovalEvent("approval.rejected", "approval-789", { actorId: "user-board" }));

    expect(editedMessages).toHaveLength(1);
    const edit = editedMessages[0];
    expect(edit.channelId).toBe("ch-approvals");
    expect(edit.messageId).toBe(stored.messageId);
    expect(edit.body.embeds[0].title).toContain("❌");
    expect(edit.body.embeds[0].title).toContain("user-board");
    expect(edit.body.components).toEqual([]);
  });

  it("does nothing on decision event when no approval.created message was stored", async () => {
    const { ctx, eventHandlers, editedMessages } = buildPluginContext();
    await getSetup()(ctx);

    // Fire decision with no prior created event
    await emitEvent(eventHandlers, "approval.approved", makeApprovalEvent("approval.approved", "approval-unknown", { actorId: "board" }));

    expect(editedMessages).toHaveLength(0);
  });
});
