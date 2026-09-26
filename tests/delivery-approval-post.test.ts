import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The delivery post, and the author allowlist over modal submits.
//
// An issue moving to `in_review` assigned to `local-board` is a delivery
// waiting on Hanna. It posts once into `approvalsChannelId` carrying the
// mention, the identifier, the title, the hand-off comment, the link, and the
// Accept / Request changes buttons. `blocked` keeps the old agent-bot-channel
// shape with no buttons. This extends `notifyBoardWake` rather than adding a
// second poster, so one review round never produces two messages.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

const { gatewayConnects } = vi.hoisted(() => ({ gatewayConnects: [] as any[] }));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any, onMessage: any, options: any) => {
    const record = { token, onInteraction, onMessage, options, close: () => {} };
    gatewayConnects.push(record);
    return record;
  }),
}));

const mockPaperclipFetch = vi.fn();
vi.mock("../src/paperclip-fetch.js", () => ({
  paperclipFetch: (...args: unknown[]) => mockPaperclipFetch(...args),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const MAIN_SECRET_ID = "33333333-3333-3333-3333-333333333333";
const CODA_SECRET_ID = "44444444-4444-4444-4444-444444444444";
const BOARD_KEY_SECRET_ID = "55555555-5555-5555-5555-555555555555";
const HANNA_ID = "999999999999999999";
const OTHER_ID = "111111111111111111";
// A real Paperclip issue id. The decision handlers check the id they slice
// out of a `custom_id` against the UUID shape before any API call, so a
// placeholder here would be refused rather than decided.
const ISSUE_ID = "66666666-6666-6666-6666-666666666666";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

/** The plugin's own bot Gateway — the only one that runs `handleInteraction`. */
function gateway(): any {
  return gatewayConnects.find((g) => g.token === "main-bot-token");
}

let httpFetchMock: ReturnType<typeof vi.fn>;

function postedMessages() {
  return httpFetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/messages"));
}

function postedBody(index = 0) {
  return JSON.parse(String(postedMessages()[index][1].body));
}

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();
  const secretTokens: Record<string, string> = {
    [MAIN_SECRET_ID]: "main-bot-token",
    [CODA_SECRET_ID]: "coda-bot-token",
    [BOARD_KEY_SECRET_ID]: "board-key",
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
    async issueUpdated(payload: Record<string, unknown>, companyId = COMPANY_A, entityId = ISSUE_ID) {
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
    paperclipBoardApiKeyRef: { type: "secret_ref", secretId: BOARD_KEY_SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    notifyOnIssueDone: false,
    paperclipBaseUrl: "https://paperclip.test",
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

const WAITING_ISSUE = {
  identifier: "SAG-42",
  title: "Ship the thing",
  status: "in_review",
  assigneeUserId: "local-board",
  assigneeAgentId: "agent-coda",
  updatedAt: "2026-09-26T01:00:00.000Z",
};

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  mockPaperclipFetch.mockReset();
  vi.clearAllMocks();
  httpFetchMock = vi.fn(async (_url: string, init: any) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ id: "posted-msg-1" }),
    text: async () => "",
    __init: init,
  })) as any;
});

describe("the delivery post", () => {
  it("goes to approvalsChannelId with the mention, identifier, title, comment, link, and both buttons", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([
      { body: "Ready for your call.", authorAgentId: "agent-coda", createdAt: "2026-09-26T00:59:00.000Z" },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(postedMessages()).toHaveLength(1);
    const [url, init] = postedMessages()[0];
    expect(String(url)).toContain("/channels/chan-approvals/messages");
    // The plugin's own bot posts it. Discord routes a component interaction
    // only to the application that owns the message, and only this bot's
    // Gateway runs `handleInteraction`; an agent bot's Gateway refuses every
    // interaction, so buttons posted through one would be dead.
    expect(init.headers.Authorization).toBe("Bot main-bot-token");

    const body = postedBody();
    expect(body.content).toContain(`<@${HANNA_ID}>`);
    expect(body.content).toContain("SAG-42");
    expect(body.content).toContain("Ship the thing");
    expect(body.content).toContain("Ready for your call.");
    expect(body.content).toContain("https://paperclip.test/issues/SAG-42");

    expect(body.components).toHaveLength(1);
    expect(body.components[0].type).toBe(1);
    const [accept, changes] = body.components[0].components;
    expect(accept).toMatchObject({ type: 2, label: "Accept", custom_id: `delivery_accept_${ISSUE_ID}` });
    expect(changes).toMatchObject({ type: 2, label: "Request changes", custom_id: `delivery_changes_${ISSUE_ID}` });
  });

  it("cuts the hand-off comment at 1,900 characters and still carries the link", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([
      { body: "y".repeat(2500), authorAgentId: "agent-coda", createdAt: "2026-09-26T00:59:00.000Z" },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const body = postedBody();
    expect(body.content).toContain("y".repeat(1900));
    expect(body.content).not.toContain("y".repeat(1901));
    expect(body.content).toContain("https://paperclip.test/issues/SAG-42");
  });

  it("posts once for a redelivered event", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(postedMessages()).toHaveLength(1);
  });

  it("falls back to the agent bot's channel with the buttons when approvalsChannelId is unset", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const [url, init] = postedMessages()[0];
    expect(String(url)).toContain("/channels/chan-coda/messages");
    // Still the plugin's own bot, for the same reason: the buttons have to
    // reach a Gateway that handles them.
    expect(init.headers.Authorization).toBe("Bot main-bot-token");
    expect(postedBody().components[0].components).toHaveLength(2);
  });

  it("leaves the blocked wake on the agent bot's channel with no buttons", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue({ ...WAITING_ISSUE, status: "blocked" });
    await host.issueUpdated({ status: "blocked", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const [url] = postedMessages()[0];
    expect(String(url)).toContain("/channels/chan-coda/messages");
    expect(postedBody().components).toBeUndefined();
  });

  it("releases the dedup claim when Discord refuses the delivery post", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    httpFetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "Missing Access",
    }));

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(postedMessages()).toHaveLength(2);
  });
});

describe("the author allowlist covers modal submits", () => {
  function modalSubmit(userId: string) {
    return {
      type: 5,
      data: {
        custom_id: `delivery_changes_modal_${ISSUE_ID}`,
        components: [{ type: 1, components: [{ type: 4, custom_id: "reason", value: "Not yet." }] }],
      },
      member: { user: { id: userId, username: "someone" } },
    };
  }

  it("drops a modal submit from anyone but Hanna, and sends no PATCH", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ enableCommands: true });

    const response = (await gateway().onInteraction(modalSubmit(OTHER_ID))) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
  });

  it("lets Hanna's modal submit through to the decision call", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ enableCommands: true });

    mockPaperclipFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: ISSUE_ID, status: "in_review", assigneeUserId: "local-board" }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: ISSUE_ID, status: "in_progress" }),
        text: async () => "",
      });

    const response = (await gateway().onInteraction(modalSubmit(HANNA_ID))) as any;

    const patch = mockPaperclipFetch.mock.calls.find(([, init]: any[]) => init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1].body)).toEqual({ status: "in_progress", comment: "Not yet." });
    expect(response.type).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// What the delivery post is allowed to do to the channel.
//
// The content carries agent-authored text — the hand-off comment — next to
// buttons that decide an issue. Two things follow: Discord must not resolve a
// mention that text contains, and the text must not be able to pass as the
// message's own structure.
// ---------------------------------------------------------------------------

describe("the delivery post's mentions", () => {
  it("pings Hanna and nobody else", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([
      {
        body: "Ping @everyone and <@&4242> about this.",
        authorAgentId: "agent-coda",
        createdAt: "2026-09-26T00:59:00.000Z",
      },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const body = postedBody();
    // `parse: []` resolves nothing at all; `users` re-admits exactly one id.
    expect(body.allowed_mentions).toEqual({ parse: [], users: [HANNA_ID] });
    // Her mention is still in the text, so the ping it asks for still fires.
    expect(body.content).toContain(`<@${HANNA_ID}>`);
  });
});

describe("the delivery post's agent text", () => {
  it("block-quotes every line of the hand-off comment", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([
      {
        body: "Done.\n**SAG-99** — Approve the payout\nhttps://paperclip.test/issues/SAG-99",
        authorAgentId: "agent-coda",
        createdAt: "2026-09-26T00:59:00.000Z",
      },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const content = postedBody().content as string;
    expect(content).toContain("> Done.");
    // The forged heading and the forged link are quoted too, so neither can
    // read as the message's own.
    expect(content).toContain("> **SAG-99** — Approve the payout");
    expect(content).toContain("> https://paperclip.test/issues/SAG-99");
    expect(content).not.toContain("\n**SAG-99**");
    // The message's own heading and link keep their own lines, unquoted.
    expect(content).toContain("\n**SAG-42** — Ship the thing\n");
    expect(content).toContain("\nhttps://paperclip.test/issues/SAG-42");
  });

  it("cuts at 1,900 characters before it quotes, so the budget still measures the agent's text", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([
      { body: "z".repeat(2500), authorAgentId: "agent-coda", createdAt: "2026-09-26T00:59:00.000Z" },
    ]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const content = postedBody().content as string;
    expect(content).toContain(`> ${"z".repeat(1900)}`);
    expect(content).not.toContain("z".repeat(1901));
  });

  it("adds no stray quote line when there is no hand-off comment", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannelId: "chan-approvals" });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    host.ctx.issues.listComments.mockResolvedValue([]);

    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    // No empty `> ` line where the ask would have been.
    const lines = (postedBody().content as string).split("\n");
    expect(lines.some((line) => line.startsWith(">"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Where the delivery post goes.
//
// The same precedence `approval.created` uses, through `resolveChannel`: the
// `/clip connect-channel` state override, then the per-company
// `approvalsChannels` map, then `companyChannels`, then the global
// `approvalsChannelId`, and last the assignee bot's channel.
// ---------------------------------------------------------------------------

describe("the delivery post's channel precedence", () => {
  it("takes the per-company approvalsChannels map over the global approvalsChannelId", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      approvalsChannelId: "chan-approvals",
      approvalsChannels: { [COMPANY_A]: "chan-company-approvals" },
    });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(String(postedMessages()[0][0])).toContain("/channels/chan-company-approvals/messages");
  });

  it("uses approvalsChannels even when approvalsChannelId is unset, rather than the assignee bot's channel", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannels: { [COMPANY_A]: "chan-company-approvals" } });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    const url = String(postedMessages()[0][0]);
    expect(url).toContain("/channels/chan-company-approvals/messages");
    expect(url).not.toContain("chan-coda");
  });

  it("takes the /clip connect-channel override over both", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      approvalsChannelId: "chan-approvals",
      approvalsChannels: { [COMPANY_A]: "chan-company-approvals" },
    });
    host.stateStore.set(`company:${COMPANY_A}:discord-channel`, "chan-connected");

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(String(postedMessages()[0][0])).toContain("/channels/chan-connected/messages");
  });

  it("still posts through the plugin's own bot wherever the channel resolves", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ approvalsChannels: { [COMPANY_A]: "chan-company-approvals" } });

    host.ctx.issues.get.mockResolvedValue(WAITING_ISSUE);
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-coda" });

    expect(postedMessages()[0][1].headers.Authorization).toBe("Bot main-bot-token");
    expect(postedBody().components[0].components).toHaveLength(2);
  });

  it("drops a delivery with no approvals channel and no agent bot channel", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.ctx.issues.get.mockResolvedValue({ ...WAITING_ISSUE, assigneeAgentId: "agent-unmapped" });
    await host.issueUpdated({ status: "in_review", assigneeUserId: "local-board", assigneeAgentId: "agent-unmapped" });

    expect(postedMessages()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no agent bot/channel"),
      expect.objectContaining({ issueId: ISSUE_ID }),
    );
  });
});

// ---------------------------------------------------------------------------
// A refused interaction leaves a record.
// ---------------------------------------------------------------------------

describe("the refusal log", () => {
  it("names the author and the custom_id when someone else presses Accept", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ enableCommands: true });

    const customId = `delivery_accept_${ISSUE_ID}`;
    const response = (await gateway().onInteraction({
      type: 3,
      data: { custom_id: customId, component_type: 2 },
      member: { user: { id: OTHER_ID, username: "someone" } },
    })) as any;

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("refused"),
      expect.objectContaining({ authorId: OTHER_ID, customId }),
    );
  });

  it("logs a refused slash command by its name", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ enableCommands: true });

    await gateway().onInteraction({
      type: 2,
      data: { name: "clip" },
      member: { user: { id: OTHER_ID, username: "someone" } },
    });

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("refused"),
      expect.objectContaining({ authorId: OTHER_ID, customId: "clip" }),
    );
  });
});
