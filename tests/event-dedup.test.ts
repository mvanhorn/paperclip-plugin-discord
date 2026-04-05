import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// These tests verify that duplicate event deliveries (same eventId) produce
// only one Discord notification. The runtime may redeliver events on retries
// or replays; the dedup guard in notify() prevents double-posting.
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

// Static import so vitest hoists the mock before it executes.
import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

/**
 * Build a PluginContext stub that captures event handler registrations
 * and mocks Discord API calls to track how many messages are posted.
 */
function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  let discordMessageCount = 0;

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: "fake-secret-ref",
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "http://localhost:3100",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: true,
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

  // Mock Discord HTTP calls — count messages instead of hitting the API.
  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

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
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      register: vi.fn(),
    },
    tools: {
      register: vi.fn(),
    },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn().mockImplementation((name: string, fn: (event: any) => Promise<void>) => {
        const handlers = eventHandlers.get(name) || [];
        handlers.push(fn);
        eventHandlers.set(name, handlers);
        return () => {}; // unsubscribe noop
      }),
    },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: mockDiscordFetch,
    },
  } as any;

  return { ctx, eventHandlers, getDiscordMessageCount: () => discordMessageCount, mockDiscordFetch };
}

function makeEvent(eventType: string, eventId: string, payload: Record<string, unknown> = {}): any {
  return {
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    companyId: "company-1",
    entityId: "entity-1",
    entityType: "issue",
    payload,
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("event deduplication", () => {
  it("issue.created: first delivery posts, duplicate is skipped", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      notifyOnIssueCreated: true,
    });
    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-issue-1", {
      title: "Test issue",
      identifier: "TST-1",
    });

    // First delivery → should post
    await emitEvent(eventHandlers, "issue.created", event);
    const firstCallCount = mockDiscordFetch.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // Duplicate delivery → should be skipped
    await emitEvent(eventHandlers, "issue.created", event);
    const secondCallCount = mockDiscordFetch.mock.calls.length;
    expect(secondCallCount).toBe(firstCallCount);

    // Verify dedup was logged
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Skipping duplicate event"),
    );
  });

  it("uses manifest defaults when saved config omits notify flags", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    const configGet = ctx.config.get as ReturnType<typeof vi.fn>;
    configGet.mockResolvedValueOnce({
      discordBotTokenRef: "fake-secret-ref",
      defaultGuildId: "",
      defaultChannelId: "ch-1",
    });

    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-defaulted-1", {
      title: "Defaulted config issue",
      identifier: "TST-DEFAULT",
    });

    await emitEvent(eventHandlers, "issue.created", event);
    expect(mockDiscordFetch).toHaveBeenCalled();
  });

  it("issue.updated (done): first delivery posts, duplicate is skipped", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      notifyOnIssueDone: true,
    });
    await getSetup()(ctx);

    const event = makeEvent("issue.updated", "evt-done-1", {
      status: "done",
      title: "Completed issue",
      identifier: "TST-2",
    });

    await emitEvent(eventHandlers, "issue.updated", event);
    const firstCallCount = mockDiscordFetch.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    await emitEvent(eventHandlers, "issue.updated", event);
    expect(mockDiscordFetch.mock.calls.length).toBe(firstCallCount);
  });

  it("approval.created: first delivery posts, duplicate is skipped", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      notifyOnApprovalCreated: true,
    });
    await getSetup()(ctx);

    const event = makeEvent("approval.created", "evt-approval-1", {
      title: "Approval needed",
    });

    await emitEvent(eventHandlers, "approval.created", event);
    const firstCallCount = mockDiscordFetch.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    await emitEvent(eventHandlers, "approval.created", event);
    expect(mockDiscordFetch.mock.calls.length).toBe(firstCallCount);
  });

  it("different eventIds are NOT deduplicated", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      notifyOnIssueCreated: true,
    });
    await getSetup()(ctx);

    const event1 = makeEvent("issue.created", "evt-unique-1", { title: "Issue A", identifier: "TST-A" });
    const event2 = makeEvent("issue.created", "evt-unique-2", { title: "Issue B", identifier: "TST-B" });

    await emitEvent(eventHandlers, "issue.created", event1);
    const afterFirst = mockDiscordFetch.mock.calls.length;

    await emitEvent(eventHandlers, "issue.created", event2);
    const afterSecond = mockDiscordFetch.mock.calls.length;

    // Both should have posted (different eventIds)
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it("events without eventId are not deduplicated (safety fallback)", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      notifyOnIssueCreated: true,
    });
    await getSetup()(ctx);

    const event = makeEvent("issue.created", undefined as any, { title: "No ID", identifier: "TST-X" });
    delete event.eventId;

    await emitEvent(eventHandlers, "issue.created", event);
    const afterFirst = mockDiscordFetch.mock.calls.length;

    await emitEvent(eventHandlers, "issue.created", event);
    const afterSecond = mockDiscordFetch.mock.calls.length;

    // Both should post — no eventId means we can't dedup
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it("escalation-created: duplicate is skipped", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      enableEscalations: true,
    });
    await getSetup()(ctx);

    const escalationEventType = "plugin.paperclip-plugin-discord.escalation-created";
    const event = makeEvent(escalationEventType, "evt-esc-1", {
      escalationId: "esc-123",
      companyId: "company-1",
      agentName: "TestAgent",
      reason: "Need human help",
    });

    await emitEvent(eventHandlers, escalationEventType, event);
    const firstCallCount = mockDiscordFetch.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    await emitEvent(eventHandlers, escalationEventType, event);
    expect(mockDiscordFetch.mock.calls.length).toBe(firstCallCount);
  });
});
