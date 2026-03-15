import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { DiscordMessage } from "./discord-api.js";
import { COLORS } from "./constants.js";

type Payload = Record<string, unknown>;

export function formatIssueCreated(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const assignee = p.assigneeName ? String(p.assigneeName) : null;

  return {
    embeds: [
      {
        title: "Issue Created",
        description: `**${identifier}** ${title}`,
        color: COLORS.BLUE,
        fields: [
          ...(assignee
            ? [{ name: "Assigned to", value: assignee, inline: true }]
            : []),
        ],
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export function formatIssueDone(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");

  return {
    embeds: [
      {
        title: "Issue Completed",
        description: `**${identifier}** ${title} is now done.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export function formatApprovalCreated(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds : [];

  return {
    embeds: [
      {
        title: "Approval Requested",
        description: `Type: **${approvalType}**\nIssues: ${issueIds.length}`,
        color: COLORS.YELLOW,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
    components: [
      {
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 3, // Success (green)
            label: "Approve",
            custom_id: `approval_approve_${approvalId}`,
          },
          {
            type: 2, // Button
            style: 4, // Danger (red)
            label: "Reject",
            custom_id: `approval_reject_${approvalId}`,
          },
        ],
      },
    ],
  };
}

export function formatAgentError(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");

  return {
    embeds: [
      {
        title: "Agent Error",
        description: `**${agentName}** encountered an error`,
        color: COLORS.RED,
        fields: [
          { name: "Error", value: errorMessage.slice(0, 1024) },
        ],
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export function formatAgentRunStarted(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? event.entityId);

  return {
    embeds: [
      {
        title: "Agent Run Started",
        description: `**${agentName}** has started a new run.`,
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export function formatAgentRunFinished(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? event.entityId);

  return {
    embeds: [
      {
        title: "Agent Run Finished",
        description: `**${agentName}** completed successfully.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}
