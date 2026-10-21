import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Required-config handling, issues #53 and #61.
//
// #53 made setup() THROW on missing required config instead of silently
// warn-and-return. Since paperclipai/paperclip#9557 that is no longer possible:
// setup() runs outside any company scope, cannot read config at all, and a throw
// there kills worker activation on every host. The guarantee moves to two places:
//
//   - `onValidateConfig` rejects a bad save loudly, in the settings UI, which is
//     where an operator can act on it (this is what fails fast now);
//   - the runtime bootstrap refuses to start and reports `degraded` health with
//     the missing field named, instead of falling through to an empty channel id.
//
// What #53 forbade — a silent soft path that leaves the pluginhalf-running — still
// does not happen: nothing runs until the bootstrap succeeds.
// ---------------------------------------------------------------------------

// Capture the plugin definition from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
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

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";

const TEST_COMPANY_ID = "company-1";
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

function getDefinition(): any {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedDefinitions[capturedDefinitions.length - 1];
}

/** setup() alone, exactly as a host runs it: no company scope, no config. */
async function runSetup(ctx: any): Promise<void> {
  _resetRuntimeForTests();
  await getDefinition().setup(ctx);
}

/** setup() plus the host's company-scoped config delivery. */
async function mount(ctx: any, config: Record<string, unknown>): Promise<void> {
  await runSetup(ctx);
  await getDefinition().onConfigChanged(config, { companyId: TEST_COMPANY_ID });
}

async function health(): Promise<any> {
  return getDefinition().onHealth();
}

/**
 * Build a minimal PluginContext stub. The config passed to ctx.config.get()
 * is whatever `config` is provided — deliberately NOT merged with sane
 * defaults so a missing required field actually reaches setup() as missing.
 */
function buildPluginContext(config: Record<string, unknown>) {
  const registeredJobs = new Map<string, Function>();

  const ctx = {
    config: {
      get: vi.fn().mockImplementation(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        return config;
      }),
    },
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
    jobs: {
      register: vi.fn().mockImplementation((key: string, handler: Function) => {
        registeredJobs.set(key, handler);
      }),
    },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn() },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: "company-1", name: "Acme", issuePrefix: "ACME" }),
    },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    },
  } as any;

  return { ctx, registeredJobs };
}

/** A config with all required fields present and features off. */
function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultChannelId: "ch-1",
    defaultGuildId: "",
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableProactiveSuggestions: false,
    enableCustomCommands: false,
    enableInbound: false,
    digestMode: "off",
    ...overrides,
  };
}

describe("required config handling (issues #53, #61)", () => {
  it("setup() never throws when the bot token reference is missing", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: undefined }));
    await expect(runSetup(ctx)).resolves.toBeUndefined();
  });

  it("setup() never throws when the host denies every scoped config read", async () => {
    const { ctx } = buildPluginContext(validConfig());
    ctx.config.get.mockRejectedValue(new Error(UNSCOPED_CONFIG_ERROR));
    ctx.companies.list.mockResolvedValue([{ id: TEST_COMPANY_ID }]);
    await expect(runSetup(ctx)).resolves.toBeUndefined();
    expect(_getRuntimeForTests()).toBeNull();
  });

  it("refuses to start and names the missing bot token reference in health", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "   " }));
    await mount(ctx, validConfig({ discordBotTokenRef: "   " }));

    expect(_getRuntimeForTests()).toBeNull();
    const diagnostics = await health();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toMatch(/discordBotTokenRef/);
    expect(diagnostics.message).toMatch(/paperclip-plugin-discord/);
  });

  it("refuses to start and names the missing default channel in health", async () => {
    const config = validConfig({ defaultChannelId: "  " });
    const { ctx } = buildPluginContext(config);
    await mount(ctx, config);

    expect(_getRuntimeForTests()).toBeNull();
    const diagnostics = await health();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toMatch(/defaultChannelId/);
  });

  it("onValidateConfig rejects a save that is missing either required field", async () => {
    const definition = getDefinition();
    await expect(definition.onValidateConfig({ defaultChannelId: "ch-1" })).resolves.toMatchObject({
      ok: false,
      errors: [expect.stringContaining("discordBotTokenRef is required")],
    });
    await expect(
      definition.onValidateConfig({ discordBotTokenRef: "11111111-1111-4111-8111-111111111111" }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [expect.stringContaining("defaultChannelId is required")],
    });
  });

  it("onValidateConfig accepts both the picker binding and a legacy UUID string", async () => {
    const definition = getDefinition();
    await expect(
      definition.onValidateConfig({
        discordBotTokenRef: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555", version: "latest" },
        defaultChannelId: "ch-1",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      definition.onValidateConfig({
        discordBotTokenRef: "11111111-2222-3333-4444-555555555555",
        defaultChannelId: "ch-1",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("starts and registers jobs once both required fields arrive", async () => {
    const config = validConfig();
    const { ctx, registeredJobs } = buildPluginContext(config);
    await mount(ctx, config);

    expect(_getRuntimeForTests()).not.toBeNull();
    expect(registeredJobs.size).toBeGreaterThan(0);
  });
});
