import { describe, it, expect, vi } from "vitest";
import { handleInteraction, SLASH_COMMANDS, type CommandContext } from "../src/commands.js";
import { COLORS } from "../src/constants.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      sessions: {
        create: vi.fn(),
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
      invoke: vi.fn(),
    },
    issues: {
      list: vi.fn().mockResolvedValue([]),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true }),
    },
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
    ...overrides,
  } as any;
}

const defaultCmdCtx: CommandContext = {
  baseUrl: "http://localhost:3100",
  companyId: "default",
  token: "test-token",
  defaultChannelId: "ch-1",
};

describe("handleInteraction", () => {
  it("responds to PING with PONG", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(ctx, { type: 1 }, defaultCmdCtx);
    expect(result).toEqual({ type: 1 });
  });

  it("handles unknown interaction type", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(ctx, { type: 99 }, defaultCmdCtx) as any;
    expect(result.type).toBe(4);
    expect(result.data.content).toContain("Unknown interaction type");
  });

  it("tracks command metrics", async () => {
    const ctx = makeCtx();
    await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "status" }] } },
      defaultCmdCtx,
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith("discord_commands_handled", 1);
  });
});

describe("/clip status", () => {
  it("returns agent and issue data", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "BD Agent" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
      issues: {
        list: vi.fn().mockResolvedValue([
          { id: "i1", identifier: "PROJ-1", title: "Done task" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "status" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    const embed = result.data.embeds[0];
    expect(embed.title).toBe("Paperclip Status");
    expect(embed.fields).toHaveLength(2);
    expect(embed.fields[0].value).toContain("BD Agent");
    expect(embed.fields[1].value).toContain("PROJ-1");
  });

  it("handles empty agents and issues", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "status" }] } },
      defaultCmdCtx,
    ) as any;

    const embed = result.data.embeds[0];
    expect(embed.fields[0].value).toContain("No active agents");
    expect(embed.fields[1].value).toContain("No recent completions");
  });
});

describe("/clip approve", () => {
  it("returns error when id is missing", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "approve", options: [] }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("Missing approval ID");
  });

  it("calls approval API with correct URL", async () => {
    const ctx = makeCtx();
    const cmdCtx = { ...defaultCmdCtx, baseUrl: "https://app.example.com" };
    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "approve", options: [{ name: "id", value: "apr-1" }] }] },
        member: { user: { username: "testuser" } },
      },
      cmdCtx,
    ) as any;

    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://app.example.com/api/approvals/apr-1/approve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.data.embeds[0].color).toBe(COLORS.GREEN);
  });
});

describe("/clip budget", () => {
  it("returns error when agent is missing", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "budget", options: [] }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("Missing agent name");
  });

  it("returns budget data for a found agent", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "BD Agent" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
      state: {
        get: vi.fn().mockResolvedValue({ spent: 15.5, limit: 100 }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "budget", options: [{ name: "agent", value: "BD Agent" }] }] } },
      defaultCmdCtx,
    ) as any;

    const embed = result.data.embeds[0];
    expect(embed.title).toContain("BD Agent");
    expect(embed.fields).toHaveLength(3);
    expect(embed.fields[0].value).toContain("15.50");
    expect(embed.fields[1].value).toContain("100.00");
  });

  it("returns not found for unknown agent", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "budget", options: [{ name: "agent", value: "unknown" }] }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("Agent not found");
  });
});

describe("button clicks", () => {
  it("handles approve button click", async () => {
    const ctx = makeCtx();
    const cmdCtx = { ...defaultCmdCtx, baseUrl: "https://app.example.com" };
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "approval_approve_apr-1" },
        member: { user: { username: "clicker" } },
      },
      cmdCtx,
    ) as any;

    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://app.example.com/api/approvals/apr-1/approve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.type).toBe(7);
    expect(result.data.embeds[0].description).toContain("Approved");
  });

  it("handles reject button click", async () => {
    const ctx = makeCtx();
    const cmdCtx = { ...defaultCmdCtx, baseUrl: "https://app.example.com" };
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "approval_reject_apr-2" },
        member: { user: { username: "clicker" } },
      },
      cmdCtx,
    ) as any;

    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://app.example.com/api/approvals/apr-2/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.type).toBe(7);
    expect(result.data.embeds[0].description).toContain("Rejected");
  });
});

describe("SLASH_COMMANDS", () => {
  it("defines clip and acp commands", () => {
    expect(SLASH_COMMANDS).toHaveLength(2);
    const clip = SLASH_COMMANDS[0]!;
    expect(clip.name).toBe("clip");
    const subNames = clip.options.map((o) => o.name);
    expect(subNames).toEqual(["status", "approve", "budget"]);

    const acp = SLASH_COMMANDS[1]!;
    expect(acp.name).toBe("acp");
  });
});
