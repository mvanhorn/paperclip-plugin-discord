import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, SLASH_COMMANDS, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// `/ask <agent> <text>` (plan item 5).
//
// New work always enters through Emery: the plugin creates a `todo` issue
// assigned to whichever agent is named "Emery", never to the agent named in
// the command. The board-authenticated paperclipFetch call is the same shape
// used elsewhere in this plugin (approve/reject, workflow create_issue).
// ---------------------------------------------------------------------------

const mockPaperclipFetch = vi.fn();
vi.mock("../src/paperclip-fetch.js", () => ({
  paperclipFetch: (...args: unknown[]) => mockPaperclipFetch(...args),
}));

beforeEach(() => {
  mockPaperclipFetch.mockReset();
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: "agent-emery", name: "Emery" },
        { id: "agent-coda", name: "Coda" },
      ]),
    },
    issues: { list: vi.fn().mockResolvedValue([]) },
    companies: { list: vi.fn().mockResolvedValue([]) },
    state: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    events: { emit: vi.fn(), on: vi.fn() },
    ...overrides,
  } as any;
}

const defaultCmdCtx: CommandContext = {
  baseUrl: "http://localhost:3100",
  companyId: "company-1",
  token: "test-token",
  paperclipBoardApiKey: "board-key",
  defaultChannelId: "ch-1",
};

function askInteraction(agent: string, text: string) {
  return {
    type: 2,
    data: { name: "ask", options: [{ name: "agent", value: agent }, { name: "text", value: text }] },
    member: { user: { username: "hanna" } },
  };
}

describe("SLASH_COMMANDS declares /ask", () => {
  it("is registered with agent and text, both required", () => {
    const ask = SLASH_COMMANDS.find((c) => c.name === "ask")!;
    expect(ask).toBeDefined();
    expect(ask.options.map((o: any) => ({ name: o.name, required: o.required }))).toEqual([
      { name: "agent", required: true },
      { name: "text", required: true },
    ]);
  });
});

describe("/ask", () => {
  it("creates a todo issue assigned to Emery, never the named agent", async () => {
    mockPaperclipFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: "issue-1", identifier: "SAG-42" }),
      text: () => Promise.resolve(""),
    });

    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, askInteraction("Coda", "Fix the flaky test"), defaultCmdCtx)) as any;

    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/company-1/issues",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"assigneeAgentId":"agent-emery"'),
      }),
      "board-key",
    );
    const body = JSON.parse(mockPaperclipFetch.mock.calls[0][1].body);
    expect(body.status).toBe("todo");
    expect(body.title).toContain("Coda");
    expect(body.description).toBe("Fix the flaky test");
    expect(body.assigneeAgentId).not.toBe("agent-coda");

    expect(result.data.content).toContain("SAG-42");
  });

  it("returns usage when agent or text is missing", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      { type: 2, data: { name: "ask", options: [{ name: "agent", value: "Coda" }] }, member: { user: { username: "hanna" } } },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("Usage");
    expect(mockPaperclipFetch).not.toHaveBeenCalled();
  });

  it("refuses ephemeral when Emery cannot be found among the company's agents", async () => {
    const ctx = makeCtx({ agents: { list: vi.fn().mockResolvedValue([{ id: "agent-coda", name: "Coda" }]) } });
    const result = (await handleInteraction(ctx, askInteraction("Coda", "Do a thing"), defaultCmdCtx)) as any;

    expect(result.data.content).toContain("Emery");
    expect(result.data.flags).toBe(64);
    expect(mockPaperclipFetch).not.toHaveBeenCalled();
  });

  it("reports failure without throwing when the API call is rejected", async () => {
    mockPaperclipFetch.mockRejectedValue(new Error("boom"));
    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, askInteraction("Coda", "Do a thing"), defaultCmdCtx)) as any;

    expect(result.data.content).toContain("Could not create the issue");
    expect(result.data.flags).toBe(64);
  });
});
