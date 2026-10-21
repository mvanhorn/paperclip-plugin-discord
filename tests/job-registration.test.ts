import { describe, it, expect, vi } from "vitest";
import manifest from "../src/manifest.js";

// ---------------------------------------------------------------------------
// The bug: job handlers were registered inside config-conditional blocks,
// so when a feature flag was off the runtime had no handler for the job key
// declared in the manifest — causing a crash at runtime.
//
// These tests verify that every jobKey in the manifest receives a registered
// handler regardless of the config values passed to setup().
// ---------------------------------------------------------------------------

// Capture the setup function from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
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

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
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

/**
 * Build a minimal PluginContext stub that records job registrations.
 */
function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const registeredJobs = new Map<string, Function>();

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: false,
    notifyOnIssueDone: false,
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
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      register: vi.fn().mockImplementation((key: string, handler: Function) => {
        registeredJobs.set(key, handler);
      }),
    },
    tools: {
      register: vi.fn(),
    },
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

/** Extract just the jobKeys from the manifest. */
const manifestJobKeys = manifest.jobs!.map((j) => j.jobKey);

async function runSetup(configOverrides: Record<string, unknown> = {}) {
  const { ctx, registeredJobs } = buildPluginContext(configOverrides);
  await getSetup()(ctx);
  return { ctx, registeredJobs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("job handler registration vs manifest", () => {
  it("manifest declares expected job keys", () => {
    expect(manifestJobKeys).toEqual(
      expect.arrayContaining([
        "discord-intelligence-scan",
        "check-escalation-timeouts",
        "check-watches",
        "discord-daily-digest",
      ]),
    );
  });

  it("registers ALL manifest job handlers when all features are DISABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: false,
      enableIntelligence: false,
      intelligenceChannelIds: [],
      digestMode: "off",
      enableEscalations: false,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("registers ALL manifest job handlers when all features are ENABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: true,
      enableIntelligence: true,
      intelligenceChannelIds: ["ch-intel"],
      digestMode: "daily",
      enableEscalations: true,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("check-watches handler early-returns when proactive suggestions disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableProactiveSuggestions: false,
    });

    const handler = registeredJobs.get("check-watches")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("proactive suggestions disabled"),
    );
  });

  it("discord-daily-digest handler early-returns when digest mode is off", async () => {
    const { registeredJobs, ctx } = await runSetup({
      digestMode: "off",
    });

    const handler = registeredJobs.get("discord-daily-digest")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("digest mode is off"),
    );
  });

  // Registration-time logging can no longer report the digest mode: setup() runs
  // outside any company scope and cannot read config (paperclipai/paperclip#9557),
  // so the mode is only known when the job actually runs.
  it("registers the digest job without announcing a mode it cannot know yet", async () => {
    const { ctx } = await runSetup({ digestMode: "off" });

    const infoMessages = ctx.logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoMessages).not.toContainEqual(
      expect.stringContaining("Daily digest job registered"),
    );
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Daily digest job registered"),
    );
  });

  it("reads the digest mode from the live config when the job runs", async () => {
    const { registeredJobs, ctx } = await runSetup({ digestMode: "daily" });

    const handler = registeredJobs.get("discord-daily-digest")!;
    await handler();

    // Mode "daily" means no early return for an off digest.
    expect(ctx.logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("digest mode is off"),
    );
  });

  it("discord-intelligence-scan handler early-returns when intelligence disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableIntelligence: false,
      intelligenceChannelIds: [],
    });

    const handler = registeredJobs.get("discord-intelligence-scan")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("intelligence disabled"),
    );
  });
});
