import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Agent bot map (plan item 1).
//
// The fork adds `agentBots` (one Discord bot per agent) and `hannaDiscordUserId`
// to plugin config. One Gateway client is opened per `agentBots` entry, using
// that entry's own resolved bot token. Outbound posts about an agent's work
// should go through that agent's client; with no match (including the
// upstream default of an empty `agentBots` array) they fall back to the
// `discordBotTokenRef` bot untouched.
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
    const record: any = {
      token,
      onInteraction,
      onMessage,
      options,
      closed: false,
      close: () => {
        record.closed = true;
      },
    };
    gatewayConnects.push(record);
    return record;
  }),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const MAIN_SECRET_ID = "33333333-3333-3333-3333-333333333333";
const EMERY_SECRET_ID = "44444444-4444-4444-4444-444444444444";
const CODA_SECRET_ID = "55555555-5555-5555-5555-555555555555";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function buildHost() {
  const secretTokens: Record<string, string> = {
    [MAIN_SECRET_ID]: "main-bot-token",
    [EMERY_SECRET_ID]: "emery-bot-token",
    [CODA_SECRET_ID]: "coda-bot-token",
  };

  const ctx = {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? {} : (() => { throw new Error("company context is required"); })())) },
    secrets: {
      resolve: vi.fn(async (ref: any) => {
        const id = ref?.secretId;
        if (id && secretTokens[id]) return secretTokens[id];
        throw new Error(`no token for secret ${id}`);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
    companies: { list: vi.fn(async () => [{ id: COMPANY_A, name: "A" }]) },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "posted-msg-1" }), text: async () => "" })),
    },
  } as any;

  return {
    ctx,
    async deliver(config: Record<string, unknown>, companyId = COMPANY_A) {
      await definition().onConfigChanged(config, { companyId });
    },
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: MAIN_SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    ...overrides,
  };
}

beforeEach(() => {
  _resetRuntimeForTests();
  gatewayConnects.length = 0;
  vi.clearAllMocks();
});

describe("agent bot map — opt-in shape (upstream parity)", () => {
  it("opens exactly one Gateway client when agentBots is empty (unset)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    expect(gatewayConnects).toHaveLength(1);
    expect(gatewayConnects[0].token).toBe("main-bot-token");
    expect(_getRuntimeForTests()?.agentBots).toEqual([]);
  });

  it("keeps hannaDiscordUserId null when unset", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    expect(_getRuntimeForTests()?.hannaDiscordUserId).toBeNull();
  });
});

describe("agent bot map — one Gateway client per configured entry", () => {
  it("opens one additional Gateway client per agentBots entry, with that entry's own token", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          { agentId: "agent-emery", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery" },
          { agentId: "agent-coda", botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID }, channelId: "chan-coda" },
        ],
        hannaDiscordUserId: "999999999999999999",
      }),
    );

    // One for the default bot, one per agentBots entry.
    expect(gatewayConnects).toHaveLength(3);
    const tokens = gatewayConnects.map((g) => g.token);
    expect(tokens).toEqual(["main-bot-token", "emery-bot-token", "coda-bot-token"]);

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots).toEqual([
      { agentId: "agent-emery", alsoForAgentIds: [], token: "emery-bot-token", channelId: "chan-emery", gateway: gatewayConnects[1] },
      { agentId: "agent-coda", alsoForAgentIds: [], token: "coda-bot-token", channelId: "chan-coda", gateway: gatewayConnects[2] },
    ]);
    expect(rt.hannaDiscordUserId).toBe("999999999999999999");
  });

  it("skips an entry whose bot token cannot be resolved, without failing the others", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          { agentId: "agent-emery", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery" },
          { agentId: "agent-ghost", botTokenRef: { type: "secret_ref", secretId: "66666666-6666-6666-6666-666666666666" }, channelId: "chan-ghost" },
        ],
      }),
    );

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots.map((b) => b.agentId)).toEqual(["agent-emery"]);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve an agent bot token"),
      expect.objectContaining({ agentId: "agent-ghost" }),
    );
  });

  it("closes every agent bot gateway on a config change that removes it", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [{ agentId: "agent-emery", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery" }],
      }),
    );
    const emeryGateway = gatewayConnects[1];
    expect(emeryGateway.closed).toBe(false);

    await host.deliver(baseConfig({ agentBots: [] }));

    expect(emeryGateway.closed).toBe(true);
    expect(_getRuntimeForTests()?.agentBots).toEqual([]);
  });

  it("closes every agent bot gateway when the plugin stops", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [{ agentId: "agent-emery", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery" }],
      }),
    );
    const emeryGateway = gatewayConnects[1];

    const stopping = host.ctx.events.on.mock.calls.find(([name]: any[]) => name === "plugin.stopping");
    await stopping[1]();

    expect(emeryGateway.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A lead's bot also posts for its listed workers (alsoForAgentIds).
//
// Hanna decided 2026-09-26: 4 agents get their own bot (Emery, Aspen, Coda,
// Darcey); each worker's issues post through its lead's bot, in the lead's
// channel. The config names the workers explicitly — nothing here looks up
// reportsTo at runtime.
// ---------------------------------------------------------------------------

describe("agent bot map — alsoForAgentIds", () => {
  it("an entry with empty alsoForAgentIds behaves exactly as before", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          {
            agentId: "agent-emery",
            botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID },
            channelId: "chan-emery",
            alsoForAgentIds: [],
          },
        ],
      }),
    );

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots).toEqual([
      { agentId: "agent-emery", alsoForAgentIds: [], token: "emery-bot-token", channelId: "chan-emery", gateway: gatewayConnects[1] },
    ]);
  });

  it("resolves a listed worker's alsoForAgentIds onto the lead's entry", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          {
            agentId: "agent-coda",
            botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
            channelId: "chan-coda",
            alsoForAgentIds: ["agent-clay", "agent-quinn", "agent-rowan"],
          },
        ],
      }),
    );

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots[0]?.alsoForAgentIds).toEqual(["agent-clay", "agent-quinn", "agent-rowan"]);
  });

  it("reuses one Gateway connection when two entries resolve to the same bot token, and logs it", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          { agentId: "agent-emery", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery" },
          { agentId: "agent-atlas", botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID }, channelId: "chan-emery-2" },
        ],
      }),
    );

    // One for the default bot, and only ONE more — shared — for the two
    // agentBots entries that resolved to the same token.
    expect(gatewayConnects).toHaveLength(2);

    const rt = _getRuntimeForTests()!;
    const emery = rt.agentBots.find((b) => b.agentId === "agent-emery")!;
    const atlas = rt.agentBots.find((b) => b.agentId === "agent-atlas")!;
    expect(emery.gateway).toBe(atlas.gateway);
    expect(emery.gateway).not.toBeNull();

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("same bot token"),
      expect.objectContaining({ agentId: "agent-atlas" }),
    );
  });

  it("logs and keeps the first entry when an agent id is claimed by more than one entry", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          {
            agentId: "agent-emery",
            botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID },
            channelId: "chan-emery",
            alsoForAgentIds: ["agent-worker"],
          },
          {
            agentId: "agent-coda",
            botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
            channelId: "chan-coda",
            alsoForAgentIds: ["agent-worker"],
          },
        ],
      }),
    );

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots.find((b) => b.agentId === "agent-emery")?.alsoForAgentIds).toEqual(["agent-worker"]);
    expect(rt.agentBots.find((b) => b.agentId === "agent-coda")?.alsoForAgentIds).toEqual([]);

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("claimed by more than one entry"),
      expect.objectContaining({
        agentId: "agent-worker",
        firstEntry: "agent-emery",
        droppedEntry: "agent-coda",
      }),
    );
  });

  it("logs and dedups when the same worker id repeats within one entry's own alsoForAgentIds", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(
      baseConfig({
        agentBots: [
          {
            agentId: "agent-coda",
            botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
            channelId: "chan-coda",
            alsoForAgentIds: ["agent-clay", "agent-clay"],
          },
        ],
      }),
    );

    const rt = _getRuntimeForTests()!;
    expect(rt.agentBots[0]?.alsoForAgentIds).toEqual(["agent-clay"]);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("claimed by more than one entry"),
      expect.objectContaining({ agentId: "agent-clay", firstEntry: "agent-coda", droppedEntry: "agent-coda" }),
    );
  });
});
