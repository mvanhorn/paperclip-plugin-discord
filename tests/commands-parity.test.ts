/**
 * Tests for Phase A and Phase B new /clip subcommands and button handlers.
 * Covers gap items 1-6 (issues, agents, help, connect, connect-channel, digest)
 * and gap items 7-10 (commands import/list/run/delete) + workflow approval buttons.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
      sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
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
  companyId: "company-1",
  token: "test-token",
  defaultChannelId: "ch-1",
};

function clipInteraction(subName: string, options?: Array<{ name: string; value?: string | number }>) {
  return {
    type: 2,
    data: { name: "clip", options: [{ name: subName, options: options ?? [] }] },
    member: { user: { username: "testuser" } },
  };
}

// ---------------------------------------------------------------------------
// Gap 1: /clip issues
// ---------------------------------------------------------------------------

describe("/clip issues", () => {
  it("returns issue list with status emojis", async () => {
    const ctx = makeCtx({
      issues: {
        list: vi.fn().mockResolvedValue([
          { id: "i1", identifier: "TUM-1", title: "Fix bug", status: "in_progress", project: { name: "proj-a" } },
          { id: "i2", identifier: "TUM-2", title: "Add feature", status: "todo", project: { name: "proj-a" } },
        ]),
      },
    });

    const result = (await handleInteraction(ctx, clipInteraction("issues"), defaultCmdCtx)) as any;
    expect(result.type).toBe(4);
    expect(result.data.embeds[0].title).toContain("Open Issues");
    expect(result.data.embeds[0].fields).toHaveLength(2);
    expect(result.data.embeds[0].fields[0].name).toContain("🔄");
    expect(result.data.embeds[0].fields[0].name).toContain("TUM-1");
    expect(result.data.embeds[0].fields[0].name).toContain("In Progress");
    expect(result.data.embeds[0].fields[1].name).toContain("📋");
    expect(result.data.embeds[0].fields[1].name).toContain("To Do");
  });

  it("filters by project name", async () => {
    const ctx = makeCtx({
      issues: {
        list: vi.fn().mockResolvedValue([
          { id: "i1", identifier: "TUM-1", title: "Fix bug", status: "todo", project: { name: "backend" } },
          { id: "i2", identifier: "TUM-2", title: "UI tweak", status: "todo", project: { name: "frontend" } },
        ]),
      },
    });

    const result = (await handleInteraction(
      ctx,
      clipInteraction("issues", [{ name: "project", value: "backend" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].fields).toHaveLength(1);
    expect(result.data.embeds[0].fields[0].name).toContain("TUM-1");
  });

  it("returns empty state when no issues", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, clipInteraction("issues"), defaultCmdCtx)) as any;
    expect(result.type).toBe(4);
    expect(result.data.content).toContain("No issues found");
  });

  it("handles API errors gracefully", async () => {
    const ctx = makeCtx({
      issues: { list: vi.fn().mockRejectedValue(new Error("API down")) },
    });
    const result = (await handleInteraction(ctx, clipInteraction("issues"), defaultCmdCtx)) as any;
    expect(result.data.content).toContain("Failed to fetch issues");
    expect(result.data.content).toContain("API down");
  });
});

// ---------------------------------------------------------------------------
// Gap 2: /clip agents
// ---------------------------------------------------------------------------

describe("/clip agents", () => {
  it("lists agents with status emojis", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "CEO", status: "active" },
          { id: "a2", name: "Engineer", status: "running" },
          { id: "a3", name: "QA", status: "paused" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
    });

    const result = (await handleInteraction(ctx, clipInteraction("agents"), defaultCmdCtx)) as any;
    expect(result.type).toBe(4);
    expect(result.data.embeds[0].title).toBe("Agents");
    expect(result.data.embeds[0].description).toContain("🟢");
    expect(result.data.embeds[0].description).toContain("🔵");
    expect(result.data.embeds[0].description).toContain("🟡");
    expect(result.data.embeds[0].description).toContain("CEO");
  });

  it("shows agent title or role when available", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "a1", name: "CEO", status: "active", title: "Chief Executive Officer" },
          { id: "a2", name: "Engineer", status: "running", role: "engineer" },
          { id: "a3", name: "QA", status: "paused" },
        ]),
        sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
        invoke: vi.fn(),
      },
    });

    const result = (await handleInteraction(ctx, clipInteraction("agents"), defaultCmdCtx)) as any;
    const desc = result.data.embeds[0].description;
    expect(desc).toContain("Chief Executive Officer");
    expect(desc).toContain("engineer");
    // QA has no title/role, should just show name and status
    expect(desc).toContain("QA");
    // Should show humanized status labels
    expect(desc).toContain("Active");
    expect(desc).toContain("Running");
    expect(desc).toContain("Paused");
  });

  it("returns empty state when no agents", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, clipInteraction("agents"), defaultCmdCtx)) as any;
    expect(result.data.content).toContain("No agents found");
  });
});

// ---------------------------------------------------------------------------
// Gap 3: /clip help
// ---------------------------------------------------------------------------

describe("/clip help", () => {
  it("lists all commands including /clip and /acp", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, clipInteraction("help"), defaultCmdCtx)) as any;
    expect(result.type).toBe(4);
    expect(result.data.embeds[0].title).toContain("Commands");
    const desc = result.data.embeds[0].description;
    expect(desc).toContain("/clip status");
    expect(desc).toContain("/clip issues");
    expect(desc).toContain("/clip agents");
    expect(desc).toContain("/clip connect");
    expect(desc).toContain("/clip digest");
    expect(desc).toContain("/clip commands");
    expect(desc).toContain("/acp spawn");
    expect(desc).toContain("/acp status");
    expect(desc).toContain("/acp cancel");
    expect(desc).toContain("/acp close");
  });
});

// ---------------------------------------------------------------------------
// Gap 4: /clip connect
// ---------------------------------------------------------------------------

describe("/clip connect", () => {
  it("shows usage when no company arg", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([{ id: "c1", name: "Acme Corp" }]),
      },
    });
    const result = (await handleInteraction(ctx, clipInteraction("connect"), defaultCmdCtx)) as any;
    expect(result.data.content).toContain("Usage");
    expect(result.data.content).toContain("Acme Corp");
  });

  it("stores company mapping on valid match", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([{ id: "c1", name: "Acme Corp" }]),
      },
    });

    const result = (await handleInteraction(
      ctx,
      clipInteraction("connect", [{ name: "company", value: "Acme Corp" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Company Connected");
    expect(result.data.embeds[0].description).toContain("Acme Corp");
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "company_default" }),
      expect.objectContaining({ companyId: "c1", companyName: "Acme Corp" }),
    );
  });

  it("matches case-insensitively", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([{ id: "c1", name: "Acme Corp" }]),
      },
    });

    const result = (await handleInteraction(
      ctx,
      clipInteraction("connect", [{ name: "company", value: "acme corp" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Company Connected");
  });

  it("returns not found for invalid company", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockResolvedValue([{ id: "c1", name: "Acme Corp" }]),
      },
    });

    const result = (await handleInteraction(
      ctx,
      clipInteraction("connect", [{ name: "company", value: "NonExistent" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("not found");
    expect(result.data.content).toContain("Acme Corp");
  });
});

// ---------------------------------------------------------------------------
// Gap 5: /clip connect-channel
// ---------------------------------------------------------------------------

describe("/clip connect-channel", () => {
  it("maps project to channel", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("connect-channel", [{ name: "project", value: "my-project" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Channel Mapped");
    expect(result.data.embeds[0].description).toContain("my-project");
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "channel-project-map" }),
      expect.objectContaining({ "my-project": "pending" }),
    );
  });

  it("returns usage when project name is empty", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("connect-channel", [{ name: "project", value: "" }]),
      defaultCmdCtx,
    )) as any;
    expect(result.data.content).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// Gap 6: /clip digest
// ---------------------------------------------------------------------------

describe("/clip digest", () => {
  it("enables daily digest", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest", [{ name: "action", value: "on" }, { name: "mode", value: "daily" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Digest Enabled");
    expect(result.data.embeds[0].description).toContain("daily");
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "digest-config" }),
      expect.objectContaining({ mode: "daily", enabled: true }),
    );
  });

  it("enables bidaily digest", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest", [{ name: "action", value: "on" }, { name: "mode", value: "bidaily" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].description).toContain("bidaily");
  });

  it("defaults to daily when mode not specified", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest", [{ name: "action", value: "on" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].description).toContain("daily");
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "daily" }),
    );
  });

  it("disables digest", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest", [{ name: "action", value: "off" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Digest Disabled");
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "off", enabled: false }),
    );
  });

  it("shows current status", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockResolvedValue({ mode: "bidaily", enabled: true });

    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest", [{ name: "action", value: "status" }]),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Digest Configuration");
    const fields = result.data.embeds[0].fields;
    expect(fields.find((f: any) => f.name === "Enabled").value).toBe("Yes");
    expect(fields.find((f: any) => f.name === "Mode").value).toBe("bidaily");
  });

  it("defaults to status when no action specified", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockResolvedValue(null);

    const result = (await handleInteraction(
      ctx,
      clipInteraction("digest"),
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Digest Configuration");
    const fields = result.data.embeds[0].fields;
    expect(fields.find((f: any) => f.name === "Enabled").value).toBe("No");
    expect(fields.find((f: any) => f.name === "Mode").value).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// Gap 7: /clip commands import
// ---------------------------------------------------------------------------

describe("/clip commands import", () => {
  it("imports valid workflow JSON", async () => {
    const ctx = makeCtx();
    const json = JSON.stringify({
      name: "greet",
      description: "Greet users",
      steps: [{ type: "send_message", message: "Hello!" }],
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{
              name: "import",
              options: [{ name: "json", value: json }],
            }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Workflow Imported");
    expect(result.data.embeds[0].description).toContain("greet");
    expect(result.data.embeds[0].description).toContain("1 step(s)");
  });

  it("rejects invalid JSON", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "import", options: [{ name: "json", value: "not-json{" }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("Invalid JSON");
  });

  it("rejects workflow without name", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "import", options: [{ name: "json", value: '{"steps":[{"type":"set_state"}]}' }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("name");
  });

  it("rejects workflow without steps", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "import", options: [{ name: "json", value: '{"name":"test","steps":[]}' }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("at least one step");
  });

  it("rejects overriding built-in command names", async () => {
    const ctx = makeCtx();
    const json = JSON.stringify({ name: "status", steps: [{ type: "set_state", stateKey: "k" }] });
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "import", options: [{ name: "json", value: json }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("built-in");
  });

  it("returns usage when json option is empty", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{ name: "commands", options: [{ name: "import", options: [] }] }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// Gap 8: /clip commands list
// ---------------------------------------------------------------------------

describe("/clip commands list", () => {
  it("shows 'no commands' when store is empty", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "commands", options: [{ name: "list" }] }] },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("No workflow commands");
  });

  it("lists registered commands", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockResolvedValue({
      workflows: {
        greet: { name: "greet", steps: [{ type: "send_message" }], createdAt: "2026-01-15T00:00:00Z", description: "Say hi" },
        deploy: { name: "deploy", steps: [{ type: "invoke_agent" }, { type: "send_message" }], createdAt: "2026-02-01T00:00:00Z" },
      },
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "commands", options: [{ name: "list" }] }] },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Workflow Commands");
    expect(result.data.embeds[0].description).toContain("greet");
    expect(result.data.embeds[0].description).toContain("1 step(s)");
    expect(result.data.embeds[0].description).toContain("deploy");
    expect(result.data.embeds[0].description).toContain("2 step(s)");
  });
});

// ---------------------------------------------------------------------------
// Gap 9: /clip commands run
// ---------------------------------------------------------------------------

describe("/clip commands run", () => {
  it("returns not found for unknown command", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "run", options: [{ name: "name", value: "nonexistent" }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("not found");
  });

  it("returns usage when name is empty", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "run", options: [] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("Usage");
  });

  it("executes a set_state-only workflow successfully", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockResolvedValue({
      workflows: {
        simple: {
          name: "simple",
          steps: [{ type: "set_state", stateKey: "k", stateValue: "v" }],
          createdAt: "2026-01-01",
        },
      },
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "run", options: [{ name: "name", value: "simple" }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toContain("Workflow Complete");
    expect(result.data.embeds[0].color).toBe(COLORS.GREEN);
  });
});

// ---------------------------------------------------------------------------
// Gap 10: /clip commands delete
// ---------------------------------------------------------------------------

describe("/clip commands delete", () => {
  it("deletes an existing workflow", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockResolvedValue({
      workflows: {
        greet: { name: "greet", steps: [{ type: "send_message" }], createdAt: "2026-01-01" },
      },
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "delete", options: [{ name: "name", value: "greet" }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.embeds[0].title).toBe("Workflow Deleted");
    expect(result.data.embeds[0].description).toContain("greet");
  });

  it("returns not found for unknown workflow", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "delete", options: [{ name: "name", value: "nonexistent" }] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("not found");
  });

  it("returns usage when name is empty", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{
            name: "commands",
            options: [{ name: "delete", options: [] }],
          }],
        },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// Workflow approval buttons (wf_approve / wf_reject)
// ---------------------------------------------------------------------------

describe("workflow approval buttons", () => {
  it("handles wf_approve_ button click", async () => {
    const ctx = makeCtx();
    // Mock a pending workflow
    ctx.state.get.mockImplementation(({ stateKey }: { stateKey: string }) => {
      if (stateKey.startsWith("wf_pending_")) {
        return {
          workflowName: "test-wf",
          stepIndex: 0,
          wfCtx: { args: [], fullArgs: "", results: {}, state: {} },
        };
      }
      // Return workflow store
      if (stateKey.startsWith("commands_")) {
        return {
          workflows: {
            "test-wf": {
              name: "test-wf",
              steps: [
                { type: "wait_approval", approvalMessage: "Proceed?" },
                { type: "set_state", stateKey: "done", stateValue: "yes" },
              ],
              createdAt: "2026-01-01",
            },
          },
        };
      }
      return null;
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "wf_approve_test-approval-id", custom_id: "wf_approve_test-approval-id", component_type: 2 },
        member: { user: { username: "approver" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("Approved");
    expect(result.data.embeds[0].color).toBe(COLORS.GREEN);
  });

  it("handles wf_reject_ button click", async () => {
    const ctx = makeCtx();
    ctx.state.get.mockImplementation(({ stateKey }: { stateKey: string }) => {
      if (stateKey.startsWith("wf_pending_")) {
        return {
          workflowName: "test-wf",
          stepIndex: 0,
          wfCtx: { args: [], fullArgs: "", results: {}, state: {} },
        };
      }
      return null;
    });

    const result = (await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "wf_reject_test-approval-id", custom_id: "wf_reject_test-approval-id", component_type: 2 },
        member: { user: { username: "rejector" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.type).toBe(7);
    expect(result.data.embeds[0].title).toContain("Rejected");
    expect(result.data.embeds[0].color).toBe(COLORS.RED);
  });
});

// ---------------------------------------------------------------------------
// /clip commands — missing subcommand
// ---------------------------------------------------------------------------

describe("/clip commands — edge cases", () => {
  it("returns missing subcommand message", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "commands", options: [] }] },
        member: { user: { username: "testuser" } },
      },
      defaultCmdCtx,
    )) as any;

    expect(result.data.content).toContain("Missing subcommand");
  });
});
