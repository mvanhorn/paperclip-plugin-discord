import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Gated-host smoke test.
//
// One end-to-end pass over the operator's actual install sequence on a
// v2026.720/722 host — the generation where the plugin previously died on
// activation — asserting the whole plugin definition hangs together:
//
//   install -> setup() -> health degraded -> save config -> health ok
//
// The unit suites pin each mechanism; this one exists so a regression that only
// shows up in the assembled sequence cannot pass unnoticed.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async () => ({ close: () => {} })),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "22222222-2222-2222-2222-222222222222";

const storedConfig = {
  discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
  defaultChannelId: "1490608926423646298",
  defaultGuildId: "",
  enableIntelligence: false,
  intelligenceChannelIds: [],
  enableEscalations: false,
  enableInbound: false,
  enableCommands: false,
  digestMode: "off",
};

function buildGatedHost() {
  const unscopedReads: string[] = [];
  const registered = {
    jobs: [] as string[],
    tools: [] as string[],
    actions: [] as string[],
    data: [] as string[],
  };

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) {
          unscopedReads.push("unscoped");
          throw new Error('not allowed to perform "config.get": company context is required');
        }
        // 720/722: scoped reads are denied for every company as well.
        throw new Error('not allowed to perform "config.get": company context is required');
      }),
    },
    secrets: {
      resolve: vi.fn(async (ref: unknown) => {
        if (typeof ref === "string") throw new Error("Invalid secret reference for plugin");
        return "discord-bot-token";
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn((key: string) => registered.jobs.push(key)) },
    tools: { register: vi.fn((name: string) => registered.tools.push(name)) },
    data: { register: vi.fn((key: string) => registered.data.push(key)) },
    actions: { register: vi.fn((key: string) => registered.actions.push(key)) },
    events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
    companies: {
      list: vi.fn(async () => [{ id: COMPANY, name: "Acme" }]),
      get: vi.fn(async () => ({ id: COMPANY, name: "Acme", issuePrefix: "ACME" })),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: { fetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })) },
  } as any;

  return { ctx, unscopedReads, registered };
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  vi.clearAllMocks();
});

describe("gated-host smoke: install to running", () => {
  it("activates, degrades, then starts when the operator saves the configuration", async () => {
    const { ctx, unscopedReads, registered } = buildGatedHost();

    // 1. The host activates the worker. This must not throw, whatever the host
    //    refuses to answer.
    await expect(definition().setup(ctx)).resolves.toBeUndefined();
    expect(unscopedReads).toHaveLength(0);

    // 2. Everything is registered even though no config could be read.
    expect(registered.jobs.length).toBeGreaterThanOrEqual(5);
    expect(registered.tools.length).toBeGreaterThanOrEqual(6);
    expect(registered.actions).toContain("trigger-backfill");
    expect(registered.data).toContain("channel-mapping");

    // 3. Health names the problem instead of pretending everything is fine.
    const beforeSave = await definition().onHealth();
    expect(beforeSave.status).toBe("degraded");
    expect(_getRuntimeForTests()).toBeNull();

    // 4. The operator saves the configuration; the host delivers it with scope.
    await definition().onConfigChanged(storedConfig, { companyId: COMPANY });

    // 5. The runtime is up, with no worker restart in between.
    expect(await definition().onHealth()).toEqual({ status: "ok" });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY);
    expect(unscopedReads).toHaveLength(0);
  });

  it("accepts both stored secret-ref shapes through onValidateConfig", async () => {
    await expect(
      definition().onValidateConfig({
        discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID },
        defaultChannelId: "1490608926423646298",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      definition().onValidateConfig({
        discordBotTokenRef: SECRET_ID,
        defaultChannelId: "1490608926423646298",
      }),
    ).resolves.toEqual({ ok: true });

    // A raw value pasted into the field is not a reference.
    await expect(
      definition().onValidateConfig({
        discordBotTokenRef: "MTIzNDU2Nzg5.GaBcDe.rawBotTokenLookalike",
        defaultChannelId: "1490608926423646298",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
