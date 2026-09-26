import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// The interactions webhook verifies Discord's Ed25519 signature FIRST.
//
// The Paperclip host deliberately leaves this route unauthenticated — its own
// comment says signature verification is the plugin's job — so before this
// check the author allowlist was reading `body.member.user.id`, a value the
// caller supplies. Anyone who could reach the URL could claim to be Hanna.
//
// Structure follows tests/author-allowlist.test.ts: capture the plugin
// definition through a vi.mock of the SDK, then drive onWebhook directly.
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
    const record: any = { token, onInteraction, onMessage, options, closed: false, close: () => { record.closed = true; } };
    gatewayConnects.push(record);
    return record;
  }),
}));

vi.mock("../src/voice/index.js", () => ({
  createPluginDiscordAdapter: () => () => ({ sendPayload: () => true, destroy: () => {} }),
  WhisperSTTAdapter: class MockWhisperSTTAdapter {
    transcribeUtterance = vi.fn().mockResolvedValue("");
  },
  get VoiceClient() {
    return class MockVoiceClient {
      constructor(_ctx: any, _config: any) {}
      async start() {}
      stop() {}
    };
  },
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const HANNA_ID = "999999999999999999";
const OTHER_ID = "111111111111111111";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

/** A real Ed25519 keypair, with the public key in the 64-char hex Discord publishes. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
}

/**
 * A signed timestamp the replay window accepts. Read off the real clock because
 * the worker path has no clock seam: it calls the verifier without one, so the
 * verifier uses `Date.now()`.
 */
function freshTimestamp(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function signedDelivery(
  privateKey: crypto.KeyObject,
  body: unknown,
  timestamp = freshTimestamp(),
) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: "discord-interactions",
    requestId: "req-1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: {
      "X-Signature-Ed25519": crypto
        .sign(null, Buffer.from(timestamp + rawBody, "utf8"), privateKey)
        .toString("hex"),
      "X-Signature-Timestamp": timestamp,
    },
  };
}

function unsignedDelivery(body: unknown, headers: Record<string, string | string[]> = {}) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: "discord-interactions",
    requestId: "req-1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers,
  };
}

function statusCommand(authorId: string) {
  return {
    id: "int-1",
    token: "tok",
    type: 2, // APPLICATION_COMMAND
    data: { name: "clip", options: [{ name: "status" }] },
    member: { user: { id: authorId, username: "someone" } },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function buildHost() {
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
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: { fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) },
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
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    hannaDiscordUserId: HANNA_ID,
    ...overrides,
  };
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

describe("interactions webhook — an unsigned or forged delivery is dropped", () => {
  it("drops a delivery that carries no signature headers at all", async () => {
    const { publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const response = await definition().onWebhook(unsignedDelivery(statusCommand(HANNA_ID)));

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.ctx.http.fetch).not.toHaveBeenCalled();
    expect(host.ctx.agents.invoke).not.toHaveBeenCalled();
  });

  it("drops a delivery whose signature is forged with another keypair", async () => {
    const configured = keypair();
    const attacker = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: configured.publicKeyHex }));
    vi.clearAllMocks();

    const response = await definition().onWebhook(
      signedDelivery(attacker.privateKey, statusCommand(HANNA_ID)),
    );

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("drops a delivery whose body was changed after it was signed", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    // Signed as Eve, then rewritten to claim Hanna: the allowlist would have
    // believed the rewrite, the signature does not.
    const delivery = signedDelivery(privateKey, statusCommand(OTHER_ID));
    delivery.rawBody = JSON.stringify(statusCommand(HANNA_ID));
    delivery.parsedBody = JSON.parse(delivery.rawBody);

    const response = await definition().onWebhook(delivery);

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a delivery signed over a different timestamp than the header carries", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const delivery = signedDelivery(privateKey, statusCommand(HANNA_ID));
    // One second off the signed value: inside the replay window, so this tests
    // the signature and not the window.
    delivery.headers["X-Signature-Timestamp"] = freshTimestamp(1);

    expect(await definition().onWebhook(delivery)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the refusal at warn, with no signature material in the message", async () => {
    const configured = keypair();
    const attacker = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: configured.publicKeyHex }));
    vi.clearAllMocks();

    const delivery = signedDelivery(attacker.privateKey, statusCommand(HANNA_ID));
    await definition().onWebhook(delivery);

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("signature"),
      expect.anything(),
    );
    const logged = JSON.stringify(host.ctx.logger.warn.mock.calls);
    expect(logged).not.toContain(delivery.headers["X-Signature-Ed25519"]);
    expect(logged).not.toContain(configured.publicKeyHex);
    expect(logged).not.toContain("main-bot-token");
  });
});

describe("interactions webhook — a verified delivery reaches the existing handler", () => {
  it("runs the author allowlist after the signature check, and handles Hanna's command", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const response: any = await definition().onWebhook(
      signedDelivery(privateKey, statusCommand(HANNA_ID)),
    );

    expect(response).toBeDefined();
    expect(JSON.stringify(response)).not.toContain("configured operator");
  });

  it("still refuses a verified delivery from an author who is not Hanna", async () => {
    // The signature proves Discord sent it, not that the right person clicked.
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const response: any = await definition().onWebhook(
      signedDelivery(privateKey, statusCommand(OTHER_ID)),
    );

    expect(response.data.content).toContain("configured operator");
    expect(response.data.flags).toBe(64);
  });

  it("reads lowercase signature headers as well as Discord's own casing", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const delivery = signedDelivery(privateKey, statusCommand(HANNA_ID));
    const lowered = {
      ...delivery,
      headers: {
        "x-signature-ed25519": delivery.headers["X-Signature-Ed25519"],
        "x-signature-timestamp": delivery.headers["X-Signature-Timestamp"],
      },
    };

    const response: any = await definition().onWebhook(lowered);
    expect(response).toBeDefined();
    expect(JSON.stringify(response)).not.toContain("configured operator");
  });
});

describe("interactions webhook — fails closed with no public key configured", () => {
  it("drops an otherwise valid signed delivery and degrades health", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());
    vi.clearAllMocks();

    const response = await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-interactions-unverified" });
    expect(String(health.message)).toContain("discordPublicKey");
  });

  it("adds no health note at bootstrap, because most installs take the gateway path", async () => {
    // A gateway install needs no public key; a bootstrap note would be noise.
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    const health = await definition().onHealth();
    expect(health.details?.issue).not.toBe("discord-interactions-unverified");
  });

  it("an empty public key is treated as unset", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: "   " }));
    vi.clearAllMocks();

    expect(await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)))).toBeUndefined();
    expect((await definition().onHealth()).details).toMatchObject({
      issue: "discord-interactions-unverified",
    });
  });
});

describe("interactions webhook — the runtime is resolved before the check, not acted on", () => {
  it("drops an unsigned delivery arriving before any configuration, with no startup reply", async () => {
    // Before this change an unconfigured plugin answered every caller with
    // "Plugin is still starting up", which is a free oracle. Nothing unsigned
    // gets an interaction response now.
    const host = buildHost();
    await definition().setup(host.ctx);

    const response = await definition().onWebhook(unsignedDelivery(statusCommand(HANNA_ID)));

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores an endpoint key it does not own", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);

    const response = await definition().onWebhook({
      endpointKey: "not-ours",
      requestId: "req-2",
      rawBody: "{}",
      parsedBody: {},
      headers: {},
    });

    expect(response).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The replay window, at the worker boundary.
// ---------------------------------------------------------------------------

describe("interactions webhook — a stale delivery is dropped", () => {
  it("drops a correctly signed delivery whose timestamp is ten minutes old", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const stale = signedDelivery(privateKey, statusCommand(HANNA_ID), freshTimestamp(-600));

    expect(await definition().onWebhook(stale)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a replay of a delivery that was valid when it was captured", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));

    // Valid now.
    const captured = signedDelivery(privateKey, statusCommand(HANNA_ID));
    expect(await definition().onWebhook(captured)).toBeDefined();

    // The same bytes, replayed after the window. Only the clock moved, so this
    // is the identical request an attacker would resend.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
    try {
      vi.clearAllMocks();
      expect(await definition().onWebhook(captured)).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// A malformed key is a configuration mistake, not an attack. It gets its own
// health note, at bootstrap, because it is wrong on every install.
// ---------------------------------------------------------------------------

const MALFORMED_ISSUE = "discord-interactions-public-key-malformed";
const UNVERIFIED_ISSUE = "discord-interactions-unverified";

describe("interactions webhook — a malformed public key", () => {
  const malformedKeys: Array<[string, string]> = [
    ["truncated", "a".repeat(62)],
    ["over-long", "a".repeat(66)],
    ["not hex at all", "paste-your-public-key-here".padEnd(64, "x")],
    ["the all-zero placeholder", "00".repeat(32)],
    ["the identity point", "01".padEnd(64, "0")],
  ];

  for (const [label, publicKey] of malformedKeys) {
    it(`raises a health note at bootstrap for a ${label} key`, async () => {
      const host = buildHost();
      await definition().setup(host.ctx);
      await host.deliver(baseConfig({ discordPublicKey: publicKey }));

      const health = await definition().onHealth();
      expect(health.status).toBe("degraded");
      expect(health.details).toMatchObject({ issue: MALFORMED_ISSUE });
      expect(String(health.message)).toContain("discordPublicKey");
      // The value never travels: it is the operator's own configuration, and a
      // health payload is read in more places than a log line.
      expect(JSON.stringify(health)).not.toContain(publicKey);
    });

    it(`refuses every delivery while the key is ${label}`, async () => {
      const { privateKey } = keypair();
      const host = buildHost();
      await definition().setup(host.ctx);
      await host.deliver(baseConfig({ discordPublicKey: publicKey }));
      vi.clearAllMocks();

      expect(await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)))).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("names the field in the log at bootstrap, never the value", async () => {
    const publicKey = "a".repeat(62);
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKey }));

    const logged = JSON.stringify(host.ctx.logger.warn.mock.calls);
    expect(logged).toContain("discordPublicKey");
    expect(logged).not.toContain(publicKey);
  });

  it("keeps the note across a second configuration delivery", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: "a".repeat(62) }));
    await host.deliver(baseConfig({ discordPublicKey: "a".repeat(62) }));

    expect((await definition().onHealth()).details).toMatchObject({ issue: MALFORMED_ISSUE });
  });

  it("clears the note once the key is corrected", async () => {
    const { publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: "a".repeat(62) }));
    expect((await definition().onHealth()).details).toMatchObject({ issue: MALFORMED_ISSUE });

    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    expect((await definition().onHealth()).status).toBe("ok");
  });

  it("raises no malformed note for a usable key, or for no key at all", async () => {
    const { publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);

    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    expect((await definition().onHealth()).status).toBe("ok");

    await host.deliver(baseConfig());
    expect((await definition().onHealth()).details?.issue).not.toBe(MALFORMED_ISSUE);
  });
});

// ---------------------------------------------------------------------------
// The unverified note has to survive a bootstrap, because a gateway reconnect
// resets health to ok and a dropped webhook delivery is still being dropped.
// ---------------------------------------------------------------------------

describe("interactions webhook — the unverified note survives a reset", () => {
  it("keeps the note after a second configuration delivery", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));
    expect((await definition().onHealth()).details).toMatchObject({ issue: UNVERIFIED_ISSUE });

    // A save, or a reconnect: health is reset to ok inside bootstrap. The drop
    // is still happening, so the note has to come back.
    await host.deliver(baseConfig());

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: UNVERIFIED_ISSUE });
  });

  it("still raises nothing on an install that has never had a webhook delivery", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());
    await host.deliver(baseConfig());

    expect((await definition().onHealth()).details?.issue).not.toBe(UNVERIFIED_ISSUE);
  });

  it("forgets the dropped delivery once the runtime is reset", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());
    await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));

    _resetRuntimeForTests();
    _resetCompanyIdCache();
    const next = buildHost();
    await definition().setup(next.ctx);
    await next.deliver(baseConfig());

    expect((await definition().onHealth()).details?.issue).not.toBe(UNVERIFIED_ISSUE);
  });
});

// ---------------------------------------------------------------------------
// An unauthenticated caller must not be able to overwrite health or flood the
// log by repeating a request.
// ---------------------------------------------------------------------------

describe("interactions webhook — a repeated refusal neither floods nor masks", () => {
  it("logs the unverifiable-configuration warning once for a burst of deliveries", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());
    vi.clearAllMocks();

    for (let i = 0; i < 5; i++) {
      await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));
    }

    const matching = host.ctx.logger.warn.mock.calls.filter((call: any[]) =>
      String(call[0]).includes("discordPublicKey"),
    );
    expect(matching).toHaveLength(1);
  });

  it("logs the bad-signature warning once for a burst of forged deliveries", async () => {
    const configured = keypair();
    const attacker = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: configured.publicKeyHex }));
    vi.clearAllMocks();

    for (let i = 0; i < 5; i++) {
      await definition().onWebhook(signedDelivery(attacker.privateKey, statusCommand(HANNA_ID)));
    }

    const matching = host.ctx.logger.warn.mock.calls.filter((call: any[]) =>
      String(call[0]).includes("signature"),
    );
    expect(matching).toHaveLength(1);
  });

  it("does not mask an unrelated health note", async () => {
    // No operator configured, so health already carries the inbound-disabled
    // note. An anonymous caller must not be able to replace it.
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: "" }));
    expect((await definition().onHealth()).details).toMatchObject({
      issue: "discord-inbound-disabled",
    });

    await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));

    expect((await definition().onHealth()).details).toMatchObject({
      issue: "discord-inbound-disabled",
    });
  });

  it("still records the first refusal in the log", async () => {
    const { privateKey } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: "" }));
    vi.clearAllMocks();

    await definition().onWebhook(signedDelivery(privateKey, statusCommand(HANNA_ID)));

    const matching = host.ctx.logger.warn.mock.calls.filter((call: any[]) =>
      String(call[0]).includes("discordPublicKey"),
    );
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Act on the bytes that were verified, not on the host's parse of them.
// ---------------------------------------------------------------------------

describe("interactions webhook — the signed bytes are what is acted on", () => {
  it("refuses when parsedBody claims Hanna but the signed bytes name somebody else", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const delivery = signedDelivery(privateKey, statusCommand(OTHER_ID));
    // The signature still covers rawBody, so the gate passes. Only the host's
    // parse disagrees — which is what a charset trick would produce.
    delivery.parsedBody = JSON.parse(JSON.stringify(statusCommand(HANNA_ID)));

    const response: any = await definition().onWebhook(delivery);

    expect(response.data.content).toContain("configured operator");
  });

  it("handles the command when the signed bytes name Hanna and parsedBody does not", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const delivery = signedDelivery(privateKey, statusCommand(HANNA_ID));
    delivery.parsedBody = JSON.parse(JSON.stringify(statusCommand(OTHER_ID)));

    const response: any = await definition().onWebhook(delivery);

    expect(response).toBeDefined();
    expect(JSON.stringify(response)).not.toContain("configured operator");
  });

  it("drops a delivery whose verified bytes are not JSON", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));
    vi.clearAllMocks();

    const timestamp = freshTimestamp();
    const rawBody = "not json at all";
    const delivery = {
      endpointKey: "discord-interactions",
      requestId: "req-1",
      rawBody,
      parsedBody: statusCommand(HANNA_ID),
      headers: {
        "X-Signature-Ed25519": crypto
          .sign(null, Buffer.from(timestamp + rawBody, "utf8"), privateKey)
          .toString("hex"),
        "X-Signature-Timestamp": timestamp,
      },
    };

    expect(await definition().onWebhook(delivery)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a delivery whose verified bytes are JSON but not an object", async () => {
    const { privateKey, publicKeyHex } = keypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ discordPublicKey: publicKeyHex }));

    for (const rawBody of ["null", "123", '"a string"', "[]", "true"]) {
      vi.clearAllMocks();
      const timestamp = freshTimestamp();
      const delivery = {
        endpointKey: "discord-interactions",
        requestId: "req-1",
        rawBody,
        parsedBody: statusCommand(HANNA_ID),
        headers: {
          "X-Signature-Ed25519": crypto
            .sign(null, Buffer.from(timestamp + rawBody, "utf8"), privateKey)
            .toString("hex"),
          "X-Signature-Timestamp": timestamp,
        },
      };

      expect(await definition().onWebhook(delivery)).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// onValidateConfig: a bad key is refused at save time, so the gate is never
// configured into accept-all in the first place.
// ---------------------------------------------------------------------------

describe("onValidateConfig — discordPublicKey", () => {
  function validConfig(overrides: Record<string, unknown> = {}) {
    return {
      discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      defaultChannelId: "chan-default",
      ...overrides,
    };
  }

  it("accepts a config with no public key — a gateway-only install needs none", async () => {
    for (const discordPublicKey of [undefined, "", "   "]) {
      expect(await definition().onValidateConfig(validConfig({ discordPublicKey }))).toEqual({ ok: true });
    }
  });

  it("accepts a usable key, in any case or with padding", async () => {
    const { publicKeyHex } = keypair();
    for (const discordPublicKey of [publicKeyHex, publicKeyHex.toUpperCase(), ` ${publicKeyHex} `]) {
      expect(await definition().onValidateConfig(validConfig({ discordPublicKey }))).toEqual({ ok: true });
    }
  });

  it("refuses a wrong-shaped or degenerate key, naming the field", async () => {
    const badKeys = [
      "a".repeat(62),
      "a".repeat(66),
      "z".repeat(64),
      "00".repeat(32),
      "01".padEnd(64, "0"),
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      12345,
    ];
    for (const discordPublicKey of badKeys) {
      const result: any = await definition().onValidateConfig(validConfig({ discordPublicKey }));
      expect(result.ok).toBe(false);
      expect(String(result.errors[0])).toContain("discordPublicKey");
      expect(JSON.stringify(result)).not.toContain(String(discordPublicKey));
    }
  });
});
