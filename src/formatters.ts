import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { DiscordMessage, DiscordComponent } from "./discord-api.js";
import { COLORS } from "./constants.js";

type Payload = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://localhost:3100";

const STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  backlog: "Backlog",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function humanizeStatus(raw: string): string {
  return STATUS_LABELS[raw] ?? raw;
}

export function humanizePriority(raw: string): string {
  return PRIORITY_LABELS[raw] ?? raw;
}

function resolveBaseUrl(baseUrl?: string): string | null {
  const url = (baseUrl || DEFAULT_BASE_URL).trim();
  const normalized = url.endsWith("/") ? url.slice(0, -1) : url;

  try {
    const parsed = new URL(normalized);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function formatIssueCreated(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const description = p.description ? String(p.description) : null;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;
  const creatorName = p.creatorName ? String(p.creatorName) : null;
  const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
  const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
  const parentId = p.parentId ? String(p.parentId) : null;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (parentIdentifier) {
    const parentLine = parentTitle
      ? `**${parentIdentifier}** — ${parentTitle}`
      : `**${parentIdentifier}**`;
    fields.push({ name: "Parent", value: parentLine, inline: true });
  }
  if (status) fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
  if (priority) fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
  if (assigneeName) fields.push({ name: "Assignee", value: assigneeName, inline: true });
  if (projectName) fields.push({ name: "Project", value: projectName, inline: true });

  const knownKeys = new Set([
    "identifier", "title", "description", "status", "priority",
    "assigneeName", "projectName", "assigneeAgentId", "projectId",
    "creatorName", "parentIdentifier", "parentTitle", "parentId",
  ]);
  for (const [key, value] of Object.entries(p)) {
    if (knownKeys.has(key) || value == null || value === "") continue;
    const display = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (display.length > 0 && display.length <= 1024) {
      fields.push({ name: key, value: display, inline: display.length < 40 });
    }
  }

  const base = resolveBaseUrl(baseUrl);

  const footerParts: string[] = [];
  if (creatorName) footerParts.push(`Created by ${creatorName}`);
  if (projectName) footerParts.push(projectName);
  const footerText = footerParts.length > 0 ? footerParts.join(" • ") : "Paperclip";

  const buttons: DiscordComponent[] = [];
  if (base) {
    buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
  }
  if (base && parentId) {
    buttons.push({
      type: 2,
      style: 5,
      label: "View Parent",
      url: `${base}/issues/${parentId}`,
    });
  }

  return {
    embeds: [
      {
        title: `Issue Created: ${identifier}`,
        description: description
          ? `**${title}**\n> ${description.slice(0, 500)}`
          : `**${title}**`,
        color: COLORS.BLUE,
        fields,
        footer: { text: footerText },
        timestamp: event.occurredAt,
      },
    ],
    components: buttons.length > 0 ? [{ type: 1, components: buttons }] : [],
  };
}

export function formatIssueDone(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "") || identifier;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const executorName = p.executorName ? String(p.executorName) : null;
  const agentName = p.agentName ? String(p.agentName) : null;
  const assigneeAgentId = p.assigneeAgentId ? String(p.assigneeAgentId) : null;
  const completedBy = assigneeName || executorName || agentName || assigneeAgentId || "Unknown";
  const lastComment = p.lastComment ? String(p.lastComment) : null;
  const summary = lastComment ? lastComment.slice(0, 200) : "No summary available";
  const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
  const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
  const parentId = p.parentId ? String(p.parentId) : null;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  fields.push({ name: "Completed by", value: completedBy, inline: true });
  if (status) fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
  if (priority) fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
  fields.push({ name: "Summary", value: summary });
  if (parentIdentifier) {
    const parentLine = parentTitle
      ? `**${parentIdentifier}** — ${parentTitle}`
      : `**${parentIdentifier}**`;
    fields.push({ name: "Parent", value: parentLine, inline: true });
  }

  const base = resolveBaseUrl(baseUrl);

  const buttons: DiscordComponent[] = [];
  if (base) {
    buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
  }
  if (p.prUrl) {
    buttons.push({ type: 2, style: 5, label: "View Diff", url: String(p.prUrl) });
  }
  buttons.push({
    type: 2,
    style: 4,
    label: "Reopen",
    custom_id: `issue_reopen_${event.entityId}`,
  });

  return {
    embeds: [
      {
        title: `✅ Issue Completed: ${identifier}`,
        description: `**${title}** is now done.`,
        color: COLORS.GREEN,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
    components: [{ type: 1, components: buttons }],
  };
}

export function formatApprovalCreated(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "");
  const description = String(p.description ?? "");
  const agentName = String(p.agentName ?? "");
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds as string[] : [];
  const dashboardBase = resolveBaseUrl(baseUrl);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (agentName) fields.push({ name: "Agent", value: agentName, inline: true });
  fields.push({ name: "Type", value: `\`${approvalType}\``, inline: true });
  if (issueIds.length > 0) {
    fields.push({ name: "Linked Issues", value: issueIds.join(", ") });
  }

  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Record<string, unknown>> : [];
  if (linkedIssues.length > 0) {
    const issueLines = linkedIssues.map((issue) => {
      const parts = [`**${issue.identifier ?? "?"}** ${issue.title ?? ""}`];
      const meta: string[] = [];
      if (issue.status) meta.push(String(issue.status));
      if (issue.priority) meta.push(String(issue.priority));
      if (issue.assignee) meta.push(`→ ${issue.assignee}`);
      if (meta.length > 0) parts.push(`(${meta.join(" | ")})`);
      if (issue.description) parts.push(`\n> ${String(issue.description).slice(0, 100)}`);
      return parts.join(" ");
    });
    fields.push({ name: `Linked Issues (${linkedIssues.length})`, value: issueLines.join("\n\n").slice(0, 1024) });
  }

  const knownKeys = new Set(["type", "approvalId", "title", "description", "agentName", "issueIds", "agentId", "runId", "linkedIssues"]);
  for (const [key, value] of Object.entries(p)) {
    if (knownKeys.has(key) || value == null || value === "") continue;
    const display = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (display.length > 0 && display.length <= 1024) {
      fields.push({ name: key, value: display, inline: display.length < 40 });
    }
  }

  return {
    embeds: [
      {
        title: title ? `Approval: ${title}` : "Approval Requested",
        description: description || undefined,
        color: COLORS.YELLOW,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Approve",
            custom_id: `approval_approve_${approvalId}`,
          },
          {
            type: 2,
            style: 4,
            label: "Reject",
            custom_id: `approval_reject_${approvalId}`,
          },
          ...(dashboardBase
            ? [{
                type: 2,
                style: 5,
                label: "View",
                url: `${dashboardBase}/approvals/${approvalId}`,
              } satisfies DiscordComponent]
            : []),
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

// ---------------------------------------------------------------------------
// Session failure classification
// ---------------------------------------------------------------------------

const ERROR_CLASSIFICATIONS: Array<{
  pattern: RegExp;
  label: string;
  nextSteps: string;
}> = [
  {
    pattern: /token.?limit|context.?length|max.?tokens|context.?window/i,
    label: "Session / Token Limit",
    nextSteps: "The session hit its token limit. Use `/clip retry <task>` to restart with a fresh context, or break the task into smaller subtasks.",
  },
  {
    pattern: /budget.?exhaust|budget.?exceed|insufficient.?budget|over.?budget/i,
    label: "Budget Exhausted",
    nextSteps: "The agent's budget has been fully consumed. Use `/clip budget <agent>` to check the current state and top up if needed.",
  },
  {
    pattern: /timeout|timed?.?out|deadline.?exceed/i,
    label: "Timeout",
    nextSteps: "The session timed out before completing. Use `/clip retry <task>` to restart, or increase the timeout if applicable.",
  },
];

function classifyError(errorMessage: string): { label: string; nextSteps: string } {
  for (const cls of ERROR_CLASSIFICATIONS) {
    if (cls.pattern.test(errorMessage)) {
      return { label: cls.label, nextSteps: cls.nextSteps };
    }
  }
  return {
    label: "Unknown Error",
    nextSteps: "Check the agent logs for details. Use `/clip status <agent>` to see the current agent state.",
  };
}

export function formatSessionFailure(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");
  const taskIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const taskTitle = p.issueTitle ? String(p.issueTitle) : null;
  const lastActiveAt = p.lastActiveAt ? String(p.lastActiveAt) : null;

  const classification = classifyError(errorMessage);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (taskIdentifier) {
    const taskLine = taskTitle
      ? `**${taskIdentifier}** — ${taskTitle}`
      : `**${taskIdentifier}**`;
    fields.push({ name: "Task", value: taskLine, inline: true });
  }

  fields.push({ name: "Error Type", value: `\`${classification.label}\``, inline: true });

  if (lastActiveAt) {
    const ts = Math.floor(new Date(lastActiveAt).getTime() / 1000);
    fields.push({ name: "Last Active", value: `<t:${ts}:R>`, inline: true });
  }

  fields.push({ name: "Error", value: errorMessage.slice(0, 1024) });
  fields.push({ name: "Next Steps", value: classification.nextSteps });

  return {
    embeds: [
      {
        title: `Session Failed: ${agentName}`,
        description: `**${agentName}** session ended with an error`,
        color: COLORS.RED,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export interface BudgetWarningData {
  agentName: string;
  agentId: string;
  spent: number;
  limit: number;
  remaining: number;
  pct: number;
}

export function formatBudgetWarning(data: BudgetWarningData): DiscordMessage {
  return {
    embeds: [
      {
        title: `Budget Warning: ${data.agentName}`,
        description: `**${data.agentName}** has used **${data.pct}%** of its budget`,
        color: COLORS.YELLOW,
        fields: [
          { name: "Spent", value: `$${data.spent.toFixed(2)}`, inline: true },
          { name: "Limit", value: `$${data.limit.toFixed(2)}`, inline: true },
          { name: "Remaining", value: `$${data.remaining.toFixed(2)}`, inline: true },
          {
            name: "Next Steps",
            value: `Use \`/clip budget ${data.agentName}\` to check live budget status.`,
          },
        ],
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function formatAgentRunStarted(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? event.entityId);
  const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? String(p.issueTitle) : null;

  const taskLine = issueIdentifier
    ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
    : "";

  return {
    embeds: [
      {
        title: `Run Started: ${agentName}`,
        description: `**${agentName}** has started a new run.${taskLine}`,
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
  const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? String(p.issueTitle) : null;

  const taskLine = issueIdentifier
    ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
    : "";

  return {
    embeds: [
      {
        title: `Run Finished: ${agentName}`,
        description: `**${agentName}** completed successfully.${taskLine}`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}
