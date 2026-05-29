import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebhookTextChannelRelay } from "../src/voice/text-channel-relay.js";

const FAKE_URL = "https://discord.example/api/webhooks/123/abc";

describe("WebhookTextChannelRelay", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the webhook URL with content and Michael (voice) username", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("hello alfred", { durationSec: 1.2 });

    expect(global.fetch).toHaveBeenCalledOnce();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url, opts] = calls[0] as [string, RequestInit];
    expect(url).toBe(FAKE_URL);
    const body = JSON.parse(opts.body as string);
    expect(body.content).toBe("hello alfred");
    expect(body.username).toBe("Michael (voice)");
  });

  it("retries once on 5xx then succeeds", async () => {
    const mock = global.fetch as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("retry test", { durationSec: 1.0 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx auth failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("invalid webhook token", { status: 401 }),
    );

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await expect(
      relay.postTranscript("auth fail", { durationSec: 0.5 }),
    ).rejects.toThrow(/401/);

    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("skips empty transcripts (silence detected, no text)", async () => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("", { durationSec: 0.3 });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("trims whitespace-only transcripts to empty (also skipped)", async () => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("   \n  ", { durationSec: 0.5 });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses custom username if configured", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const relay = new WebhookTextChannelRelay({
      webhookUrl: FAKE_URL,
      username: "Custom Name",
    });
    await relay.postTranscript("hi", { durationSec: 0.5 });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [, opts] = calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.username).toBe("Custom Name");
  });
});
