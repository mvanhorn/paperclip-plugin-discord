import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Company-scoped config bootstrap — issues #61, #72.
//
// Since paperclipai/paperclip#9557 (first stable in v2026.720.0) the SDK's
// governed-access gate requires a company scope for `config.get` and
// `secrets.resolve`; only `companies.list` is exempt. setup() runs outside any
// invocation, so a bare `ctx.config.get()` there throws and the worker dies on
// activation — which is exactly what every plugin used to do.
//
// These tests pin the behaviour on the three host generations the plugin has to
// survive. The mocks copy the real host where it bites:
//   - an unscoped `config.get()` THROWS, it never returns `{}` (telegram #83);
//   - `secrets.resolve` REJECTS every string secretRef and interpolates the
//     rejected value into its error (plugin-secrets-handler.ts);
//   - with `enforceInvocationScope`, a scoped read succeeds only for the company
//     the current host->worker invocation is bound to (720/722 semantics);
//   - the gateway mock RETAINS the callbacks and options it was handed, so tests
//     can invoke the real handlers the plugin installed.
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

type GatewayConnect = {
  token: string;
  onInteraction: (interaction: unknown) => Promise<unknown>;
  onMessage?: (message: any) => Promise<void> | void;
  options: any;
  closed: boolean;
  /** The simulated host invocation visible to the gateway when it connected. */
  invocationAtConnect: unknown;
};

const { gatewayConnects, gatewayCloses } = vi.hoisted(() => ({
  gatewayConnects: [] as any[],
  gatewayCloses: { count: 0 },
}));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (
    _ctx: any,
    token: string,
    onInteraction: any,
    onMessage: any,
    options: any,
  ) => {
    const record: GatewayConnect = {
      token,
      onInteraction,
      onMessage,
      options,
      closed: false,
      invocationAtConnect: invocationStore.getStore(),
    };
    gatewayConnects.push(record);
    return {
      close: () => {
        record.closed = true;
        gatewayCloses.count += 1;
      },
    };
  }),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";

// Stands in for the SDK's invocation context: the SDK runs each host call
// inside an AsyncLocalStorage store and stamps every worker→host request made
// within it with that invocation's id.
const invocationStore = new AsyncLocalStorage<{ id: string }>();
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const ROTATED_SECRET_ID = "44444444-4444-4444-4444-444444444444";

/** Verbatim shape of the errors the governed host raises. */
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';
const SCOPED_CONFIG_DENIED =
  'not allowed to perform "config.get": company context is required';
const PRE_720_SECRET_KILL_SWITCH =
  "Plugin secret references are disabled on this host";

/** Connections the plugin has opened and not closed. */
function liveGateways(): GatewayConnect[] {
  return (gatewayConnects as GatewayConnect[]).filter((g) => !g.closed);
}

/** The stored config row the settings picker produces. */
function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "1490608926423646298",
    defaultGuildId: "",
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableInbound: false,
    enableCommands: false,
    digestMode: "off",
    ...overrides,
  };
}

type HostOptions = {
  /** Companies `companies.list()` reports (it is exempt from the scope gate). */
  companies?: string[];
  /** `companies.list()` itself fails. */
  companiesThrow?: boolean;
  /** Stored config rows, by company id. A missing row models a fresh install. */
  rows?: Record<string, Record<string, unknown>>;
  /** A 720/722 host: even an explicitly scoped read is denied. */
  denyScopedConfig?: boolean;
  /** A pre-720 host: the secret-ref kill switch is still in place. */
  secretsKillSwitch?: boolean;
  /**
   * Model the 720/722 invocation scope: a scoped read succeeds only for the
   * company the CURRENT invocation is bound to, and is denied outright outside
   * any invocation — which is where setup() runs.
   */
  enforceInvocationScope?: boolean;
  /** Resolve the bot token to this value. */
  token?: string;
};

function buildHost(options: HostOptions = {}) {
  const {
    companies = [COMPANY_A],
    companiesThrow = false,
    rows = { [COMPANY_A]: storedConfig() },
    denyScopedConfig = false,
    secretsKillSwitch = false,
    enforceInvocationScope = false,
    token = "discord-bot-token",
  } = options;

  const unscopedConfigReads: number[] = [];
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();
  let invocationScope: string | null = null;
  let secretResolutionGate: Promise<void> | null = null;
  let releaseGate: () => void = () => {};

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) {
          // A governed host NEVER answers an unscoped read.
          unscopedConfigReads.push(1);
          throw new Error(UNSCOPED_CONFIG_ERROR);
        }
        if (enforceInvocationScope) {
          if (!invocationScope) throw new Error(UNSCOPED_CONFIG_ERROR);
          if (companyId !== invocationScope) {
            throw new Error(
              `requested company "${companyId}" but the current invocation is scoped to company "${invocationScope}"`,
            );
          }
        }
        if (denyScopedConfig) throw new Error(SCOPED_CONFIG_DENIED);
        return rows[companyId] ?? {};
      }),
    },
    secrets: {
      resolve: vi.fn(async (secretRef: unknown) => {
        // Mirrors the real host: every string secretRef is rejected, and the
        // rejected value is interpolated into the error message.
        if (typeof secretRef === "string") {
          throw new Error(
            `Invalid secret reference for plugin: ${secretRef}. Use { type: "secret_ref", secretId, version? }`,
          );
        }
        if (secretsKillSwitch) throw new Error(PRE_720_SECRET_KILL_SWITCH);
        if (secretResolutionGate) await secretResolutionGate;
        return token;
      }),
    },
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
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: {
      // Honours limit/offset like the host, so a walk that only reads the first
      // page is visible as a wrong answer rather than passing by accident.
      list: vi.fn(async (input?: { limit?: number; offset?: number }) => {
        if (companiesThrow) throw new Error("companies.list is unavailable");
        // Like the host: re-run the whole query, then window it in memory.
        const all = companies.map((id) => ({ id, name: `Company ${id.slice(0, 4)}` }));
        if (!input?.limit) return all;
        const offset = input.offset ?? 0;
        return all.slice(offset, offset + input.limit);
      }),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: { fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })) },
  } as any;

  return {
    ctx,
    unscopedConfigReads,
    /** Deliver an event to the plugin as a real company-scoped invocation. */
    async emitEvent(eventType: string, companyId: string) {
      invocationScope = companyId;
      try {
        await this.deliverEvent(eventType, companyId);
      } finally {
        invocationScope = null;
      }
    },
    async deliverEvent(eventType: string, companyId: string) {
      for (const handler of eventHandlers.get(eventType) ?? []) {
        await handler({
          eventId: `evt-${Math.random().toString(36).slice(2)}`,
          eventType,
          companyId,
          entityId: "entity-1",
          entityType: "issue",
          occurredAt: new Date().toISOString(),
          payload: { title: "t", identifier: "T-1" },
        });
      }
    },
    /** Enter or leave a host->worker invocation bound to a company. */
    setInvocationScope(companyId: string | null) {
      invocationScope = companyId;
    },
    /**
     * The host's configChanged RPC: a company-scoped invocation carrying the
     * stored configuration. This is how a runtime starts on every host now.
     */
    async deliver(companyId: string, config: Record<string, unknown>, opts?: { withContext?: boolean }) {
      invocationScope = companyId;
      try {
        if (opts?.withContext === false) {
          await definition().onConfigChanged(config);
        } else {
          await definition().onConfigChanged(config, { companyId });
        }
      } finally {
        invocationScope = null;
      }
    },
    /** Hold every subsequent token resolution until releaseSecretResolution(). */
    deferSecretResolution() {
      secretResolutionGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    },
    releaseSecretResolution() {
      secretResolutionGate = null;
      releaseGate();
    },
    /** Everything the plugin published about itself, for leak assertions. */
    everythingSaid(diagnostics: unknown) {
      return JSON.stringify([
        diagnostics,
        ctx.logger.warn.mock.calls,
        ctx.logger.error.mock.calls,
        ctx.logger.info.mock.calls,
        ctx.logger.debug.mock.calls,
      ]);
    },
  };
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  gatewayCloses.count = 0;
  vi.clearAllMocks();
});

describe("host matrix: pre-2026.720.0 (secret-ref kill switch)", () => {
  it("keeps the worker activated, degrades health, and reports the host's real error", async () => {
    const host = buildHost({ secretsKillSwitch: true });

    await expect(definition().setup(host.ctx)).resolves.toBeUndefined();
    await host.deliver(COMPANY_A, storedConfig());

    expect(_getRuntimeForTests()).toBeNull();
    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toContain(PRE_720_SECRET_KILL_SWITCH);
    expect(diagnostics.details).toMatchObject({ issue: "discord-bot-token-unresolved" });
  });
});

describe("host matrix: 2026.720.0 / 2026.722.0 (every scoped read denied)", () => {
  it("setup() completes and health is degraded, without the plugin reading config unscoped", async () => {
    const { ctx, unscopedConfigReads } = buildHost({ denyScopedConfig: true });

    await expect(definition().setup(ctx)).resolves.toBeUndefined();

    expect(unscopedConfigReads).toHaveLength(0);
    expect(ctx.config.get).not.toHaveBeenCalledWith();
    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).status).toBe("degraded");
  });

  it("bootstraps from the host's config delivery, with no worker restart", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    expect(_getRuntimeForTests()).toBeNull();

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(gatewayConnects).toHaveLength(1);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("resolves the bot token with the company scope and the config path", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      { companyId: COMPANY_A, configPath: "discordBotTokenRef" },
    );
  });

  it("canonicalizes a legacy bare-UUID reference into the object binding the host requires", async () => {
    // Current hosts reject EVERY string handed to secrets.resolve, so an older
    // configuration only keeps working if the plugin converts it before resolving.
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig({ discordBotTokenRef: SECRET_ID }), {
      companyId: COMPANY_A,
    });

    expect(_getRuntimeForTests()?.tokenSecretId).toBe(SECRET_ID);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      { companyId: COMPANY_A, configPath: "discordBotTokenRef" },
    );
  });

  it("refuses a non-UUID string without echoing the supplied value anywhere", async () => {
    // The host's Ajv secret-ref format accepts any string and its extractor
    // rejects only UUID-shaped ones, so a pasted raw bot token CAN reach stored
    // config. It must never be resolved, and never appear in health or logs.
    const RAW = "RAW_SECRET_SENTINEL_do_not_leak";
    const host = buildHost({ denyScopedConfig: true });
    await definition().setup(host.ctx);
    await definition().onConfigChanged(storedConfig({ discordBotTokenRef: RAW }), {
      companyId: COMPANY_A,
    });

    expect(_getRuntimeForTests()).toBeNull();
    expect(host.ctx.secrets.resolve).not.toHaveBeenCalled();

    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toMatch(/discordBotTokenRef/);
    expect(host.everythingSaid(diagnostics)).not.toContain(RAW);
  });

  it("scrubs a supplied reference back out of a host error before publishing it", async () => {
    // The host interpolates the reference it rejected into its error message.
    // Whatever we handed it must not travel back out through health or the logs.
    const SUPPLIED_ID = "99999999-9999-4999-8999-999999999999";
    const host = buildHost({ denyScopedConfig: true });
    host.ctx.secrets.resolve.mockImplementation(async (ref: unknown) => {
      throw new Error(
        `Invalid secret reference for plugin: ${JSON.stringify(ref)}. Use { type: "secret_ref", secretId, version? }`,
      );
    });
    await definition().setup(host.ctx);
    await definition().onConfigChanged(
      storedConfig({ discordBotTokenRef: { type: "secret_ref", secretId: SUPPLIED_ID } }),
      { companyId: COMPANY_A },
    );

    const diagnostics = await definition().onHealth();
    const said = host.everythingSaid(diagnostics);
    expect(said).not.toContain(SUPPLIED_ID);
    expect(said).toContain("[redacted]");
  });

  it("identifies the delivered company by scoped probe, not by list order", async () => {
    // The v2026.720/722 SDKs call onConfigChanged(config) with NO context, but the
    // host still scopes the invocation to the real company and denies a read for
    // any other one. Guessing companies[0] asks for the wrong company and gets
    // denied, even though a perfectly good config was just delivered.
    const host = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      rows: { [COMPANY_B]: storedConfig() },
      enforceInvocationScope: true,
    });
    await definition().setup(host.ctx);
    expect(_getRuntimeForTests()).toBeNull();

    host.setInvocationScope(COMPANY_B);
    // Legacy one-argument delivery: no context object at all.
    await definition().onConfigChanged(storedConfig());
    host.setInvocationScope(null);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
    expect(host.ctx.secrets.resolve).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_B,
      configPath: "discordBotTokenRef",
    });
  });

  it("leaves the running company untouched when a context-less delivery belongs to another", async () => {
    // A is running. On 720/722 a save for B arrives with no context, inside an
    // invocation scoped to B. Treating it as A's delivery attempts an A-scoped
    // resolution the host denies, degrading a perfectly healthy runtime.
    const host = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      rows: { [COMPANY_A]: storedConfig(), [COMPANY_B]: storedConfig() },
      enforceInvocationScope: true,
    });

    // Bring A up through its own scoped delivery.
    host.setInvocationScope(COMPANY_A);
    await definition().setup(host.ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
    const gatewaysAfterA = liveGateways().length;

    // Now B saves, context-less, inside B's invocation.
    host.setInvocationScope(COMPANY_B);
    await definition().onConfigChanged(storedConfig({ defaultChannelId: "1490610083728588950" }));
    host.setInvocationScope(null);

    // A is untouched: same company, same gateway, still healthy.
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("1490608926423646298");
    expect(liveGateways()).toHaveLength(gatewaysAfterA);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`ignoring configuration for company ${COMPANY_B}`),
      expect.objectContaining({ runningCompanyId: COMPANY_A, deliveredCompanyId: COMPANY_B }),
    );
  });

  it("degrades with a clear message when no company scope can be identified", async () => {
    const { ctx } = buildHost({ companies: [COMPANY_A, COMPANY_B], denyScopedConfig: true });
    await definition().setup(ctx);

    await definition().onConfigChanged(storedConfig(), { companyId: null });

    expect(_getRuntimeForTests()).toBeNull();
    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toMatch(/company/i);
  });
});

describe("host matrix: >= 2026.817.0 (host replays stored configuration)", () => {
  it("starts from the host's startup replay, with no company walk of its own", async () => {
    // The plugin does not go looking for an owner. From v2026.817.0 the host
    // replays each stored configuration row to the fresh worker; the first one
    // to arrive owns this install.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });

    await definition().setup(host.ctx);
    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).status).toBe("degraded");
    // setup() reads nothing at all: it has no scope to read with.
    expect(host.ctx.config.get).not.toHaveBeenCalled();
    expect(host.ctx.companies.list).not.toHaveBeenCalled();

    await host.deliver(COMPANY_A, storedConfig());

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("keeps the first replayed company and refuses a different one", async () => {
    // Ordered replay A then B with DISTINCT configs: A owns the install and B is
    // refused, exactly as the host's own single-tenant guard would.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    await host.deliver(COMPANY_A, storedConfig());
    await host.deliver(COMPANY_B, storedConfig({ defaultChannelId: "1490610083728588950" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("1490608926423646298");
    expect(liveGateways()).toHaveLength(1);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_A}`),
      expect.objectContaining({ deliveredCompanyId: COMPANY_B }),
    );
  });

  it("advances the owner on an identical configuration, as the host's guard does", async () => {
    // The SDK's single-tenant guard ACCEPTS an identical config under a different
    // company and records that company. Migration 0164 duplicated each unbound
    // legacy plugin config across every company, so this is deployed state. If
    // the plugin refused it, the plugin would own A while the SDK owns B — the
    // exact split the ownership rule exists to prevent.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    const duplicated = storedConfig();
    await host.deliver(COMPANY_A, duplicated);
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);

    await host.deliver(COMPANY_B, { ...duplicated });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
    expect(host.ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("owner advancing"),
      expect.objectContaining({ previousCompanyId: COMPANY_A, companyId: COMPANY_B }),
    );

    // A's own later, CHANGED config is now a different company's config.
    await host.deliver(COMPANY_A, storedConfig({ defaultChannelId: "1490610083728588950" }));
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);

    // B's saves still apply.
    await host.deliver(COMPANY_B, { ...duplicated, defaultChannelId: "1490610083728588950" });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("1490610083728588950");
  });

  it("does not bootstrap from an invocation: only a delivery starts the runtime", async () => {
    // An invocation cannot establish ownership the host agrees with: `config.get`
    // does not move the SDK's recorded company, and on a fresh install probing
    // would adopt an empty `{}` row while the SDK's owner stays null.
    const host = buildHost({ companies: [COMPANY_A], enforceInvocationScope: true });
    await definition().setup(host.ctx);

    await host.emitEvent("issue.created", COMPANY_A);

    expect(_getRuntimeForTests()).toBeNull();
    expect(host.ctx.config.get).not.toHaveBeenCalled();
    expect(host.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect((await definition().onHealth()).status).toBe("degraded");

    // The delivery is what starts it.
    await host.deliver(COMPANY_A, storedConfig());
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("never lets a foreign invocation join a delivery already in flight", async () => {
    // On an ownerless worker, a B invocation must not ride along on A's pending
    // bootstrap and act with A's runtime once it resolves. Observed where it
    // matters: whether anything is sent to Discord for B.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    host.deferSecretResolution();
    const delivery = host.deliver(COMPANY_A, storedConfig({ notifyOnIssueCreated: true }));
    const inFlightEvent = host.emitEvent("issue.created", COMPANY_B);

    host.releaseSecretResolution();
    await Promise.all([delivery, inFlightEvent]);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    const discordCalls = host.ctx.http.fetch.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
    );
    expect(discordCalls).toHaveLength(0);

    // And afterwards, with A live, B is still refused.
    host.ctx.http.fetch.mockClear();
    await host.emitEvent("issue.created", COMPANY_B);
    expect(
      host.ctx.http.fetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/"),
      ),
    ).toHaveLength(0);
  });

  it("refuses a non-owner invocation without reading or changing health", async () => {
    const host = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      enforceInvocationScope: true,
    });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig({ discordBotTokenRef: "" }));
    expect(_getRuntimeForTests()).toBeNull();
    const healthAfterOwnerFailure = await definition().onHealth();
    expect(healthAfterOwnerFailure.details).toMatchObject({ companyId: COMPANY_A });

    host.ctx.config.get.mockClear();
    await host.emitEvent("issue.created", COMPANY_B);

    expect(host.ctx.config.get).not.toHaveBeenCalled();
    expect(await definition().onHealth()).toEqual(healthAfterOwnerFailure);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_A}`),
      expect.objectContaining({ invokingCompanyId: COMPANY_B }),
    );

    // The owner recovers on its next valid delivery, not on an invocation.
    await host.deliver(COMPANY_A, storedConfig());
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
  });

  it("recovers the owner on its next valid save after a failed bootstrap", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    await host.deliver(COMPANY_A, storedConfig({ discordBotTokenRef: "" }));
    expect(_getRuntimeForTests()).toBeNull();

    await host.deliver(COMPANY_A, storedConfig());

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("lets the first delivered company own a fresh install", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B], rows: {} });
    await definition().setup(host.ctx);

    await host.deliver(COMPANY_B, storedConfig());
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);

    // A cannot take it over with a different configuration.
    await host.deliver(COMPANY_A, storedConfig({ defaultChannelId: "1490610083728588950" }));
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
  });
});


describe("gateway invocation context", () => {
  it("opens the gateway outside the configChanged invocation that started it", async () => {
    // The host retires a call's invocation once the call settles. A gateway
    // opened inside configChanged would hand that id to every callback it
    // schedules, and the host would deny each later call as an expired scope.
    const host = buildHost();
    await definition().setup(host.ctx);

    await invocationStore.run({ id: "config-changed-call" }, () =>
      host.deliver(COMPANY_A, storedConfig()),
    );

    expect(gatewayConnects).toHaveLength(1);
    expect(gatewayConnects[0].invocationAtConnect).toBeUndefined();
  });
});

describe("re-bootstrap on configuration changes", () => {
  it("keeps the live gateway when the same company saves an unchanged token", async () => {
    const host = buildHost();
    const { ctx } = host;
    await definition().setup(ctx);
    await host.deliver(COMPANY_A, storedConfig());
    expect(gatewayConnects).toHaveLength(1);

    await host.deliver(COMPANY_A, storedConfig({ defaultChannelId: "999999999999999999" }));

    expect(gatewayConnects).toHaveLength(1);
    expect(gatewayCloses.count).toBe(0);
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("999999999999999999");
  });

  it("keeps the runtime object identity so a reused gateway sees the new config", async () => {
    // The gateway's callbacks are created once, at connect time. If a same-token
    // save swapped in a NEW runtime object, those callbacks would keep serving the
    // superseded configuration for the life of the connection.
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    const before = _getRuntimeForTests();

    await host.deliver(COMPANY_A, storedConfig({ paperclipBaseUrl: "http://example.invalid:9999" }));

    const after = _getRuntimeForTests();
    expect(after).toBe(before);
    expect(after?.baseUrl).toBe("http://example.invalid:9999");
    expect(after?.cmdCtx.baseUrl).toBe("http://example.invalid:9999");
    expect(gatewayConnects).toHaveLength(1);
  });

  it("reconnects when the message-intent set changes, in both directions", async () => {
    // Intents are fixed when the socket identifies. Turning inbound handling on
    // over a connection that never asked for message intents does nothing at all.
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig({ enableInbound: false }));
    expect(gatewayConnects).toHaveLength(1);
    expect(gatewayConnects[0].options.listenForMessages).toBe(false);

    await host.deliver(COMPANY_A, storedConfig({ enableInbound: true }));
    expect(gatewayConnects).toHaveLength(2);
    expect(gatewayConnects[1].options.listenForMessages).toBe(true);
    expect(liveGateways()).toHaveLength(1);

    await host.deliver(COMPANY_A, storedConfig({ enableInbound: false }));
    expect(gatewayConnects).toHaveLength(3);
    expect(gatewayConnects[2].options.listenForMessages).toBe(false);
    expect(liveGateways()).toHaveLength(1);
  });

  it("tears the gateway down and reconnects when the bot token changes", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    host.ctx.secrets.resolve.mockResolvedValue("rotated-discord-bot-token");

    await host.deliver(
      COMPANY_A,
      storedConfig({ discordBotTokenRef: { type: "secret_ref", secretId: ROTATED_SECRET_ID } }),
    );

    expect(gatewayCloses.count).toBe(1);
    expect(gatewayConnects).toHaveLength(2);
    expect(gatewayConnects[1].token).toBe("rotated-discord-bot-token");
    expect(liveGateways()).toHaveLength(1);
  });

  it("reconnects an unchanged token when the gateway failed permanently (#71)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());

    // Drive the REAL onPermanentFailure the plugin installed, not a hand-set flag:
    // a callback bound to a stale runtime would mark the wrong object.
    liveGateways()[0].options.onPermanentFailure("Discord refused the token (4004)", { code: 4004 });

    expect(_getRuntimeForTests()?.gatewayFailed).toBe(true);
    expect((await definition().onHealth()).status).toBe("degraded");

    await host.deliver(COMPANY_A, storedConfig());

    expect(gatewayConnects).toHaveLength(2);
    expect(liveGateways()).toHaveLength(1);
    expect(_getRuntimeForTests()?.gatewayFailed).toBe(false);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("serializes two back-to-back saves into exactly one live gateway", async () => {
    // Nothing serializes host->worker requests: the SDK's RPC reader dispatches
    // without awaiting the previous call. Two saves whose token resolution is
    // still pending can both reach connectGateway and leak one of the connections.
    const host = buildHost({ rows: {} });
    await definition().setup(host.ctx);
    expect(_getRuntimeForTests()).toBeNull();

    host.deferSecretResolution();
    const first = definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    const second = definition().onConfigChanged(
      storedConfig({ defaultChannelId: "1490610083728588950" }),
      { companyId: COMPANY_A },
    );
    host.releaseSecretResolution();
    await Promise.all([first, second]);

    expect(liveGateways()).toHaveLength(1);
    // Last delivery wins.
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("1490610083728588950");
  });

  it("serializes a save that rotates the token against the save before it", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    expect(liveGateways()).toHaveLength(1);

    host.deferSecretResolution();
    host.ctx.secrets.resolve.mockImplementation(async (ref: unknown) => {
      if (typeof ref === "string") throw new Error("string refs are rejected by the host");
      return (ref as any).secretId === SECRET_ID ? "discord-bot-token" : "rotated-token";
    });
    const first = definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    const second = definition().onConfigChanged(
      storedConfig({ discordBotTokenRef: { type: "secret_ref", secretId: ROTATED_SECRET_ID } }),
      { companyId: COMPANY_A },
    );
    host.releaseSecretResolution();
    await Promise.all([first, second]);

    expect(liveGateways()).toHaveLength(1);
    expect(liveGateways()[0].token).toBe("rotated-token");
    expect(_getRuntimeForTests()?.token).toBe("rotated-token");
  });

  it("does not open a second gateway when a save races an in-flight bootstrap", async () => {
    const { ctx } = buildHost();
    let releaseWalk: () => void = () => {};
    const walkGate = new Promise<void>((resolve) => { releaseWalk = resolve; });
    const rows: Record<string, unknown> = { [COMPANY_A]: storedConfig() };
    ctx.config.get.mockImplementation(async (companyId?: string) => {
      if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
      await walkGate;
      return rows[companyId] ?? {};
    });

    const setupPromise = definition().setup(ctx);
    const deliveryPromise = (async () => {
      releaseWalk();
      await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    })();
    await Promise.all([setupPromise, deliveryPromise]);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(liveGateways()).toHaveLength(1);
  });

  it("stays bound to the running company when another company's config arrives", async () => {
    const host = buildHost();
    const { ctx } = host;
    await definition().setup(ctx);
    await host.deliver(COMPANY_A, storedConfig());

    await host.deliver(COMPANY_B, storedConfig({ defaultChannelId: "1490610083728588950" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(gatewayConnects).toHaveLength(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_A}`),
      expect.objectContaining({ runningCompanyId: COMPANY_A, deliveredCompanyId: COMPANY_B }),
    );
  });
});

describe("host-authoritative company scoping", () => {
  it("ignores a caller-supplied companyId in escalate_to_human", async () => {
    // The dispatcher forwards tool parameters unchanged and supplies the
    // authenticated company separately, so a `companyId` argument is an
    // unauthenticated claim. Owner is B; company A invokes the tool claiming B.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_B, storedConfig({ enableEscalations: true }));
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);

    const escalate = host.ctx.tools.register.mock.calls.find(
      (call: any[]) => call[0] === "escalate_to_human",
    )![2];
    const result = await escalate(
      { companyId: COMPANY_B, agentName: "agent", reason: "why" },
      { companyId: COMPANY_A },
    );

    expect(result.error).toBeDefined();
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_B}`),
      expect.objectContaining({ invokingCompanyId: COMPANY_A }),
    );
  });

  it("runs jobs against the owner's data, not a stale instance default", async () => {
    // `resolveCompanyId` reads an instance-level default that has nothing to do
    // with ownership. Pairing its company's data with the owner's Discord
    // connection is how one company's budgets got posted with another's token.
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_B, storedConfig());

    // A stale instance default pointing at the other company.
    await host.ctx.state.set({ scopeKind: "instance", stateKey: "company_default" }, {
      companyId: COMPANY_A,
    });

    const budgetJob = host.ctx.jobs.register.mock.calls.find(
      (call: any[]) => call[0] === "check-budget-thresholds",
    )![1];
    await budgetJob();

    expect(host.ctx.agents.list).toHaveBeenCalledWith({ companyId: COMPANY_B });
    expect(host.ctx.agents.list).not.toHaveBeenCalledWith({ companyId: COMPANY_A });
  });
});

describe("registration contract", () => {
  it("registers every handler during setup(), before any config is readable", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });

    await definition().setup(ctx);

    // The SDK requires registrations to complete synchronously within setup(),
    // so they cannot be gated on config the plugin is not allowed to read yet.
    const jobKeys = ctx.jobs.register.mock.calls.map((call: any[]) => call[0]);
    expect(jobKeys).toEqual(
      expect.arrayContaining([
        "check-escalation-timeouts",
        "check-budget-thresholds",
        "check-watches",
        "discord-daily-digest",
        "discord-intelligence-scan",
      ]),
    );

    const toolNames = ctx.tools.register.mock.calls.map((call: any[]) => call[0]);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "escalate_to_human",
        "handoff_to_agent",
        "discuss_with_agent",
        "register_custom_command",
        "register_watch",
        "discord_signals",
      ]),
    );

    const actionNames = ctx.actions.register.mock.calls.map((call: any[]) => call[0]);
    expect(actionNames).toEqual(expect.arrayContaining(["set-channel", "trigger-backfill"]));
  });

  it("tools answer with a clear not-configured error until the runtime exists", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    const escalate = ctx.tools.register.mock.calls.find((call: any[]) => call[0] === "escalate_to_human")![2];
    const result = await escalate(
      { companyId: COMPANY_A, agentName: "agent", reason: "why" },
      { companyId: COMPANY_A },
    );

    expect(result.error).toMatch(/not configured yet/);
  });
});
