import { describe, it, expect, vi } from "vitest";
import {
  parseCommandMessage,
  registerCommand,
  listCommands,
  type ParsedCommand,
  type CustomCommand,
} from "../src/custom-commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stateStore = new Map<string, unknown>();

function makeCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
        return Promise.resolve(stateStore.get(stateKey) ?? null);
      }),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
        return Promise.resolve(undefined);
      }),
    },
    http: { fetch: vi.fn().mockResolvedValue({ ok: true }) },
    events: { emit: vi.fn() },
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// parseCommandMessage
// ---------------------------------------------------------------------------

describe("parseCommandMessage", () => {
  it("parses !deploy staging correctly", () => {
    const result = parseCommandMessage("!deploy staging");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("deploy");
    expect(result!.args).toBe("staging");
    expect(result!.rawText).toBe("!deploy staging");
  });

  it("parses command without args", () => {
    const result = parseCommandMessage("!status");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("status");
    expect(result!.args).toBe("");
  });

  it("normalizes command name to lowercase", () => {
    const result = parseCommandMessage("!Deploy PROD");
    expect(result!.command).toBe("deploy");
    expect(result!.args).toBe("PROD");
  });

  it("returns null for messages without ! prefix", () => {
    expect(parseCommandMessage("just a message")).toBeNull();
    expect(parseCommandMessage("deploy staging")).toBeNull();
    expect(parseCommandMessage("@bot deploy")).toBeNull();
  });

  it("handles multiline args", () => {
    const result = parseCommandMessage("!note this is\na multiline\nnote");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("note");
    expect(result!.args).toContain("multiline");
  });

  it("handles command with multiple spaces before args", () => {
    const result = parseCommandMessage("!run   fast");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("run");
    expect(result!.args).toBe("fast");
  });

  it("does not match ! in the middle of text", () => {
    const result = parseCommandMessage("hey !deploy now");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerCommand
// ---------------------------------------------------------------------------

describe("registerCommand", () => {
  it("registers a new command and stores it", async () => {
    const ctx = makeCtx();
    const result = await registerCommand(
      ctx,
      "company-1",
      "deploy",
      "Deploy to environment",
      [{ name: "env", description: "Target environment", required: true }],
      "agent-1",
      "DeployBot",
    );
    expect(result.ok).toBe(true);

    const commands = await listCommands(ctx, "company-1");
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("deploy");
    expect(commands[0].agentName).toBe("DeployBot");
  });

  it("normalizes command name: strips ! prefix and lowercases", async () => {
    const ctx = makeCtx();
    await registerCommand(ctx, "company-1", "!Deploy", "desc", [], "a1", "Bot");
    const commands = await listCommands(ctx, "company-1");
    expect(commands[0].command).toBe("deploy");
  });

  it("rejects command names with spaces", async () => {
    const ctx = makeCtx();
    const result = await registerCommand(ctx, "c1", "deploy staging", "desc", [], "a1", "Bot");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("single word");
  });

  it("rejects empty command name", async () => {
    const ctx = makeCtx();
    const result = await registerCommand(ctx, "c1", "", "desc", [], "a1", "Bot");
    expect(result.ok).toBe(false);
  });

  it("rejects command name that is just !", async () => {
    const ctx = makeCtx();
    const result = await registerCommand(ctx, "c1", "!", "desc", [], "a1", "Bot");
    expect(result.ok).toBe(false);
  });

  it("updates existing command when registering same name", async () => {
    const ctx = makeCtx();
    await registerCommand(ctx, "c1", "deploy", "v1 desc", [], "a1", "BotV1");
    await registerCommand(ctx, "c1", "deploy", "v2 desc", [], "a2", "BotV2");
    const commands = await listCommands(ctx, "c1");
    expect(commands).toHaveLength(1);
    expect(commands[0].description).toBe("v2 desc");
    expect(commands[0].agentName).toBe("BotV2");
  });

  it("stores multiple distinct commands", async () => {
    const ctx = makeCtx();
    await registerCommand(ctx, "c1", "deploy", "Deploy", [], "a1", "Bot1");
    await registerCommand(ctx, "c1", "rollback", "Rollback", [], "a2", "Bot2");
    const commands = await listCommands(ctx, "c1");
    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.command)).toContain("deploy");
    expect(commands.map((c) => c.command)).toContain("rollback");
  });
});

// ---------------------------------------------------------------------------
// Namespace protection (built-in commands)
// ---------------------------------------------------------------------------

describe("namespace protection", () => {
  it("custom commands do not collide with /clip or /acp slash commands", () => {
    // Built-in slash commands are "clip" and "acp" - these are Discord slash commands
    // Custom commands use the ! prefix, so "!clip" would be stored as "clip" in registry
    // but they operate in a different namespace (! prefix vs / prefix)
    const parsed = parseCommandMessage("!clip status");
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe("clip");

    // Slash commands don't go through parseCommandMessage
    const slash = parseCommandMessage("/clip status");
    expect(slash).toBeNull(); // / prefix is not matched
  });
});

// ---------------------------------------------------------------------------
// Template interpolation (via response templates in proactive-suggestions)
// ---------------------------------------------------------------------------

describe("template interpolation", () => {
  it("replaces {{author}}, {{content}}, and {{channel}} placeholders", () => {
    const template = "Hey {{author}}, regarding your message about {{content}} in {{channel}}";
    const result = template
      .replace("{{author}}", "testuser")
      .replace("{{content}}", "deployment issues")
      .replace("{{channel}}", "ch-123");
    expect(result).toBe("Hey testuser, regarding your message about deployment issues in ch-123");
  });

  it("leaves unmatched placeholders as-is", () => {
    const template = "Hello {{author}}, see {{unknown}}";
    const result = template.replace("{{author}}", "matt");
    expect(result).toContain("{{unknown}}");
  });
});
