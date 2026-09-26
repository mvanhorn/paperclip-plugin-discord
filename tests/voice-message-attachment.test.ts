import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Plan item 8 — voice messages.
//
// A reply that carries an audio attachment goes through the local
// transcriber (WhisperSTTAdapter, mocked here — see voice-stt-whisper.test.ts
// for its own unit coverage) and then the SAME ingress a typed reply uses.
// The author allowlist from item 2 applies before any of this runs.
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

const { transcribeBufferMock, whisperConstructorCalls } = vi.hoisted(() => ({
  transcribeBufferMock: vi.fn(),
  whisperConstructorCalls: [] as any[],
}));

vi.mock("../src/voice/stt-whisper.js", () => ({
  WhisperSTTAdapter: class MockWhisperSTTAdapter {
    constructor(cfg: any) {
      whisperConstructorCalls.push(cfg);
    }
    transcribeBuffer = transcribeBufferMock;
  },
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const HANNA_ID = "77777777-7777-7777-7777-777777777777";
const OTHER_ID = "88888888-8888-8888-8888-888888888888";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function gateway(): any {
  return gatewayConnects[gatewayConnects.length - 1];
}

let fetchMock: ReturnType<typeof vi.fn>;
let attachmentFetchMock: ReturnType<typeof vi.fn>;
let attachmentBytes: Uint8Array;

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
    agents: { list: vi.fn(async () => []) },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: { fetch: attachmentFetchMock },
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
    ...overrides,
  };
}

function voiceMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-2",
    channel_id: "chan-1",
    content: "",
    author: { id: HANNA_ID, username: "hanna", bot: false },
    message_reference: { message_id: "msg-1", channel_id: "chan-1" },
    attachments: [
      {
        id: "att-1",
        filename: "voice-message.ogg",
        url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
        content_type: "audio/ogg",
        size: 12_345,
      },
    ],
    ...overrides,
  } as any;
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  transcribeBufferMock.mockReset();
  transcribeBufferMock.mockResolvedValue("ship the release");
  whisperConstructorCalls.length = 0;
  vi.clearAllMocks();

  attachmentBytes = new Uint8Array([1, 2, 3, 4]);
  attachmentFetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => attachmentBytes.buffer,
  }));

  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  })) as any;
  vi.stubGlobal("fetch", fetchMock);
});

describe("voice messages — audio attachment as a reply (plan item 8)", () => {
  it("transcribes the attachment and posts a comment with the transcript and a link to the audio", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(voiceMessage());

    expect(transcribeBufferMock).toHaveBeenCalledTimes(1);
    expect(transcribeBufferMock).toHaveBeenCalledWith(expect.any(Buffer), "voice-message.ogg");

    expect(commentPosts()).toHaveLength(1);
    const [url, init] = commentPosts()[0];
    expect(String(url)).toContain("/api/issues/issue-9/comments");
    const body = JSON.parse(String(init.body));
    expect(body.body).toContain("ship the release");
    expect(body.body).toContain("https://cdn.discordapp.com/attachments/1/2/voice-message.ogg");
    expect(body.authorUserId).toBe("discord:hanna");
  });

  it("applies the item 2 author allowlist before ever downloading the attachment", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(voiceMessage({ author: { id: OTHER_ID, username: "eve", bot: false } }));

    expect(attachmentFetchMock).not.toHaveBeenCalled();
    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("refuses a bot author's voice message, same as any other bot message", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(voiceMessage({ author: { id: HANNA_ID, username: "hanna", bot: true } }));

    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("requires the voice message to be a reply, exactly like a typed message", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(voiceMessage({ message_reference: undefined }));

    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("falls through to the typed-text path for a non-audio attachment", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(
      voiceMessage({
        content: "see the attached screenshot",
        attachments: [
          { id: "att-2", filename: "screenshot.png", url: "https://cdn.discordapp.com/x.png", content_type: "image/png", size: 500 },
        ],
      }),
    );

    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(1);
    expect(JSON.parse(String(commentPosts()[0][1].body)).body).toBe("see the attached screenshot");
  });

  it("qualifies an attachment with a generic content type when the Discord voice-message flag is set", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(
      voiceMessage({
        flags: 1 << 13,
        attachments: [
          { id: "att-3", filename: "voice-message.ogg", url: "https://cdn.discordapp.com/v.ogg", content_type: "application/octet-stream", size: 500 },
        ],
      }),
    );

    expect(transcribeBufferMock).toHaveBeenCalledTimes(1);
    expect(commentPosts()).toHaveLength(1);
  });

  it("drops an attachment over the size bound without downloading it, and logs the thread and author (silent-failure review B5)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(
      voiceMessage({
        attachments: [
          {
            id: "att-4",
            filename: "huge.ogg",
            url: "https://cdn.discordapp.com/huge.ogg",
            content_type: "audio/ogg",
            size: 30 * 1024 * 1024,
          },
        ],
      }),
    );

    expect(attachmentFetchMock).not.toHaveBeenCalled();
    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("size bound"),
      expect.objectContaining({
        channelId: "chan-1",
        threadKey: "reply:chan-1:msg-1",
        author: "discord:hanna",
      }),
    );
  });

  it("drops the message when the download fails, without crashing the handler, and logs the thread and author (silent-failure review B5)", async () => {
    attachmentFetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await expect(gateway().onMessage(voiceMessage())).resolves.toBeUndefined();

    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to download"),
      expect.objectContaining({
        channelId: "chan-1",
        threadKey: "reply:chan-1:msg-1",
        author: "discord:hanna",
      }),
    );
  });

  it("drops the message when transcription fails, without crashing the handler, and logs the thread and author (silent-failure review B5)", async () => {
    transcribeBufferMock.mockRejectedValueOnce(new Error("whisper-cli exited with code 1"));
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await expect(gateway().onMessage(voiceMessage())).resolves.toBeUndefined();

    expect(commentPosts()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("transcription failed"),
      expect.objectContaining({
        channelId: "chan-1",
        threadKey: "reply:chan-1:msg-1",
        author: "discord:hanna",
      }),
    );
  });

  it("configures the transcriber from the plugin's whisper config fields", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({
      hannaDiscordUserId: HANNA_ID,
      whisperBinaryPath: "/custom/whisper-cli",
      ffmpegPath: "/custom/ffmpeg",
      whisperModelPath: "/custom/model.bin",
      whisperLanguage: "fr",
    });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(voiceMessage());

    expect(whisperConstructorCalls.at(-1)).toMatchObject({
      binaryPath: "/custom/whisper-cli",
      ffmpegPath: "/custom/ffmpeg",
      modelPath: "/custom/model.bin",
      language: "fr",
    });
  });
});

/** A ReadableStream-shaped body reader yielding the given chunks, then done. */
function streamingReader(chunks: Uint8Array[]) {
  let index = 0;
  const cancel = vi.fn(async () => {});
  const read = vi.fn(async () => {
    if (index >= chunks.length) return { done: true, value: undefined };
    const value = chunks[index];
    index += 1;
    return { done: false, value };
  });
  return { getReader: () => ({ read, cancel }), read, cancel };
}

describe("voice messages — attachment URL and download hardening (security review A3/A4)", () => {
  it("drops an attachment whose host is not the Discord CDN, without downloading it", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(
      voiceMessage({
        attachments: [
          {
            id: "att-evil",
            filename: "voice-message.ogg",
            url: "https://evil.example.com/voice-message.ogg",
            content_type: "audio/ogg",
            size: 500,
          },
        ],
      }),
    );

    expect(attachmentFetchMock).not.toHaveBeenCalled();
    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("drops an http:// attachment even on an allowed host", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(
      voiceMessage({
        attachments: [
          {
            id: "att-http",
            filename: "voice-message.ogg",
            url: "http://cdn.discordapp.com/voice-message.ogg",
            content_type: "audio/ogg",
            size: 500,
          },
        ],
      }),
    );

    expect(attachmentFetchMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("accepts an attachment on media.discordapp.net", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(
      voiceMessage({
        attachments: [
          {
            id: "att-media",
            filename: "voice-message.ogg",
            url: "https://media.discordapp.net/attachments/1/2/voice-message.ogg",
            content_type: "audio/ogg",
            size: 500,
          },
        ],
      }),
    );

    expect(attachmentFetchMock).toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(1);
  });

  it("passes an abort signal on the download request", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(voiceMessage());

    const [, init] = attachmentFetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts and drops a stream that exceeds the size bound, without buffering the whole thing", async () => {
    const bigChunk = new Uint8Array(20 * 1024 * 1024); // 20 MB
    const reader = streamingReader([bigChunk, bigChunk]); // 40 MB total, over the 25 MB bound
    attachmentFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    await gateway().onMessage(voiceMessage());

    expect(reader.cancel).toHaveBeenCalled();
    expect(transcribeBufferMock).not.toHaveBeenCalled();
    expect(commentPosts()).toHaveLength(0);
  });

  it("still transcribes a stream that stays under the size bound", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const reader = streamingReader([chunk]);
    attachmentFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(voiceMessage());

    expect(transcribeBufferMock).toHaveBeenCalledTimes(1);
    expect(commentPosts()).toHaveLength(1);
  });
});
