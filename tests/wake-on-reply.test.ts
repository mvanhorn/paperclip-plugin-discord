import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Wake on reply (plan item 3, revised).
//
// A reply becomes a board comment (authorUserId-attributed), and that alone
// wakes the assignee: the Paperclip server's shouldWakeAssigneeForIssueComment
// wakes on any non-self comment while the issue is not done/cancelled. An
// earlier revision of this fork also prefixed a literal "@Name" onto the
// comment body, but that prefix woke nobody by itself — Paperclip only parses
// "[@Name](agent://<id>)" as a mention — so it was dropped. The comment body
// is the reply text, unchanged, and the issue/agent lookup that built the
// prefix is gone with it.
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
    const record: any = { token, onInteraction, onMessage, options, close: () => {} };
    gatewayConnects.push(record);
    return record;
  }),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function gateway(): any {
  return gatewayConnects[gatewayConnects.length - 1];
}

let fetchMock: ReturnType<typeof vi.fn>;

function commentPosts() {
  return fetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/comments"));
}

function buildHost(opts: { issue?: any; agents?: any[] } = {}) {
  const stateStore = new Map<string, unknown>();

  const ctx = {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? {} : (() => { throw new Error("company context is required"); })())) },
    secrets: { resolve: vi.fn(async () => "main-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
    companies: { list: vi.fn(async () => [{ id: COMPANY_A, name: "A" }]) },
    agents: { list: vi.fn(async () => opts.agents ?? []) },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => opts.issue ?? null),
      listComments: vi.fn(async () => []),
    },
    http: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "posted-msg-1" }), text: async () => "" })),
    },
  } as any;

  return {
    ctx,
    stateStore,
    async deliver(config: Record<string, unknown> = {}, companyId = COMPANY_A) {
      await definition().onConfigChanged(baseConfig(config), { companyId });
    },
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    // The allowlist fails closed: matches typedMessage()'s author id "u1".
    hannaDiscordUserId: "u1",
    ...overrides,
  };
}

function typedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-2",
    channel_id: "chan-1",
    content: "ship the release",
    author: { id: "u1", username: "alice", bot: false },
    message_reference: { message_id: "msg-1", channel_id: "chan-1" },
    ...overrides,
  } as any;
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  })) as any;
  vi.stubGlobal("fetch", fetchMock);
});

describe("wake on reply — the board comment itself is the wake path", () => {
  it("posts the reply text as-is, with no mention prefix", async () => {
    const host = buildHost({
      issue: { assigneeAgentId: "agent-coda" },
      agents: [{ id: "agent-coda", name: "Coda" }],
    });
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage());

    expect(commentPosts()).toHaveLength(1);
    const [url, init] = commentPosts()[0];
    expect(String(url)).toContain("/api/issues/issue-9/comments");
    const body = JSON.parse(String(init.body));
    expect(body.body).toBe("ship the release");
    expect(body.authorUserId).toBe("discord:alice");
  });

  it("posts the same plain body when the issue has no agent assignee", async () => {
    const host = buildHost({ issue: { assigneeAgentId: null } });
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage());

    const [, init] = commentPosts()[0];
    expect(JSON.parse(String(init.body)).body).toBe("ship the release");
  });

  it("never looks up the issue or the agent list — the board comment alone wakes the assignee", async () => {
    const host = buildHost({
      issue: { assigneeAgentId: "agent-coda" },
      agents: [{ id: "agent-coda", name: "Coda" }],
    });
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage());

    expect(host.ctx.issues.get).not.toHaveBeenCalled();
    expect(host.ctx.agents.list).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(1);
  });
});
