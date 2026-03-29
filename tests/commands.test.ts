import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, SLASH_COMMANDS, type CommandContext } from "../src/commands.js";
import { COLORS } from "../src/constants.js";

const mockPaperclipFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
vi.mock("../src/paperclip-fetch.js", () => ({
  paperclipFetch: (...args: unknown[]) => mockPaperclipFetch(...args),
}));

beforeEach(() => {
  mockPaperclipFetch.mockReset().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
});

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

  it("shows agent title in status when available", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "CEO", title: "Chief Executive Officer" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
      issues: {
        list: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "status" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.embeds[0].fields[0].value).toContain("CEO");
    expect(result.data.embeds[0].fields[0].value).toContain("Chief Executive Officer");
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

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "https://app.example.com/api/approvals/apr-1/approve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.data.embeds[0].color).toBe(COLORS.GREEN);
  });

  it("returns error when API returns non-OK status (Bug 1 regression)", async () => {
    mockPaperclipFetch.mockResolvedValue({
      ok: false,
      status: 422,
      headers: new Headers(),
      text: () => Promise.resolve("Unprocessable Entity"),
    });
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "approve", options: [{ name: "id", value: "apr-bad" }] }] },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("Failed to approve");
    expect(result.data.content).toContain("API 422");
    expect(result.data.flags).toBe(64); // ephemeral
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

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
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

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "https://app.example.com/api/approvals/apr-2/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.type).toBe(7);
    expect(result.data.embeds[0].description).toContain("Rejected");
  });

  it("shows failure when approve API call fails", async () => {
    mockPaperclipFetch.mockRejectedValueOnce(new Error("All resolved IPs for localhost are in private/reserved ranges"));
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "approval_approve_apr-fail" },
        member: { user: { username: "clicker" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toBe("Approval Failed");
    expect(result.data.embeds[0].color).toBe(COLORS.RED);
    expect(result.data.embeds[0].description).toContain("private/reserved");
  });

  it("shows failure when reject API call fails", async () => {
    mockPaperclipFetch.mockRejectedValueOnce(new Error("Network error"));
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "approval_reject_apr-fail" },
        member: { user: { username: "clicker" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toBe("Rejection Failed");
    expect(result.data.embeds[0].color).toBe(COLORS.RED);
  });

  it("shows failure when API returns non-ok status", async () => {
    mockPaperclipFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: () => Promise.resolve("Forbidden"),
    });
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "approval_approve_apr-403" },
        member: { user: { username: "clicker" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toBe("Approval Failed");
    expect(result.data.embeds[0].description).toContain("API 403");
  });
});

describe("escalation button clicks", () => {
  it("parses esc_suggest_ button and resolves escalation", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockResolvedValue({
          escalationId: "esc123",
          companyId: "default",
          agentName: "SupportBot",
          reason: "Customer angry",
          suggestedReply: "I understand your concern",
          status: "pending",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_suggest_esc123" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("RESOLVED");
    expect(result.data.embeds[0].description).toContain("Suggested reply accepted");
  });

  it("parses esc_reply_ button", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockResolvedValue({
          escalationId: "esc456",
          companyId: "default",
          agentName: "SupportBot",
          reason: "Complex question",
          status: "pending",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_reply_esc456" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].description).toContain("replying to the customer");
  });

  it("parses esc_override_ button", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockResolvedValue({
          escalationId: "esc789",
          companyId: "default",
          agentName: "SupportBot",
          reason: "Wrong answer given",
          status: "pending",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_override_esc789" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("OVERRIDDEN");
  });

  it("parses esc_dismiss_ button", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockResolvedValue({
          escalationId: "esc000",
          companyId: "default",
          agentName: "SupportBot",
          reason: "False alarm",
          status: "pending",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_dismiss_esc000" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("DISMISSED");
  });

  it("returns not found for nonexistent escalation", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_suggest_nonexistent" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("not found");
  });

  it("returns already resolved for non-pending escalation", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockResolvedValue({
          escalationId: "esc-done",
          companyId: "default",
          agentName: "Bot",
          reason: "test",
          status: "resolved",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "esc_suggest_esc-done" },
        member: { user: { username: "admin" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("already resolved");
  });
});

describe("handoff button clicks", () => {
  it("parses handoff_approve_ and spawns target agent", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
          if (stateKey.startsWith("handoff_")) {
            return Promise.resolve({
              handoffId: "hoff123",
              threadId: "thread-1",
              fromAgent: "AgentA",
              toAgent: "AgentB",
              toAgentId: "agent-b",
              companyId: "default",
              reason: "Need specialist",
              status: "pending",
              createdAt: "2026-03-15T12:00:00Z",
            });
          }
          if (stateKey.startsWith("sessions_")) {
            return Promise.resolve({ sessions: [] });
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      agents: {
        list: vi.fn().mockResolvedValue([{ id: "agent-b", name: "AgentB" }]),
        sessions: {
          create: vi.fn().mockResolvedValue({ sessionId: "sess-new" }),
          sendMessage: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
        },
        invoke: vi.fn(),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "handoff_approve_hoff123" },
        member: { user: { username: "approver" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("Approved");
    expect(result.data.embeds[0].description).toContain("AgentB");
  });

  it("parses handoff_reject_ and keeps original agent", async () => {
    const ctx = makeCtx({
      state: {
        get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
          if (stateKey.startsWith("handoff_")) {
            return Promise.resolve({
              handoffId: "hoff456",
              threadId: "thread-1",
              fromAgent: "AgentA",
              toAgent: "AgentB",
              toAgentId: "agent-b",
              companyId: "default",
              reason: "Not needed",
              status: "pending",
              createdAt: "2026-03-15T12:00:00Z",
            });
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "handoff_reject_hoff456" },
        member: { user: { username: "rejector" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("Rejected");
    expect(result.data.embeds[0].description).toContain("AgentA");
  });

  it("returns not found for nonexistent handoff", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "handoff_approve_nonexistent" },
        member: { user: { username: "user" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("not found");
  });
});

describe("unknown button clicks", () => {
  it("returns unknown button action for unrecognized custom_id", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "totally_unknown_action" },
        member: { user: { username: "user" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("Unknown button action");
  });
});

describe("SLASH_COMMANDS", () => {
  it("defines clip and acp commands", () => {
    expect(SLASH_COMMANDS).toHaveLength(2);
    const clip = SLASH_COMMANDS[0]!;
    expect(clip.name).toBe("clip");
    const subNames = clip.options.map((o) => o.name);
    expect(subNames).toEqual(["status", "approve", "budget", "issues", "agents", "help", "connect", "connect-channel", "digest", "commands"]);

    const acp = SLASH_COMMANDS[1]!;
    expect(acp.name).toBe("acp");
  });
});
