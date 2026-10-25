import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for topic routing: when topicRouting is enabled and a project-to-channel
 * mapping exists, notifications for that project should route to the mapped channel
 * instead of defaultChannelId.
 */

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

/** The company whose scoped config the mock host delivers. */
const TEST_COMPANY_ID = "company-1";
/** What a host >= v2026.720.0 throws for an unscoped `ctx.config.get()`. */
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import { _resetRuntimeForTests } from "../src/worker.js";

/**
 * Mount the plugin the way a governed host does (paperclipai/paperclip#9557).
 *
 * setup() runs with NO company scope — an unscoped `ctx.config.get()` throws
 * there — so the runtime is bootstrapped by the host's company-scoped config
 * delivery (`onConfigChanged`) immediately afterwards, exactly as a 2026.720/722
 * host does at worker startup.
 */
function getSetup(): (ctx: any) => Promise<void> {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  const definition = capturedDefinitions[capturedDefinitions.length - 1];
  return async (ctx: any) => {
    _resetRuntimeForTests();
    await definition.setup(ctx);
    await definition.onConfigChanged?.(ctx.__testConfig ?? {}, { companyId: TEST_COMPANY_ID });
  };
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const actionHandlers = new Map<string, (params: any) => Promise<any>>();
  let discordMessageCount = 0;

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-default",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: false,
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

  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

  const ctx = {
    // A governed host denies an unscoped read; the plugin must never make one.
    config: {
      get: vi.fn().mockImplementation(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        return defaultConfig;
      }),
    },
    __testConfig: defaultConfig,
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockImplementation(async (opts: { scopeKind: string; stateKey: string; scopeId?: string }) => {
        const key = opts.scopeId ? `${opts.scopeKind}:${opts.scopeId}:${opts.stateKey}` : `${opts.scopeKind}:${opts.stateKey}`;
        return stateOverrides[key] ?? stateOverrides[opts.stateKey] ?? null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: {
      register: vi.fn().mockImplementation((name: string, fn: (params: any) => Promise<any>) => {
        actionHandlers.set(name, fn);
      }),
    },
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
    projects: {
      get: vi.fn().mockResolvedValue(null),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, actionHandlers, mockDiscordFetch };
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

describe("topic routing", () => {
  it("routes to mapped channel when topicRouting is enabled and mapping exists", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueCreated: true },
      { "channel-project-map": { "my-project": "ch-project-specific" } },
    );
    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-1", {
      title: "New issue",
      identifier: "TST-1",
      projectName: "my-project",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    // Should have posted to Discord — check the channel in the URL
    expect(mockDiscordFetch).toHaveBeenCalled();
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("ch-project-specific");
  });

  it("falls back to defaultChannelId when topicRouting is enabled but no mapping exists", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueCreated: true },
      { "channel-project-map": { "other-project": "ch-other" } },
    );
    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-2", {
      title: "Unmapped issue",
      identifier: "TST-2",
      projectName: "unmapped-project",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    expect(mockDiscordFetch).toHaveBeenCalled();
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("ch-default");
  });

  it("falls back to defaultChannelId when topicRouting is disabled", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: false, notifyOnIssueCreated: true },
      { "channel-project-map": { "my-project": "ch-project-specific" } },
    );
    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-3", {
      title: "Issue with routing off",
      identifier: "TST-3",
      projectName: "my-project",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    expect(mockDiscordFetch).toHaveBeenCalled();
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("ch-default");
  });

  it("uses overrideChannelId (e.g. approvalsChannelId) even when topic mapping exists", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnApprovalCreated: true, approvalsChannelId: "ch-approvals" },
      { "channel-project-map": { "my-project": "ch-project-specific" } },
    );
    await getSetup()(ctx);

    const event = makeEvent("approval.created", "evt-topic-4", {
      title: "Approval",
      identifier: "TST-4",
      projectName: "my-project",
    });

    await emitEvent(eventHandlers, "approval.created", event);

    expect(mockDiscordFetch).toHaveBeenCalled();
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    // Should use the override, not the topic mapping
    expect(postCall![0]).toContain("ch-approvals");
  });

  it("falls back to defaultChannelId when event has no projectName", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueCreated: true },
      { "channel-project-map": { "my-project": "ch-project-specific" } },
    );
    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-5", {
      title: "Issue without project",
      identifier: "TST-5",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    expect(mockDiscordFetch).toHaveBeenCalled();
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("ch-default");
  });

  it("enriches issue.created before topic routing so issue project names can map to a topic channel", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueCreated: true },
      { "channel-project-map": { "my-project": "1234567890123456789" } },
    );
    ctx.issues.get = vi.fn().mockResolvedValue({
      id: "entity-1",
      identifier: "TST-6",
      title: "Created issue",
      status: "todo",
      project: { name: "my-project" },
    });

    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-6", {
      title: "Created issue",
      identifier: "TST-6",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("1234567890123456789");
    // The project relation was already present, so no extra projects.get lookup is needed.
    expect(ctx.projects.get).not.toHaveBeenCalled();
  });

  it("resolves projectName via projects.get when issues.get returns a projectId but no project relation", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueCreated: true },
      { "channel-project-map": { "my-project": "1234567890123456789" } },
    );
    // Our host returns the issue with a projectId but no `project` relation — the exact
    // shape that left projectName null and broke topic routing.
    ctx.issues.get = vi.fn().mockResolvedValue({
      id: "entity-1",
      identifier: "TST-7",
      title: "Created issue",
      status: "todo",
      projectId: "proj-123",
    });
    ctx.projects.get = vi.fn().mockResolvedValue({ id: "proj-123", name: "my-project" });

    await getSetup()(ctx);

    const event = makeEvent("issue.created", "evt-topic-7", {
      title: "Created issue",
      identifier: "TST-7",
    });

    await emitEvent(eventHandlers, "issue.created", event);

    // projects.get must have been consulted with (projectId, companyId) to recover the name.
    expect(ctx.projects.get).toHaveBeenCalledTimes(1);
    expect(ctx.projects.get).toHaveBeenCalledWith("proj-123", "company-1");

    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("1234567890123456789");
  });

  it("falls back to the default channel and still posts a complete done embed when projects.get throws", async () => {
    // A done event exercises the scope of the fail-soft try/catch: if the projects.get error
    // were caught by the function-wide catch instead of a catch scoped to the lookup, control
    // would jump past the done-enrichment block and the embed would lose its Summary/Completed-by.
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
      { topicRouting: true, notifyOnIssueDone: true },
      { "channel-project-map": { "my-project": "1234567890123456789" } },
    );
    ctx.issues.get = vi.fn().mockResolvedValue({
      id: "entity-1",
      identifier: "TST-8",
      title: "Finished issue",
      status: "done",
      completedAt: "2026-10-25T18:00:00.000Z",
      projectId: "proj-123",
    });
    ctx.issues.listComments = vi.fn().mockResolvedValue([
      { authorAgentId: "agent-1", body: "All checks green, shipping.", createdAt: "2026-10-25T17:59:00.000Z" },
    ]);
    ctx.projects.get = vi.fn().mockRejectedValue(new Error("projects.get boom"));

    await getSetup()(ctx);

    const event = makeEvent("issue.updated", "evt-topic-8", {
      title: "Finished issue",
      identifier: "TST-8",
      status: "done",
    });

    await emitEvent(eventHandlers, "issue.updated", event);

    // The lookup was attempted and the error was caught — notification still posts,
    // routed to the default channel because projectName could not be resolved.
    expect(ctx.projects.get).toHaveBeenCalledTimes(1);
    const postCall = mockDiscordFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("ch-default");

    // Crucially, the done-enrichment ran *after* the throw: the embed carries the last
    // comment as its Summary. Proving the catch is scoped to the lookup, not the whole function.
    const body = JSON.parse(postCall![1].body as string);
    const summaryField = body.embeds?.[0]?.fields?.find((f: any) => f.name === "Summary");
    expect(summaryField?.value).toContain("All checks green, shipping.");
  });

  it("rejects non-string set-channel inputs so truncated numeric snowflakes cannot be stored", async () => {
    const { ctx, actionHandlers } = buildPluginContext();
    await getSetup()(ctx);

    const setChannel = actionHandlers.get("set-channel");
    expect(setChannel).toBeDefined();

    const numericResult = await setChannel!({
      companyId: "company-1",
      channelId: 1234567890123456789,
    });
    expect(numericResult).toEqual({
      ok: false,
      error: "Invalid channel ID - must be a snowflake string",
    });
    expect(ctx.state.set).not.toHaveBeenCalled();

    const validResult = await setChannel!({
      companyId: "company-1",
      channelId: "1234567890123456789",
    });
    expect(validResult).toEqual({ ok: true });
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "company", scopeId: "company-1", stateKey: "discord-channel" }),
      "1234567890123456789",
    );
  });
});
