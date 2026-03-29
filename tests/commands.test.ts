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
    companies: {
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

describe("/clip companies", () => {
  it("lists available companies", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme Corp" },
          { id: "c2", name: "Beta Inc" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "companies" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    const embed = result.data.embeds[0];
    expect(embed.title).toBe("Companies (2)");
    expect(embed.description).toContain("Acme Corp");
    expect(embed.description).toContain("Beta Inc");
    expect(embed.description).toContain("c1");
    expect(embed.description).toContain("c2");
    expect(embed.color).toBe(COLORS.BLUE);
  });

  it("handles no companies found", async () => {
    const ctx = makeCtx({
      companies: { list: vi.fn().mockResolvedValue([]) },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "companies" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("No companies found");
  });

  it("handles API error gracefully", async () => {
    const ctx = makeCtx({
      companies: { list: vi.fn().mockRejectedValue(new Error("API unreachable")) },
    });

    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "companies" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("Failed to fetch companies");
    expect(result.data.content).toContain("API unreachable");
  });
});

describe("/clip projects", () => {
  it("lists projects for the default company", async () => {
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve([
        { id: "p1", name: "Project Alpha", status: "in_progress" },
        { id: "p2", name: "Project Beta", status: "completed" },
      ]),
    });

    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "projects" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    const embed = result.data.embeds[0];
    expect(embed.title).toBe("Projects (2)");
    expect(embed.description).toContain("Project Alpha");
    expect(embed.description).toContain("Project Beta");
    expect(embed.description).toContain("In Progress");
    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/default/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("filters by company name", async () => {
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve([
        { id: "p1", name: "My Project", status: "in_progress" },
      ]),
    });

    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme" },
          { id: "c2", name: "Beta" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "projects", options: [{ name: "company", value: "Acme" }] }] },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.embeds[0].title).toBe("Projects (Acme)");
    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/c1/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns error for unknown company filter", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "projects", options: [{ name: "company", value: "Unknown" }] }] },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain('Company "Unknown" not found');
    expect(result.data.content).toContain("Acme");
  });

  it("handles no projects found", async () => {
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve([]),
    });

    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "projects" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("No projects found");
  });

  it("handles API error gracefully", async () => {
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.resolve("Internal Server Error"),
    });

    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      { type: 2, data: { name: "clip", options: [{ name: "projects" }] } },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain("Failed to fetch projects");
  });
});

describe("/clip agents with company filter", () => {
  it("filters agents by company", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme" },
        ]),
      },
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "Engineer", status: "active", title: "Dev" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "agents", options: [{ name: "company", value: "Acme" }] }] },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.embeds[0].title).toBe("Agents (Acme)");
    expect(result.data.embeds[0].description).toContain("Engineer");
    expect(ctx.agents.list).toHaveBeenCalledWith({ companyId: "c1" });
  });

  it("returns error for unknown company", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([{ id: "c1", name: "Acme" }]),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "agents", options: [{ name: "company", value: "Nope" }] }] },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.data.content).toContain('Company "Nope" not found');
  });
});

describe("autocomplete (interaction type 4)", () => {
  it("returns company suggestions for company autocomplete", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme Corp" },
          { id: "c2", name: "Beta Inc" },
          { id: "c3", name: "Gamma LLC" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 4,
        data: {
          name: "clip",
          options: [{
            name: "agents",
            options: [{ name: "company", value: "ac", focused: true }],
          }],
        },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(8);
    expect(result.data.choices).toHaveLength(1);
    expect(result.data.choices[0].name).toBe("Acme Corp");
  });

  it("returns all companies when query is empty", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([
          { id: "c1", name: "Acme" },
          { id: "c2", name: "Beta" },
        ]),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 4,
        data: {
          name: "clip",
          options: [{
            name: "projects",
            options: [{ name: "company", value: "", focused: true }],
          }],
        },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(8);
    expect(result.data.choices).toHaveLength(2);
  });

  it("returns project suggestions for project autocomplete", async () => {
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve([
        { id: "p1", name: "Frontend" },
        { id: "p2", name: "Backend" },
        { id: "p3", name: "Infra" },
      ]),
    });

    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 4,
        data: {
          name: "clip",
          options: [{
            name: "issues",
            options: [{ name: "project", value: "front", focused: true }],
          }],
        },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(8);
    expect(result.data.choices).toHaveLength(1);
    expect(result.data.choices[0].name).toBe("Frontend");
  });

  it("returns empty choices on error", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockRejectedValue(new Error("network error")),
      },
    });

    const result = await handleInteraction(
      ctx,
      {
        type: 4,
        data: {
          name: "clip",
          options: [{
            name: "agents",
            options: [{ name: "company", value: "test", focused: true }],
          }],
        },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(8);
    expect(result.data.choices).toHaveLength(0);
  });

  it("returns empty choices when no focused option", async () => {
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 4,
        data: {
          name: "clip",
          options: [{
            name: "agents",
            options: [{ name: "company", value: "test" }],
          }],
        },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(8);
    expect(result.data.choices).toHaveLength(0);
  });
});

describe("SLASH_COMMANDS", () => {
  it("defines clip and acp commands", () => {
    expect(SLASH_COMMANDS).toHaveLength(2);
    const clip = SLASH_COMMANDS[0]!;
    expect(clip.name).toBe("clip");
    const subNames = clip.options.map((o) => o.name);
    expect(subNames).toEqual(["status", "approve", "budget", "issues", "agents", "companies", "projects", "help", "connect", "connect-channel", "digest", "commands"]);

    const acp = SLASH_COMMANDS[1]!;
    expect(acp.name).toBe("acp");
  });

  it("marks company options as autocomplete-enabled", () => {
    const clip = SLASH_COMMANDS[0]!;
    const agents = clip.options.find((o) => o.name === "agents")!;
    const companyOpt = (agents as any).options?.find((o: any) => o.name === "company");
    expect(companyOpt?.autocomplete).toBe(true);

    const projects = clip.options.find((o) => o.name === "projects")!;
    const projCompanyOpt = (projects as any).options?.find((o: any) => o.name === "company");
    expect(projCompanyOpt?.autocomplete).toBe(true);

    const issues = clip.options.find((o) => o.name === "issues")!;
    const projectOpt = (issues as any).options?.find((o: any) => o.name === "project");
    expect(projectOpt?.autocomplete).toBe(true);
  });
});

describe("issue_reopen button", () => {
  it("calls PATCH to reopen the issue and returns type 7 success", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
    const ctx = makeCtx();
    const cmdCtx = { ...defaultCmdCtx, baseUrl: "https://app.example.com" };
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_reopen_iss-42" },
        member: { user: { username: "reviewer" } },
      },
      cmdCtx,
    ) as any;

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "https://app.example.com/api/issues/iss-42",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toBe("Issue Reopened");
    expect(result.data.embeds[0].description).toContain("reviewer");
    expect(result.data.embeds[0].color).toBe(COLORS.YELLOW);
    expect(result.data.components).toEqual([]);
  });

  it("returns error embed when API fails", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: false, status: 422, headers: new Headers(), text: () => Promise.resolve("Unprocessable Entity") });
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_reopen_iss-fail" },
        member: { user: { username: "reviewer" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toBe("Reopen Failed");
    expect(result.data.embeds[0].color).toBe(COLORS.RED);
    expect(result.data.components).toEqual([]);
  });

  it("sets status to todo in the PATCH body", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
    const ctx = makeCtx();
    await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_reopen_iss-99" },
        member: { user: { username: "user1" } },
      },
      defaultCmdCtx,
    );

    const body = JSON.parse(mockPaperclipFetch.mock.calls[0][1].body);
    expect(body.status).toBe("todo");
    expect(body.comment).toContain("user1");
  });
});

describe("issue_assign button", () => {
  it("calls PATCH to assign and returns ephemeral success", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_assign_iss-55" },
        member: { user: { username: "assignee" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/iss-55",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(result.type).toBe(4);
    expect(result.data.content).toContain("assignee");
    expect(result.data.flags).toBe(64); // ephemeral
  });

  it("returns ephemeral error when API fails", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers(), text: () => Promise.resolve("Forbidden") });
    const ctx = makeCtx();
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_assign_iss-denied" },
        member: { user: { username: "assignee" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("Could not assign");
    expect(result.data.flags).toBe(64);
  });

  it("sends assigneeUserId with discord prefix in body", async () => {
    mockPaperclipFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") });
    const ctx = makeCtx();
    await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_assign_iss-77" },
        member: { user: { username: "bob" } },
      },
      defaultCmdCtx,
    );

    const body = JSON.parse(mockPaperclipFetch.mock.calls[0][1].body);
    expect(body.assigneeUserId).toBe("discord:bob");
  });
});

describe("digest_blocked button", () => {
  it("returns ephemeral list of blocked issues", async () => {
    const ctx = makeCtx({
      issues: {
        list: vi.fn().mockResolvedValue([
          { id: "i1", identifier: "X-1", title: "Stuck task" },
          { id: "i2", identifier: "X-2", title: "Also blocked", blockerReason: "Waiting on deploy" },
        ]),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "digest_blocked_comp-1" },
        member: { user: { username: "viewer" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
    expect(result.data.content).toContain("X-1");
    expect(result.data.content).toContain("X-2");
    expect(result.data.content).toContain("Waiting on deploy");
  });

  it("returns message when no blocked issues", async () => {
    const ctx = makeCtx({
      issues: {
        list: vi.fn().mockResolvedValue([]),
      },
    });
    const result = await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "digest_blocked_comp-2" },
        member: { user: { username: "viewer" } },
      },
      defaultCmdCtx,
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.content).toContain("No blocked issues");
    expect(result.data.flags).toBe(64);
  });

  it("passes companyId and blocked status filter to issues.list", async () => {
    const listMock = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({ issues: { list: listMock } });
    await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "digest_blocked_my-company" },
        member: { user: { username: "viewer" } },
      },
      defaultCmdCtx,
    );

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "my-company", status: "blocked" }),
    );
  });
});
