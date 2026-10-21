import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Degradation reports must land in the separately configured errors channel,
 * not in whatever general routing picks for the company.
 */

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

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
import {
  reportPluginError,
  resetPluginErrorReports,
  setPluginErrorSink,
} from "../src/error-reporting.js";

/** Mount the plugin the way a governed host does: unscoped setup(), then a scoped config delivery. */
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

function buildPluginContext(
  configOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {},
) {
  let discordMessageCount = 0;

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-default",
    approvalsChannelId: "",
    errorsChannelId: "",
    companyChannels: {},
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    enableInbound: false,
    digestMode: "off",
    ...configOverrides,
  };

  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

  const ctx = {
    config: {
      get: vi.fn().mockImplementation(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        return defaultConfig;
      }),
    },
    __testConfig: defaultConfig,
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn().mockImplementation(
        async (opts: { scopeKind: string; stateKey: string; scopeId?: string }) => {
          const key = opts.scopeId
            ? `${opts.scopeKind}:${opts.scopeId}:${opts.stateKey}`
            : `${opts.scopeKind}:${opts.stateKey}`;
          return stateOverrides[key] ?? stateOverrides[opts.stateKey] ?? null;
        },
      ),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn().mockReturnValue(() => {}) },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: TEST_COMPANY_ID, name: "Acme", issuePrefix: "ACME" }),
    },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, mockDiscordFetch };
}

/** The channel id the degradation embed was posted to, or null. */
function postedChannel(mockDiscordFetch: ReturnType<typeof vi.fn>): string | null {
  const call = mockDiscordFetch.mock.calls.find(
    (c: any[]) => typeof c[0] === "string" && c[0].includes("/channels/"),
  );
  if (!call) return null;
  return String(call[0]).match(/\/channels\/([^/]+)\/messages/)?.[1] ?? null;
}

async function report(ctx: any, summary: string) {
  await reportPluginError(ctx, { source: "legacy-state", summary, companyId: TEST_COMPANY_ID });
}

beforeEach(() => {
  setPluginErrorSink(null);
  resetPluginErrorReports();
});

describe("degradation reports", () => {
  it("uses the configured errors channel over a saved discord-channel override", async () => {
    const { ctx, mockDiscordFetch } = buildPluginContext(
      { errorsChannelId: "ch-errors" },
      { "company:company-1:discord-channel": "ch-connected" },
    );
    await getSetup()(ctx);

    await report(ctx, "legacy read refused");

    expect(postedChannel(mockDiscordFetch)).toBe("ch-errors");
  });

  it("uses the configured errors channel over a companyChannels entry", async () => {
    const { ctx, mockDiscordFetch } = buildPluginContext({
      errorsChannelId: "ch-errors",
      companyChannels: { [TEST_COMPANY_ID]: "ch-company" },
    });
    await getSetup()(ctx);

    await report(ctx, "legacy read refused");

    expect(postedChannel(mockDiscordFetch)).toBe("ch-errors");
  });

  it("applies general routing when no errors channel is configured", async () => {
    const { ctx, mockDiscordFetch } = buildPluginContext(
      { errorsChannelId: "" },
      { "company:company-1:discord-channel": "ch-connected" },
    );
    await getSetup()(ctx);

    await report(ctx, "legacy read refused");

    expect(postedChannel(mockDiscordFetch)).toBe("ch-connected");
  });

  it("falls back to the default channel when neither is configured", async () => {
    const { ctx, mockDiscordFetch } = buildPluginContext({ errorsChannelId: "" });
    await getSetup()(ctx);

    await report(ctx, "legacy read refused");

    expect(postedChannel(mockDiscordFetch)).toBe("ch-default");
  });
});
