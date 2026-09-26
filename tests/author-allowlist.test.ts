import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Author allowlist (plan item 2, revised — fails closed).
//
// Every inbound path drops any author whose ID does not match
// `hannaDiscordUserId`: typed replies, button clicks, slash commands, and the
// voice ingress (an utterance's `userId`). Unset is NOT upstream's "trust
// everyone" shape: with no operator configured, every author is dropped, on
// every path, and the plugin reports itself degraded and logs it once per
// configuration delivery — see "author allowlist — fails closed" below.
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
    const readyHandlers = new Set<() => void>();
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
    if (options?.enableVoice) {
      record.voice = {
        sendPayload: () => true,
        onVoiceStateUpdate: () => () => {},
        onVoiceServerUpdate: () => () => {},
        onGatewayReady: (handler: () => void) => {
          readyHandlers.add(handler);
          return () => readyHandlers.delete(handler);
        },
      };
    }
    gatewayConnects.push(record);
    return record;
  }),
}));

const { voiceClients } = vi.hoisted(() => ({ voiceClients: [] as any[] }));

vi.mock("../src/voice/index.js", () => ({
  createPluginDiscordAdapter: () => () => ({ sendPayload: () => true, destroy: () => {} }),
  WhisperSTTAdapter: class MockWhisperSTTAdapter {
    transcribeUtterance = vi.fn().mockResolvedValue("");
  },
  get VoiceClient() {
    return class MockVoiceClient {
      config: any;
      constructor(_ctx: any, config: any) {
        this.config = config;
        voiceClients.push(this);
      }
      async start() {}
      stop() {}
    };
  },
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const HANNA_ID = "999999999999999999";
const OTHER_ID = "111111111111111111";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function gateway(): any {
  return gatewayConnects[gatewayConnects.length - 1];
}

let fetchMock: ReturnType<typeof vi.fn>;
let commentPostFails = false;

function commentPosts() {
  return fetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/comments"));
}

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
    http: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "posted-msg-1" }), text: async () => "" })),
    },
  } as any;

  return {
    ctx,
    stateStore,
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
    // Test-only bridge, matching voice-worker-ingress.test.ts: this env var
    // now configures the standing voice inbox directly (plan item 9).
    ...(process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID
      ? { voiceInboxIssueId: process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID }
      : {}),
    ...overrides,
  };
}

/**
 * A real Ed25519 keypair, with the public key as the 64-char hex Discord
 * publishes on an application's General Information page.
 */
function interactionKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
}

/**
 * A webhook delivery Discord itself could have sent: the raw body, and the two
 * signature headers over `timestamp + rawBody`. The plugin verifies this before
 * anything reads the body, so an unsigned delivery never reaches the allowlist.
 *
 * The timestamp is read off the real clock because the gate bounds its age: a
 * fixed one would make this test expire.
 */
function signedInteractionDelivery(privateKey: crypto.KeyObject, interaction: unknown) {
  const rawBody = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    endpointKey: "discord-interactions",
    requestId: "req-1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: {
      "x-signature-ed25519": crypto
        .sign(null, Buffer.from(timestamp + rawBody, "utf8"), privateKey)
        .toString("hex"),
      "x-signature-timestamp": timestamp,
    },
  } as any;
}

function typedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-2",
    channel_id: "chan-1",
    content: "a typed reply",
    author: { id: "u1", username: "alice", bot: false },
    message_reference: { message_id: "msg-1", channel_id: "chan-1" },
    ...overrides,
  } as any;
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  voiceClients.length = 0;
  commentPostFails = false;
  vi.clearAllMocks();

  fetchMock = vi.fn(async () => ({
    ok: !commentPostFails,
    status: commentPostFails ? 404 : 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  })) as any;
  vi.stubGlobal("fetch", fetchMock);

  delete process.env.DISCORD_VOICE_GUILD_ID;
  delete process.env.DISCORD_VOICE_CHANNEL_ID;
  delete process.env.DISCORD_VOICE_WEBHOOK_URL;
});

describe("author allowlist — typed replies", () => {
  it("fails closed: drops a reply from any author when hannaDiscordUserId is unset", async () => {
    // No operator configured is not "trust everyone" (upstream's shape) — it
    // is "trust no one", so a missed configuration step never silently
    // becomes an open inbox.
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage());

    expect(commentPosts()).toHaveLength(0);
  });

  it("drops a reply from an author who is not hannaDiscordUserId", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage({ author: { id: OTHER_ID, username: "eve", bot: false } }));

    expect(commentPosts()).toHaveLength(0);
  });

  it("logs the drop, with the author id and channel id but no content (silent-failure review B1)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    await gateway().onMessage(
      typedMessage({ content: "a secret nobody should log", author: { id: OTHER_ID, username: "eve", bot: false } }),
    );

    expect(host.ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("configured operator"),
      expect.objectContaining({ authorId: OTHER_ID, channelId: "chan-1" }),
    );
    const loggedPayloads = JSON.stringify(host.ctx.logger.info.mock.calls);
    expect(loggedPayloads).not.toContain("a secret nobody should log");
  });

  it("still routes a reply from hannaDiscordUserId when it is set", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    host.stateStore.set("instance::msg_chan-1_msg-1", { entityId: "issue-9", entityType: "issue", companyId: COMPANY_A });
    await gateway().onMessage(typedMessage({ author: { id: HANNA_ID, username: "hanna", bot: false } }));

    expect(commentPosts()).toHaveLength(1);
  });
});

describe("author allowlist — fails closed, reported through health and the log", () => {
  it("degrades health and logs once when hannaDiscordUserId is unset", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-inbound-disabled" });
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("hannaDiscordUserId"),
      expect.anything(),
    );
  });

  it("reports ok once hannaDiscordUserId is configured", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());
    expect((await definition().onHealth()).status).toBe("degraded");

    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));
    expect((await definition().onHealth()).status).toBe("ok");
  });
});

describe("author allowlist — slash commands and button clicks (interactions)", () => {
  it("fails closed: refuses a slash command from any author when hannaDiscordUserId is unset", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig());

    const response: any = await gateway().onInteraction({
      id: "int-1",
      token: "tok",
      type: 2, // APPLICATION_COMMAND
      data: { name: "clip", options: [{ name: "status" }] },
      member: { user: { id: OTHER_ID, username: "eve" } },
    });

    expect(response.data.content).toContain("configured operator");
    expect(response.data.flags).toBe(64);
  });

  it("refuses a slash command from an author who is not hannaDiscordUserId", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    const response: any = await gateway().onInteraction({
      id: "int-1",
      token: "tok",
      type: 2, // APPLICATION_COMMAND
      data: { name: "clip", options: [{ name: "status" }] },
      member: { user: { id: OTHER_ID, username: "eve" } },
    });

    expect(response.data.content).toContain("configured operator");
    expect(response.data.flags).toBe(64);
  });

  it("still answers a slash command from hannaDiscordUserId", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    const response: any = await gateway().onInteraction({
      id: "int-1",
      token: "tok",
      type: 2,
      data: { name: "clip", options: [{ name: "status" }] },
      member: { user: { id: HANNA_ID, username: "hanna" } },
    });

    expect(JSON.stringify(response)).not.toContain("configured operator");
  });

  it("refuses a button click from an author who is not hannaDiscordUserId", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    const response: any = await gateway().onInteraction({
      id: "int-1",
      token: "tok",
      type: 3, // MESSAGE_COMPONENT
      data: { custom_id: "approval_approve_appr-1" },
      member: { user: { id: OTHER_ID, username: "eve" } },
    });

    expect(response.data.content).toContain("configured operator");
  });

  it("refuses an interaction delivered via the webhook fallback from a non-operator author", async () => {
    // The webhook delivery is signed with the configured application key, so the
    // signature gate passes and the allowlist is what refuses it. A signature
    // proves Discord sent the interaction, never that the right person clicked —
    // see tests/interactions-webhook-signature.test.ts for the gate itself.
    const { privateKey, publicKeyHex } = interactionKeypair();
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID, discordPublicKey: publicKeyHex }));

    const response: any = await definition().onWebhook(
      signedInteractionDelivery(privateKey, {
        id: "int-1",
        token: "tok",
        type: 2,
        data: { name: "clip", options: [{ name: "status" }] },
        member: { user: { id: OTHER_ID, username: "eve" } },
      }),
    );

    expect(response.data.content).toContain("configured operator");
  });
});

describe("author allowlist — voice ingress", () => {
  it("drops an utterance from a speaker who is not hannaDiscordUserId", async () => {
    process.env.DISCORD_VOICE_GUILD_ID = "guild-1";
    process.env.DISCORD_VOICE_CHANNEL_ID = "voice-chan-1";
    process.env.DISCORD_VOICE_WEBHOOK_URL = "https://discord.test/api/webhooks/1/secret";
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = "issue-voice-1";

    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    await voiceClients[0].config.ingestUtterance({
      userId: OTHER_ID,
      text: "ship the release",
      durationSec: 1,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
    });

    expect(commentPosts()).toHaveLength(0);
    delete process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID;
  });

  it("still routes an utterance from hannaDiscordUserId", async () => {
    process.env.DISCORD_VOICE_GUILD_ID = "guild-1";
    process.env.DISCORD_VOICE_CHANNEL_ID = "voice-chan-1";
    process.env.DISCORD_VOICE_WEBHOOK_URL = "https://discord.test/api/webhooks/1/secret";
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = "issue-voice-1";

    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(baseConfig({ hannaDiscordUserId: HANNA_ID }));

    await voiceClients[0].config.ingestUtterance({
      userId: HANNA_ID,
      text: "ship the release",
      durationSec: 1,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
    });

    expect(commentPosts()).toHaveLength(1);
    delete process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID;
  });
});
