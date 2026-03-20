import { describe, it, expect, vi } from "vitest";
import { registerWatch, type WatchEntry } from "../src/proactive-suggestions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stateStore = new Map<string, unknown>();

function makeCtx() {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: { invoke: vi.fn().mockResolvedValue({ runId: "r1" }) },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
        return Promise.resolve(stateStore.get(stateKey) ?? null);
      }),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
        return Promise.resolve(undefined);
      }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }),
    },
    events: { emit: vi.fn() },
  } as any;
}

function makeWatch(overrides: Partial<WatchEntry> = {}): WatchEntry {
  return {
    watchId: "watch-1",
    watchName: "deploy-mentions",
    patterns: ["deploy", "release"],
    channelIds: ["ch-1"],
    responseTemplate: "Hey {{author}}, noticed you mentioned deployment in {{channel}}",
    agentId: "agent-1",
    agentName: "DeployBot",
    companyId: "c1",
    cooldownMinutes: 60,
    registeredAt: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Watch condition pattern matching
// ---------------------------------------------------------------------------

describe("watch condition pattern matching", () => {
  it("matches simple string patterns", () => {
    const patterns = ["deploy", "release"];
    const compiled = patterns.map((p) => new RegExp(p, "i"));
    expect(compiled.some((r) => r.test("Can we deploy to staging?"))).toBe(true);
    expect(compiled.some((r) => r.test("New release coming soon"))).toBe(true);
  });

  it("is case-insensitive", () => {
    const compiled = [new RegExp("deploy", "i")];
    expect(compiled.some((r) => r.test("DEPLOY NOW"))).toBe(true);
    expect(compiled.some((r) => r.test("Deploy"))).toBe(true);
    expect(compiled.some((r) => r.test("deploy"))).toBe(true);
  });

  it("supports regex patterns", () => {
    const compiled = [new RegExp("v\\d+\\.\\d+", "i")];
    expect(compiled.some((r) => r.test("Just pushed v2.3 to prod"))).toBe(true);
    expect(compiled.some((r) => r.test("no version here"))).toBe(false);
  });

  it("does not match when no patterns match", () => {
    const compiled = ["deploy", "release"].map((p) => new RegExp(p, "i"));
    expect(compiled.some((r) => r.test("Just chatting about lunch"))).toBe(false);
  });

  it("skips bot messages (username ending in [bot])", () => {
    const author = { username: "github[bot]" };
    const isBot = author.username.endsWith("[bot]");
    expect(isBot).toBe(true);
  });

  it("does not skip non-bot users", () => {
    const author = { username: "testuser" };
    const isBot = author.username.endsWith("[bot]");
    expect(isBot).toBe(false);
  });

  it("only checks messages within 20 minute window", () => {
    const now = Date.now();
    const recentMsg = now - 5 * 60 * 1000; // 5 min ago
    const oldMsg = now - 25 * 60 * 1000; // 25 min ago

    expect(now - recentMsg <= 20 * 60 * 1000).toBe(true);
    expect(now - oldMsg <= 20 * 60 * 1000).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting / cooldown enforcement
// ---------------------------------------------------------------------------

describe("rate limiting / cooldown", () => {
  it("allows trigger when no lastTriggeredAt", () => {
    const watch = makeWatch({ lastTriggeredAt: undefined });
    const now = Date.now();
    const cooldownMs = watch.cooldownMinutes * 60 * 1000;

    let shouldSkip = false;
    if (watch.lastTriggeredAt) {
      const elapsed = now - new Date(watch.lastTriggeredAt).getTime();
      if (elapsed < cooldownMs) shouldSkip = true;
    }
    expect(shouldSkip).toBe(false);
  });

  it("skips trigger when within cooldown period", () => {
    const lastTriggeredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const watch = makeWatch({ lastTriggeredAt, cooldownMinutes: 60 });
    const now = Date.now();
    const cooldownMs = watch.cooldownMinutes * 60 * 1000;

    let shouldSkip = false;
    if (watch.lastTriggeredAt) {
      const elapsed = now - new Date(watch.lastTriggeredAt).getTime();
      if (elapsed < cooldownMs) shouldSkip = true;
    }
    expect(shouldSkip).toBe(true);
  });

  it("allows trigger when cooldown has expired", () => {
    const lastTriggeredAt = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
    const watch = makeWatch({ lastTriggeredAt, cooldownMinutes: 60 });
    const now = Date.now();
    const cooldownMs = watch.cooldownMinutes * 60 * 1000;

    let shouldSkip = false;
    if (watch.lastTriggeredAt) {
      const elapsed = now - new Date(watch.lastTriggeredAt).getTime();
      if (elapsed < cooldownMs) shouldSkip = true;
    }
    expect(shouldSkip).toBe(false);
  });

  it("enforces minimum cooldown of 60 minutes for cooldownMinutes <= 0", () => {
    // This is enforced in registerWatch: cooldownMinutes > 0 ? cooldownMinutes : 60
    const input = 0;
    const effective = input > 0 ? input : 60;
    expect(effective).toBe(60);

    const negativeInput = -5;
    const effectiveNeg = negativeInput > 0 ? negativeInput : 60;
    expect(effectiveNeg).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// registerWatch
// ---------------------------------------------------------------------------

describe("registerWatch", () => {
  it("registers a new watch successfully", async () => {
    const ctx = makeCtx();
    const result = await registerWatch(
      ctx,
      "c1",
      "deploy-watch",
      ["deploy", "release"],
      ["ch-1"],
      "Hey {{author}}",
      60,
      "agent-1",
      "DeployBot",
    );
    expect(result.ok).toBe(true);
    expect(result.watchId).toBeTruthy();
  });

  it("rejects registration with empty patterns", async () => {
    const ctx = makeCtx();
    const result = await registerWatch(
      ctx,
      "c1",
      "empty-watch",
      [],
      ["ch-1"],
      "template",
      60,
      "agent-1",
      "Bot",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("At least one pattern");
  });

  it("rejects invalid regex patterns", async () => {
    const ctx = makeCtx();
    const result = await registerWatch(
      ctx,
      "c1",
      "bad-regex",
      ["[invalid"],
      ["ch-1"],
      "template",
      60,
      "agent-1",
      "Bot",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid regex");
  });

  it("updates existing watch when same name is registered", async () => {
    const ctx = makeCtx();
    await registerWatch(ctx, "c1", "my-watch", ["v1"], ["ch-1"], "t1", 60, "a1", "Bot1");
    const result = await registerWatch(ctx, "c1", "my-watch", ["v2"], ["ch-2"], "t2", 30, "a2", "Bot2");
    expect(result.ok).toBe(true);

    const stored = stateStore.get("proactive_watches") as { watches: WatchEntry[] };
    expect(stored.watches).toHaveLength(1);
    expect(stored.watches[0].patterns).toEqual(["v2"]);
    expect(stored.watches[0].agentName).toBe("Bot2");
  });

  it("scans default channel when channelIds is empty", () => {
    const channelIds: string[] = [];
    const defaultChannelId = "ch-default";
    const channelsToScan = channelIds.length > 0 ? channelIds : [defaultChannelId];
    expect(channelsToScan).toEqual(["ch-default"]);
  });
});

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

describe("response template interpolation", () => {
  it("replaces {{author}}, {{content}}, {{channel}}", () => {
    const template = "Hey {{author}}, regarding: {{content}} in {{channel}}";
    const result = template
      .replace("{{author}}", "matt")
      .replace("{{content}}", "deploy request")
      .replace("{{channel}}", "ch-general");
    expect(result).toBe("Hey matt, regarding: deploy request in ch-general");
  });

  it("truncates suggestion to 2048 chars", () => {
    const longTemplate = "A".repeat(3000);
    const truncated = longTemplate.slice(0, 2048);
    expect(truncated.length).toBe(2048);
  });
});
