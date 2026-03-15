import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";

interface InteractionData {
  name: string;
  options?: Array<{ name: string; value: string | number | boolean }>;
}

interface Interaction {
  type: number;
  data?: InteractionData;
  member?: { user: { username: string } };
}

function getOption(
  options: InteractionData["options"],
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
): Promise<unknown> {
  // Type 1 = PING (health check from Discord)
  if (interaction.type === 1) {
    return { type: 1 }; // PONG
  }

  // Type 2 = APPLICATION_COMMAND (slash command)
  if (interaction.type === 2 && interaction.data) {
    await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);
    return handleSlashCommand(ctx, interaction.data, interaction.member);
  }

  // Type 3 = MESSAGE_COMPONENT (button click)
  if (interaction.type === 3 && interaction.data) {
    return handleButtonClick(ctx, interaction.data);
  }

  return respondToInteraction({
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    content: "Unknown interaction type.",
    ephemeral: true,
  });
}

async function handleSlashCommand(
  ctx: PluginContext,
  data: InteractionData,
  member?: { user: { username: string } },
): Promise<unknown> {
  // /clip has subcommands, so the first option is the subcommand
  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/clip status`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name ?? String(subcommand.value);

  switch (subName) {
    case "status":
      return handleStatus(ctx);
    case "approve":
      return handleApprove(
        ctx,
        getOption(subcommand.options, "id"),
        member?.user.username,
      );
    case "budget":
      return handleBudget(ctx, getOption(subcommand.options, "agent"));
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown command: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleStatus(ctx: PluginContext): Promise<unknown> {
  const embeds: DiscordEmbed[] = [
    {
      title: "Paperclip Status",
      description: "Fetching agent and task status...",
      color: COLORS.BLUE,
      footer: { text: "Paperclip" },
    },
  ];

  // TODO: use ctx.entities / ctx.agents to fetch real data
  // For now, return a placeholder that proves the command routing works

  return respondToInteraction({
    type: 4,
    embeds,
    ephemeral: true,
  });
}

async function handleApprove(
  ctx: PluginContext,
  approvalId: string | undefined,
  username?: string,
): Promise<unknown> {
  if (!approvalId) {
    return respondToInteraction({
      type: 4,
      content: "Missing approval ID. Usage: `/clip approve id:<approval-id>`",
      ephemeral: true,
    });
  }

  try {
    // TODO: call ctx to resolve and approve
    ctx.logger.info("Approval via Discord", { approvalId, username });

    return respondToInteraction({
      type: 4,
      content: `Approved: ${approvalId}`,
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
): Promise<unknown> {
  if (!agentQuery) {
    return respondToInteraction({
      type: 4,
      content: "Missing agent name. Usage: `/clip budget agent:<name>`",
      ephemeral: true,
    });
  }

  // TODO: lookup agent budget via ctx.agents

  return respondToInteraction({
    type: 4,
    embeds: [
      {
        title: `Budget: ${agentQuery}`,
        description: "Budget lookup not yet connected to agent API.",
        color: COLORS.PURPLE,
      },
    ],
    ephemeral: true,
  });
}

async function handleButtonClick(
  ctx: PluginContext,
  data: InteractionData,
): Promise<unknown> {
  const customId = data.name;

  if (customId.startsWith("approval_approve_")) {
    const approvalId = customId.replace("approval_approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, action: "approve" });
    // TODO: call approval API
    return respondToInteraction({
      type: 7, // UPDATE_MESSAGE
      content: `Approved by Discord user.`,
    });
  }

  if (customId.startsWith("approval_reject_")) {
    const approvalId = customId.replace("approval_reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, action: "reject" });
    // TODO: call approval API
    return respondToInteraction({
      type: 7,
      content: `Rejected by Discord user.`,
    });
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown button action.",
    ephemeral: true,
  });
}
