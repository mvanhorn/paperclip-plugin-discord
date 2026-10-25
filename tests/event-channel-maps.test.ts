import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { PLUGIN_ID } from "../src/constants.js";

/**
 * Tests for the event-specific per-company channel maps:
 *   - errorsChannels       → agent.run.failed + budget-warning job
 *   - escalationsChannels  → escalation-created event + escalate_to_human tool
 *   - pipelineChannels     → agent.run.started / agent.run.finished
 *   - digestChannels       → daily/bidaily/tridaily digest job
 *
 * Each map follows the same contract as the existing `approvalsChannels` map.
 * Resolution precedence (resolveChannel): state override → event-specific map
 * → companyChannels → global fallback channel id.
 *
 * These drive the real worker setup() and fire the real event/job/tool
 * handlers, asserting the Discord channel actually posted to (via the fetch
 * URL) rather than unit-testing the private resolver in isolation.
 */

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

import { _resetRuntimeForTests } from "../src/worker.js";

/** The company whose scoped config the mock host delivers. */
const COMPANY = "company-1";
const ESCALATION_EVENT = `plugin.${PLUGIN_ID}.escalation-created`;
/** What a host >= v2026.720.0 throws for an unscoped `ctx.config.get()`. */
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

/**
 * Mount the plugin the way a governed host does (paperclipai/paperclip#9557):
 * setup() runs with NO company scope, then the host delivers company-scoped
 * config via onConfigChanged, which bootstraps the runtime.
 */
function getSetup(): (ctx: any) => Promise<void> {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  const definition = capturedDefinitions[capturedDefinitions.length - 1];
  return async (ctx: any) => {
    _resetRuntimeForTests();
    await definition.setup(ctx);
    await definition.onConfigChanged?.(ctx.__testConfig ?? {}, { companyId: COMPANY });
  };
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const jobHandlers = new Map<string, () => Promise<void>>();
  const toolHandlers = new Map<string, (params: any, runCtx: any) => Promise<any>>();
  let discordMessageCount = 0;

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-default",
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
    companyChannels: {},
    approvalsChannels: {},
    errorsChannels: {},
    escalationsChannels: {},
    pipelineChannels: {},
    digestChannels: {},
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
    jobs: {
      register: vi.fn().mockImplementation((name: string, fn: () => Promise<void>) => {
        jobHandlers.set(name, fn);
      }),
    },
    tools: {
      register: vi.fn().mockImplementation((name: string, defOrFn: any, maybeFn?: any) => {
        const fn = typeof maybeFn === "function" ? maybeFn : defOrFn;
        if (typeof fn === "function") toolHandlers.set(name, fn);
      }),
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
        return () => {};
      }),
    },
    companies: { list: vi.fn().mockResolvedValue([{ id: COMPANY, name: "Test Co" }]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, jobHandlers, toolHandlers, mockDiscordFetch };
}

function makeEvent(eventType: string, eventId: string, payload: Record<string, unknown> = {}): any {
  return {
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    companyId: COMPANY,
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

/** The channel id the plugin actually posted to (from the Discord fetch URL). */
function postedChannel(mockDiscordFetch: ReturnType<typeof vi.fn>): string | undefined {
  const call = mockDiscordFetch.mock.calls.find(
    (c: any[]) => typeof c[0] === "string" && c[0].includes("/channels/"),
  );
  if (!call) return undefined;
  const match = /\/channels\/([^/]+)\//.exec(call[0] as string);
  return match?.[1];
}

let evtSeq = 0;
function nextEvtId(prefix: string): string {
  return `${prefix}-${++evtSeq}`;
}

describe("event-specific channel maps", () => {
  // ----------------------------------------------------------------- errors
  describe("errorsChannels — agent.run.failed", () => {
    it("routes to the per-company errorsChannels entry", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnAgentError: true,
        errorsChannelId: "ch-errors-global",
        errorsChannels: { [COMPANY]: "ch-errors-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.failed", makeEvent("agent.run.failed", nextEvtId("err")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-errors-co1");
    });

    it("falls back to the global errorsChannelId when the company is unmapped", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnAgentError: true,
        errorsChannelId: "ch-errors-global",
        errorsChannels: { "some-other-company": "ch-errors-other" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.failed", makeEvent("agent.run.failed", nextEvtId("err")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-errors-global");
    });

    it("falls back to companyChannels when errorsChannels lacks the company", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnAgentError: true,
        errorsChannelId: "ch-errors-global",
        companyChannels: { [COMPANY]: "ch-company-general" },
        errorsChannels: {},
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.failed", makeEvent("agent.run.failed", nextEvtId("err")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-company-general");
    });

    it("honors the runtime state override above errorsChannels (full precedence)", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext(
        {
          notifyOnAgentError: true,
          errorsChannelId: "ch-errors-global",
          companyChannels: { [COMPANY]: "ch-company-general" },
          errorsChannels: { [COMPANY]: "ch-errors-co1" },
        },
        { [`company:${COMPANY}:discord-channel`]: "ch-state-override" },
      );
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.failed", makeEvent("agent.run.failed", nextEvtId("err")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-state-override");
    });
  });

  // ---------------------------------------------------------- errors (budget)
  describe("errorsChannels — budget warning job", () => {
    it("routes budget warnings to the per-company errorsChannels entry", async () => {
      const { ctx, jobHandlers, mockDiscordFetch } = buildPluginContext(
        {
          errorsChannelId: "ch-errors-global",
          errorsChannels: { [COMPANY]: "ch-errors-co1" },
        },
        {
          [`agent:agent-1:budget`]: { spent: 90, limit: 100 },
        },
      );
      ctx.agents.list = vi.fn().mockResolvedValue([{ id: "agent-1", name: "Agent One", status: "active" }]);
      await getSetup()(ctx);

      const job = jobHandlers.get("check-budget-thresholds");
      expect(job).toBeDefined();
      await job!();

      expect(postedChannel(mockDiscordFetch)).toBe("ch-errors-co1");
    });
  });

  // ------------------------------------------------------------- escalations
  describe("escalationsChannels — escalation-created event", () => {
    const escPayload = () => ({ escalationId: "esc-1", agentName: "Agent One", reason: "needs a human" });

    it("routes to the per-company escalationsChannels entry", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        enableEscalations: true,
        escalationChannelId: "ch-esc-global",
        escalationsChannels: { [COMPANY]: "ch-esc-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, ESCALATION_EVENT, makeEvent(ESCALATION_EVENT, nextEvtId("esc"), escPayload()));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-esc-co1");
    });

    it("falls back to the global escalationChannelId when unmapped", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        enableEscalations: true,
        escalationChannelId: "ch-esc-global",
        escalationsChannels: {},
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, ESCALATION_EVENT, makeEvent(ESCALATION_EVENT, nextEvtId("esc"), escPayload()));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-esc-global");
    });

    it("falls back to companyChannels before the global escalation channel", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        enableEscalations: true,
        escalationChannelId: "ch-esc-global",
        companyChannels: { [COMPANY]: "ch-company-general" },
        escalationsChannels: {},
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, ESCALATION_EVENT, makeEvent(ESCALATION_EVENT, nextEvtId("esc"), escPayload()));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-company-general");
    });
  });

  describe("escalationsChannels — escalate_to_human tool", () => {
    it("routes the tool's escalation to the per-company escalationsChannels entry", async () => {
      const { ctx, toolHandlers, mockDiscordFetch } = buildPluginContext({
        enableEscalations: true,
        escalationChannelId: "ch-esc-global",
        escalationsChannels: { [COMPANY]: "ch-esc-co1" },
      });
      await getSetup()(ctx);

      const tool = toolHandlers.get("escalate_to_human");
      expect(tool).toBeDefined();
      await tool!(
        { companyId: COMPANY, agentName: "Agent One", reason: "needs a human" },
        { companyId: COMPANY },
      );

      expect(postedChannel(mockDiscordFetch)).toBe("ch-esc-co1");
    });
  });

  // --------------------------------------------------------------- pipeline
  describe("pipelineChannels — agent.run.started / agent.run.finished", () => {
    it("routes agent.run.started to the per-company pipelineChannels entry", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        bdPipelineChannelId: "ch-pipe-global",
        pipelineChannels: { [COMPANY]: "ch-pipe-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.started", makeEvent("agent.run.started", nextEvtId("pipe")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-pipe-co1");
    });

    it("routes agent.run.finished to the per-company pipelineChannels entry", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        bdPipelineChannelId: "ch-pipe-global",
        pipelineChannels: { [COMPANY]: "ch-pipe-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.finished", makeEvent("agent.run.finished", nextEvtId("pipe")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-pipe-co1");
    });

    it("falls back to the global bdPipelineChannelId when unmapped", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        bdPipelineChannelId: "ch-pipe-global",
        pipelineChannels: {},
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.started", makeEvent("agent.run.started", nextEvtId("pipe")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-pipe-global");
    });
  });

  // ----------------------------------------------------------------- digest
  describe("digestChannels — daily digest job", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T09:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("routes the digest to the per-company digestChannels entry", async () => {
      const { ctx, jobHandlers, mockDiscordFetch } = buildPluginContext({
        digestMode: "daily",
        dailyDigestTime: "09:00",
        digestChannels: { [COMPANY]: "ch-digest-co1" },
      });
      await getSetup()(ctx);

      const job = jobHandlers.get("discord-daily-digest");
      expect(job).toBeDefined();
      await job!();

      expect(postedChannel(mockDiscordFetch)).toBe("ch-digest-co1");
    });

    it("falls back to defaultChannelId when the company is unmapped", async () => {
      const { ctx, jobHandlers, mockDiscordFetch } = buildPluginContext({
        digestMode: "daily",
        dailyDigestTime: "09:00",
        digestChannels: {},
      });
      await getSetup()(ctx);

      await jobHandlers.get("discord-daily-digest")!();

      expect(postedChannel(mockDiscordFetch)).toBe("ch-default");
    });
  });

  // ---------------------------- priority: event-specific map beats companyChannels
  // resolveChannel checks the event-specific map (step 2) BEFORE companyChannels
  // (step 3). These populate BOTH and set NO state override, so the event-specific
  // channel can only win if step 2 genuinely precedes step 3 — swapping the two
  // lookups makes every assertion in this block fail.
  describe("event-specific map wins over companyChannels (no state override)", () => {
    it("errorsChannels beats companyChannels for agent.run.failed", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnAgentError: true,
        errorsChannelId: "ch-errors-global",
        companyChannels: { [COMPANY]: "ch-company-general" },
        errorsChannels: { [COMPANY]: "ch-errors-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.failed", makeEvent("agent.run.failed", nextEvtId("err")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-errors-co1");
    });

    it("escalationsChannels beats companyChannels for escalation-created", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        enableEscalations: true,
        escalationChannelId: "ch-esc-global",
        companyChannels: { [COMPANY]: "ch-company-general" },
        escalationsChannels: { [COMPANY]: "ch-esc-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(
        eventHandlers,
        ESCALATION_EVENT,
        makeEvent(ESCALATION_EVENT, nextEvtId("esc"), { escalationId: "esc-1", agentName: "Agent One", reason: "needs a human" }),
      );

      expect(postedChannel(mockDiscordFetch)).toBe("ch-esc-co1");
    });

    it("pipelineChannels beats companyChannels for agent.run.started", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        bdPipelineChannelId: "ch-pipe-global",
        companyChannels: { [COMPANY]: "ch-company-general" },
        pipelineChannels: { [COMPANY]: "ch-pipe-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "agent.run.started", makeEvent("agent.run.started", nextEvtId("pipe")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-pipe-co1");
    });

    it("digestChannels beats companyChannels for the daily digest", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T09:00:00.000Z"));
      try {
        const { ctx, jobHandlers, mockDiscordFetch } = buildPluginContext({
          digestMode: "daily",
          dailyDigestTime: "09:00",
          companyChannels: { [COMPANY]: "ch-company-general" },
          digestChannels: { [COMPANY]: "ch-digest-co1" },
        });
        await getSetup()(ctx);

        await jobHandlers.get("discord-daily-digest")!();

        expect(postedChannel(mockDiscordFetch)).toBe("ch-digest-co1");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------- approvalsChannels regression
  describe("approvalsChannels (existing behavior stays green)", () => {
    it("routes approval.created to the per-company approvalsChannels entry", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnApprovalCreated: true,
        approvalsChannelId: "ch-approvals-global",
        approvalsChannels: { [COMPANY]: "ch-approvals-co1" },
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "approval.created", makeEvent("approval.created", nextEvtId("appr")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-approvals-co1");
    });

    it("falls back to the global approvalsChannelId when unmapped", async () => {
      const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
        notifyOnApprovalCreated: true,
        approvalsChannelId: "ch-approvals-global",
        approvalsChannels: {},
      });
      await getSetup()(ctx);

      await emitEvent(eventHandlers, "approval.created", makeEvent("approval.created", nextEvtId("appr")));

      expect(postedChannel(mockDiscordFetch)).toBe("ch-approvals-global");
    });
  });
});
