import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postEmbed } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Phase 4: Custom Commands
//   - Command registry (agents register commands via tool)
//   - Parser (detects !command in Discord messages)
//   - Executor (routes to registering agent)
// ---------------------------------------------------------------------------

export interface CommandParameter {
  name: string;
  description: string;
  required: boolean;
}

export interface CustomCommand {
  command: string;
  description: string;
  parameters: CommandParameter[];
  agentId: string;
  agentName: string;
  companyId: string;
  registeredAt: string;
}

interface CommandRegistry {
  commands: CustomCommand[];
}

// ---------------------------------------------------------------------------
// Registry state helpers
// ---------------------------------------------------------------------------

async function getRegistry(ctx: PluginContext, companyId: string): Promise<CustomCommand[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "custom_commands",
  });
  if (!raw) return [];
  return (raw as CommandRegistry).commands ?? [];
}

async function saveRegistry(ctx: PluginContext, companyId: string, commands: CustomCommand[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: "custom_commands" },
    { commands } as CommandRegistry,
  );
}

// ---------------------------------------------------------------------------
// Register a command
// ---------------------------------------------------------------------------

export async function registerCommand(
  ctx: PluginContext,
  companyId: string,
  command: string,
  description: string,
  parameters: CommandParameter[],
  agentId: string,
  agentName: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = command.toLowerCase().replace(/^!/, "").trim();
  if (!normalized || normalized.includes(" ")) {
    return { ok: false, error: "Command name must be a single word without spaces." };
  }

  const registry = await getRegistry(ctx, companyId);

  const existing = registry.find((c) => c.command === normalized);
  if (existing) {
    existing.description = description;
    existing.parameters = parameters;
    existing.agentId = agentId;
    existing.agentName = agentName;
    existing.registeredAt = new Date().toISOString();
  } else {
    registry.push({
      command: normalized,
      description,
      parameters,
      agentId,
      agentName,
      companyId,
      registeredAt: new Date().toISOString(),
    });
  }

  await saveRegistry(ctx, companyId, registry);
  ctx.logger.info("Custom command registered", { command: normalized, agentName });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Parse a message for !command invocations
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  command: string;
  args: string;
  rawText: string;
}

export function parseCommandMessage(text: string): ParsedCommand | null {
  const match = text.match(/^!(\S+)\s*(.*)?$/s);
  if (!match) return null;
  return {
    command: match[1]!.toLowerCase(),
    args: (match[2] ?? "").trim(),
    rawText: text,
  };
}

// ---------------------------------------------------------------------------
// Execute a parsed command
// ---------------------------------------------------------------------------

export async function executeCommand(
  ctx: PluginContext,
  token: string,
  channelId: string,
  parsed: ParsedCommand,
  companyId: string,
): Promise<boolean> {
  const registry = await getRegistry(ctx, companyId);
  const cmd = registry.find((c) => c.command === parsed.command);

  if (!cmd) return false;

  ctx.logger.info("Executing custom command", {
    command: parsed.command,
    agentName: cmd.agentName,
    channelId,
  });

  await postEmbed(ctx, token, channelId, {
    embeds: [{
      title: `Running: !${cmd.command}`,
      description: `Routing to **${cmd.agentName}**...`,
      color: COLORS.BLUE,
      fields: cmd.parameters.length > 0
        ? [{ name: "Args", value: parsed.args || "(none)" }]
        : [],
      footer: { text: "Paperclip Custom Command" },
      timestamp: new Date().toISOString(),
    }],
  });

  try {
    const prompt = `Execute command !${cmd.command}${parsed.args ? ` with arguments: ${parsed.args}` : ""}`;
    await ctx.agents.invoke(cmd.agentId, companyId, {
      prompt,
      reason: `Discord custom command: !${cmd.command}`,
    });
    await ctx.metrics.write(METRIC_NAMES.customCommandsExecuted, 1);
    return true;
  } catch (err) {
    ctx.logger.error("Custom command execution failed", {
      command: parsed.command,
      error: err instanceof Error ? err.message : String(err),
    });

    await postEmbed(ctx, token, channelId, {
      embeds: [{
        title: `Command Failed: !${cmd.command}`,
        description: `Failed to invoke **${cmd.agentName}**: ${err instanceof Error ? err.message : String(err)}`,
        color: COLORS.RED,
        footer: { text: "Paperclip Custom Command" },
        timestamp: new Date().toISOString(),
      }],
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// List commands (for help)
// ---------------------------------------------------------------------------

export async function listCommands(
  ctx: PluginContext,
  companyId: string,
): Promise<CustomCommand[]> {
  return getRegistry(ctx, companyId);
}
