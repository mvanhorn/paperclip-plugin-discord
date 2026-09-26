import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Outbound trigger 1 from the spec's Message flow (plan item 4).
//
// Only an issue in `in_review` or `blocked`, assigned to `local-board`,
// mentions Hanna — and only when hannaDiscordUserId is configured. The post
// goes through the issue's assignee agent's own bot when one is mapped
// (item 1), and a long ask is capped at 1,900 characters plus the issue link.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any, onMessage: any, options: any) => ({
    token,
    onInteraction,
    onMessage,
    options,
    close: () => {},
  })),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const MAIN_SECRET_ID = "33333333-3333-3333-3333-333333333333";
const CODA_SECRET_ID = "44444444-4444-4444-4444-444444444444";
const HANNA_ID = "999999999999999999";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

let httpFetchMock: ReturnType<typeof vi.fn>;

function postedMessages() {
  return httpFetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/messages"));
}

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();
  const secretTokens: Record<string, string> = {
    [MAIN_SECRET_ID]: "main-bot-token",
    [CODA_SECRET_ID]: "coda-bot-token",
  };

  const ctx = {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? {} : (() => { throw new Error("company context is required"); })())) },
    secrets: {
      resolve: vi.fn(async (ref: any) => {
        const id = ref?.secretId;
        if (id && secretTokens[id]) return secretTokens[id];
        throw new Error(`no token for ${id}`);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
      delete: vi.fn(async (key: any) => {
        stateStore.delete(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: { list: vi.fn(async () => [{ id: COMPANY_A, name: "A" }]) },
    agents: { list: vi.fn(async () => []) },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      listComments: vi.fn(async () => []),
    },
    http: { fetch: httpFetchMock },
  } as any;

  return {
    ctx,
    stateStore,
    async deliver(config: Record<string, unknown> = {}, companyId = COMPANY_A) {
      await definition().onConfigChanged(baseConfig(config), { companyId });
    },
    async issueUpdated(payload: Record<string, unknown>, companyId = COMPANY_A, entityId = "issue-1") {
      for (const handler of eventHandlers.get("issue.updated") ?? []) {
        await handler({
          eventId: `evt-${Math.random().toString(36).slice(2)}`,
          eventType: "issue.updated",
          companyId,
          entityId,
          entityType: "issue",
          occurredAt: "2026-09-26T00:00:00.000Z",
          payload,
        });
      }
    },
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: MAIN_SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    notifyOnIssueDone: false,
    ...overrides,
  };
}

function mappedBoardWakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    hannaDiscordUserId: HANNA_ID,
    agentBots: [
      {
        agentId: "agent-coda",
        botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
        channelId: "chan-coda",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  vi.clearAllMocks();
  httpFetchMock = vi.fn(async (url: string, init: any) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ id: "posted-msg-1" }),
    text: async () => "",
    // Surface init so assertions can read headers/body without re-deriving the
    // call shape from mock.calls each time.
    __init: init,
  })) as any;
});

describe("board wake — opt-in gating", () => {
  it("never fires when hannaDiscordUserId is unset", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-1",
      title: "Need a decision",
      status: "in_review",
      assigneeUserId: "local-board",
    });

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" });

    expect(postedMessages()).toHaveLength(0);
  });

  it("does not fire for a status other than in_review or blocked", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-1",
      title: "In progress",
      status: "in_progress",
      assigneeUserId: "local-board",
    });
    await host.issueUpdated({ status: "in_progress", assigneeUserId: "local-board" });

    expect(postedMessages()).toHaveLength(0);
  });

  it("does not fire when the assignee is not local-board", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-1",
      title: "Still with the agent",
      status: "in_review",
      assigneeUserId: null,
      assigneeAgentId: "agent-coda",
    });
    await host.issueUpdated({ status: "in_review", assigneeAgentId: "agent-coda" });

    expect(postedMessages()).toHaveLength(0);
  });
});

describe("board wake — the mention and the message", () => {
  it("posts the ask, mentions Hanna, and links the issue for in_review/local-board", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig({ paperclipBaseUrl: "https://paperclip.test" }));

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-1",
      title: "Need a decision",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });
    host.ctx.issues.listComments.mockResolvedValue([
      { body: "Which plan do you want?", authorAgentId: "agent-emery", createdAt: "2026-09-26T00:59:00.000Z" },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" });

    expect(postedMessages()).toHaveLength(1);
    const [, init] = postedMessages()[0];
    const body = JSON.parse(String(init.body));
    expect(body.content).toContain(`<@${HANNA_ID}>`);
    expect(body.content).toContain("Which plan do you want?");
    expect(body.content).toContain("https://paperclip.test/issues/SAG-1");
  });

  it("fires for blocked too", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig());

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-2",
      title: "Stuck",
      status: "blocked",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board" });

    expect(postedMessages()).toHaveLength(1);
  });

  it("logs when no channel resolves for the wake (silent-failure review B3)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig());

    // The per-company `/clip connect-channel` override (resolveChannel's
    // first, highest-priority source) is checked ahead of defaultChannelId —
    // a whitespace-only override is truthy but normalizes to nothing, so
    // this is "no channel resolves" without touching bootstrap's own
    // (unrelated, already-covered) defaultChannelId requirement.
    host.stateStore.set(`company:${COMPANY_A}:discord-channel`, " ");

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-3",
      title: "No channel",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" }, COMPANY_A, "issue-3");

    expect(postedMessages()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no channel"),
      expect.objectContaining({ issueId: "issue-3", companyId: COMPANY_A }),
    );
  });

  it("logs when Discord refuses the wake post (silent-failure review B4)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig());

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-4",
      title: "Refused",
      status: "blocked",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    httpFetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "Missing Access",
    }));

    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board" }, COMPANY_A, "issue-4");

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to post"),
      expect.objectContaining({ issueId: "issue-4", companyId: COMPANY_A, status: "blocked" }),
    );

    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board" }, COMPANY_A, "issue-4");
    expect(postedMessages()).toHaveLength(2);
  });

  it("truncates a long ask to 1,900 characters and still includes the issue link", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig({ paperclipBaseUrl: "https://paperclip.test" }));

    const longAsk = "x".repeat(2500);
    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-3",
      title: "Long ask",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });
    host.ctx.issues.listComments.mockResolvedValue([
      { body: longAsk, authorAgentId: "agent-emery", createdAt: "2026-09-26T00:59:00.000Z" },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" });

    const [, init] = postedMessages()[0];
    const body = JSON.parse(String(init.body));
    expect(body.content).toContain("x".repeat(1900));
    expect(body.content).not.toContain("x".repeat(1901));
    expect(body.content).toContain("https://paperclip.test/issues/SAG-3");
  });

  // `blocked`, not `in_review`: an `in_review` wake is a delivery now, and a
  // delivery posts through the plugin's own bot so its buttons reach a Gateway
  // that handles them (see tests/delivery-approval-post.test.ts). The
  // assignee-bot routing this test covers is unchanged on the `blocked` path.
  it("routes through the assignee agent's own bot when one is mapped", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      hannaDiscordUserId: HANNA_ID,
      agentBots: [{ agentId: "agent-coda", botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID }, channelId: "chan-coda" }],
    });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-4",
      title: "Coda's ask",
      status: "blocked",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const [url, init] = postedMessages()[0];
    expect(String(url)).toContain("/channels/chan-coda/messages");
    expect(init.headers.Authorization).toBe("Bot coda-bot-token");
  });

  it("does not post a mention to the default channel with no agent bot match", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID, defaultChannelId: "chan-default" });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-5",
      title: "No agent bot",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-unmapped",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-unmapped" });

    expect(postedMessages()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no agent bot/channel"),
      expect.objectContaining({ issueId: "issue-1", companyId: COMPANY_A }),
    );
  });

  it("routes a listed worker's issue through its lead's bot and channel (alsoForAgentIds)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      hannaDiscordUserId: HANNA_ID,
      agentBots: [
        {
          agentId: "agent-coda",
          botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
          channelId: "chan-coda",
          alsoForAgentIds: ["agent-clay"],
        },
      ],
    });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-6",
      title: "Clay's ask",
      // `blocked` for the same reason as the test above.
      status: "blocked",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-clay",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board", assigneeAgentId: "agent-clay" });

    const [url, init] = postedMessages()[0];
    expect(String(url)).toContain("/channels/chan-coda/messages");
    expect(init.headers.Authorization).toBe("Bot coda-bot-token");
  });

  it("does not post for an agent id not listed as a lead or a worker", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      hannaDiscordUserId: HANNA_ID,
      defaultChannelId: "chan-default",
      agentBots: [
        {
          agentId: "agent-coda",
          botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
          channelId: "chan-coda",
          alsoForAgentIds: ["agent-clay"],
        },
      ],
    });

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-7",
      title: "Nobody's worker",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-stranger",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-stranger" });

    expect(postedMessages()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no agent bot/channel"),
      expect.objectContaining({ issueId: "issue-1", companyId: COMPANY_A }),
    );
  });

  it("does not repost for a redelivery of the same status and updatedAt", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig());

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-6",
      title: "Dup check",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" }, COMPANY_A, "issue-dup");
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board" }, COMPANY_A, "issue-dup");

    expect(postedMessages()).toHaveLength(1);
  });

  it("claims the marker before posting so concurrent deliveries produce one message", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(mappedBoardWakeConfig());

    host.ctx.issues.get.mockResolvedValue({
      identifier: "SAG-8",
      title: "Concurrent wake",
      status: "in_review",
      assigneeUserId: "local-board",
      assigneeAgentId: "agent-coda",
      updatedAt: "2026-09-26T01:00:00.000Z",
    });

    let releaseFirstPost!: () => void;
    httpFetchMock.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          releaseFirstPost = () =>
            resolve({
              ok: true,
              status: 200,
              headers: new Headers(),
              json: async () => ({ id: "posted-msg-1" }),
              text: async () => "",
            });
        }),
    );

    const first = host.issueUpdated(
      { status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" },
      COMPANY_A,
      "issue-race",
    );
    await vi.waitFor(() => expect(postedMessages()).toHaveLength(1));
    const second = host.issueUpdated(
      { status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" },
      COMPANY_A,
      "issue-race",
    );
    await second;
    expect(postedMessages()).toHaveLength(1);

    releaseFirstPost();
    await first;
    expect(postedMessages()).toHaveLength(1);
  });
});
