import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";
import { withRetry } from "./retry.js";

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

interface InteractionData {
  name: string;
  custom_id?: string;
  component_type?: number;
  options?: InteractionOption[];
}

interface Interaction {
  type: number;
  data?: InteractionData;
  member?: { user: { username: string } };
}

export interface CommandContext {
  baseUrl: string;
  companyId: string;
}

function getOption(
  options: InteractionOption[] | undefined,
  name: string,
): string | undefined {
  return options
    ?.find((o) => o.name === name)
    ?.value?.toString();
}

export const SLASH_COMMANDS = [
  {
    name: "clip",
    description: "Manage your Paperclip instance from Discord",
    options: [
      {
        name: "status",
        description: "Show active agents and recent task completions",
        type: 1, // SUB_COMMAND
      },
      {
        name: "approve",
        description: "Approve a pending approval",
        type: 1,
        options: [
          {
            name: "id",
            description: "The approval ID",
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: "budget",
        description: "Check an agent's remaining budget",
        type: 1,
        options: [
          {
            name: "agent",
            description: "Agent name or ID",
            type: 3,
            required: true,
          },
        ],
      },
    ],
  },
];

export async function handleInteraction(
  ctx: PluginContext,
  interaction: Interaction,
  cmdCtx: CommandContext,
): Promise<unknown> {
  if (interaction.type === 1) {
    return { type: 1 }; // PONG
  }

  if (interaction.type === 2 && interaction.data) {
    await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);
    return handleSlashCommand(ctx, interaction.data, interaction.member, cmdCtx);
  }

  if (interaction.type === 3 && interaction.data) {
    return handleButtonClick(ctx, interaction.data, interaction.member?.user.username, cmdCtx);
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown interaction type.",
    ephemeral: true,
  });
}

async function handleSlashCommand(
  ctx: PluginContext,
  data: InteractionData,
  member?: { user: { username: string } },
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/clip status`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name;
  const companyId = cmdCtx?.companyId ?? "default";
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";

  switch (subName) {
    case "status":
      return handleStatus(ctx, companyId);
    case "approve":
      return handleApprove(
        ctx,
        getOption(subcommand.options ?? [], "id"),
        member?.user.username,
        baseUrl,
      );
    case "budget":
      return handleBudget(ctx, getOption(subcommand.options ?? [], "agent"), companyId);
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown command: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleStatus(ctx: PluginContext, companyId: string): Promise<unknown> {
  try {
    const agents = await ctx.agents.list({ companyId, status: "active" });
    const issues = await ctx.issues.list({ companyId, status: "done", limit: 5 });

    const agentList = agents.length > 0
      ? agents.map((a) => `- **${a.name ?? a.id}**`).join("\n")
      : "No active agents";

    const issueList = issues.length > 0
      ? issues.map((i) => `- **${i.identifier ?? i.id}** ${i.title ?? ""}`).join("\n")
      : "No recent completions";

    const embeds: DiscordEmbed[] = [
      {
        title: "Paperclip Status",
        color: COLORS.BLUE,
        fields: [
          { name: `Active Agents (${agents.length})`, value: agentList },
          { name: `Recent Completions (${issues.length})`, value: issueList },
        ],
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({
      type: 4,
      embeds,
      ephemeral: true,
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch status: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleApprove(
  ctx: PluginContext,
  approvalId: string | undefined,
  username?: string,
  baseUrl?: string,
): Promise<unknown> {
  if (!approvalId) {
    return respondToInteraction({
      type: 4,
      content: "Missing approval ID. Usage: `/clip approve id:<approval-id>`",
      ephemeral: true,
    });
  }

  try {
    const url = `${baseUrl ?? "http://localhost:3100"}/api/approvals/${approvalId}/approve`;
    await withRetry(() =>
      ctx.http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: `discord:${username ?? "unknown"}` }),
      }),
    );

    await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    ctx.logger.info("Approval via Discord", { approvalId, username });

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Approval Resolved",
        description: `**Approved** \`${approvalId}\` by ${username ?? "Discord user"}`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
      ephemeral: false,
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to approve ${approvalId}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleBudget(
  ctx: PluginContext,
  agentQuery: string | undefined,
  companyId: string,
): Promise<unknown> {
  if (!agentQuery) {
    return respondToInteraction({
      type: 4,
      content: "Missing agent name. Usage: `/clip budget agent:<name>`",
      ephemeral: true,
    });
  }

  try {
    const agents = await ctx.agents.list({ companyId });
    const agent = agents.find(
      (a) =>
        a.id === agentQuery || a.name === agentQuery ||
        a.name.toLowerCase() === agentQuery.toLowerCase(),
    );

    if (!agent) {
      return respondToInteraction({
        type: 4,
        content: `Agent not found: ${agentQuery}`,
        ephemeral: true,
      });
    }

    const agentId = agent.id;
    const budgetState = await ctx.state.get({
      scopeKind: "agent",
      scopeId: agentId,
      stateKey: "budget",
    }) as { spent?: number; limit?: number } | null;

    const spent = budgetState?.spent ?? 0;
    const limit = budgetState?.limit ?? 0;
    const remaining = limit - spent;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;

    return respondToInteraction({
      type: 4,
      embeds: [
        {
          title: `Budget: ${agent.name ?? agentId}`,
          color: remaining > 0 ? COLORS.GREEN : COLORS.RED,
          fields: [
            { name: "Spent", value: `$${spent.toFixed(2)}`, inline: true },
            { name: "Limit", value: `$${limit.toFixed(2)}`, inline: true },
            { name: "Remaining", value: `$${remaining.toFixed(2)} (${pct}% used)`, inline: true },
          ],
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        },
      ],
      ephemeral: true,
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to look up budget for ${agentQuery}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleButtonClick(
  ctx: PluginContext,
  data: InteractionData,
  username?: string,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const customId = data.custom_id ?? data.name;
  const actor = username ?? "Discord user";
  const base = cmdCtx?.baseUrl ?? "http://localhost:3100";

  if (customId.startsWith("approval_approve_")) {
    const approvalId = customId.replace("approval_approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, action: "approve", actor });

    try {
      await withRetry(() =>
        ctx.http.fetch(
          `${base}/api/approvals/${approvalId}/approve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
          },
        ),
      );
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to approve via API", { approvalId, error: String(err) });
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Approved** by ${actor}`,
          color: COLORS.GREEN,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  if (customId.startsWith("approval_reject_")) {
    const approvalId = customId.replace("approval_reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, action: "reject", actor });

    try {
      await withRetry(() =>
        ctx.http.fetch(
          `${base}/api/approvals/${approvalId}/reject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
          },
        ),
      );
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to reject via API", { approvalId, error: String(err) });
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Rejected** by ${actor}`,
          color: COLORS.RED,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown button action.",
    ephemeral: true,
  });
}
