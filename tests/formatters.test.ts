import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatSessionFailure,
  formatBudgetWarning,
  type BudgetWarningData,
  formatAgentRunStarted,
  formatAgentRunFinished,
  humanizeStatus,
  humanizePriority,
} from "../src/formatters.js";
import { COLORS } from "../src/constants.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    companyId: "company-1",
    entityId: "entity-1",
    occurredAt: "2026-03-15T12:00:00Z",
    payload: {},
    ...overrides,
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("formats with identifier and title from payload", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { identifier: "PROJ-42", title: "Fix login bug" } }),
    );
    expect(msg.embeds?.[0]?.title).toBe("Issue Created: PROJ-42");
    expect(msg.embeds?.[0]?.description).toContain("Fix login bug");
    expect(msg.embeds?.[0]?.color).toBe(COLORS.BLUE);
  });

  it("falls back to entityId when identifier is missing", () => {
    const msg = formatIssueCreated(makeEvent({ entityId: "fallback-id" }));
    expect(msg.embeds?.[0]?.title).toContain("fallback-id");
  });

  it("includes assignee field when present", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { assigneeName: "Agent Smith" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const assigneeField = fields.find((f) => f.name === "Assignee");
    expect(assigneeField?.value).toBe("Agent Smith");
  });

  it("uses configurable base URL for dashboard link", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "iss-1" }),
      "https://app.paperclip.dev",
    );
    const viewBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Issue");
    expect(viewBtn?.url).toBe("https://app.paperclip.dev/issues/iss-1");
  });

  it("uses default base URL when none provided", () => {
    const msg = formatIssueCreated(makeEvent({ entityId: "iss-1" }));
    const viewBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Issue");
    expect(viewBtn?.url).toBe("http://localhost:3100/issues/iss-1");
  });
});

describe("formatIssueDone", () => {
  it("uses green color for completed issues", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-42" } }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.GREEN);
    expect(msg.embeds?.[0]?.description).toContain("done");
  });

  it("shows issue title in completion description", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-42", title: "Fix login bug" } }),
    );
    expect(msg.embeds?.[0]?.description).toBe("**Fix login bug** is now done.");
  });

  it("falls back to identifier when title is missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-42" } }),
    );
    expect(msg.embeds?.[0]?.description).toBe("**PROJ-42** is now done.");
  });

  it("falls back to identifier when title is empty string", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-42", title: "" } }),
    );
    expect(msg.embeds?.[0]?.description).toBe("**PROJ-42** is now done.");
  });

  it("falls back to identifier when title is null", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-42", title: null } }),
    );
    expect(msg.embeds?.[0]?.description).toBe("**PROJ-42** is now done.");
  });

  it("falls back to entityId when both title and identifier are missing", () => {
    const msg = formatIssueDone(
      makeEvent({ entityId: "entity-abc" }),
    );
    expect(msg.embeds?.[0]?.description).toBe("**entity-abc** is now done.");
  });
});

describe("formatApprovalCreated", () => {
  it("includes interactive approve/reject/view buttons", () => {
    const msg = formatApprovalCreated(
      makeEvent({
        payload: { type: "strategy", approvalId: "apr-123", issueIds: ["i1"] },
      }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.YELLOW);
    expect(msg.components).toHaveLength(1);
    const buttons = msg.components?.[0]?.components ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.label).toBe("Approve");
    expect(buttons[0]?.custom_id).toBe("approval_approve_apr-123");
    expect(buttons[1]?.label).toBe("Reject");
    expect(buttons[2]?.label).toBe("View");
  });

  it("uses configurable base URL for view button", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
      "https://app.example.com",
    );
    const viewButton = msg.components?.[0]?.components?.[2];
    expect(viewButton?.url).toBe("https://app.example.com/approvals/apr-1");
  });
});

describe("formatAgentError", () => {
  it("formats error with red color", () => {
    const msg = formatAgentError(
      makeEvent({
        payload: { agentName: "CTO Bot", error: "Budget exceeded" },
      }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.RED);
    expect(msg.embeds?.[0]?.description).toContain("CTO Bot");
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields[0]?.value).toContain("Budget exceeded");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(2000);
    const msg = formatAgentError(
      makeEvent({ payload: { error: longError } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields[0]?.value.length).toBeLessThanOrEqual(1024);
  });

  it("falls back to 'message' field when 'error' is missing", () => {
    const msg = formatAgentError(
      makeEvent({ payload: { agentName: "Bot", message: "OOM killed" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields[0]?.value).toContain("OOM killed");
  });

  it("falls back to entityId for agent name when payload is empty", () => {
    const msg = formatAgentError(makeEvent({ entityId: "agent-x" }));
    expect(msg.embeds?.[0]?.description).toContain("agent-x");
  });
});

describe("formatAgentRunStarted", () => {
  it("formats run started with blue color and agent name in title", () => {
    const msg = formatAgentRunStarted(
      makeEvent({ payload: { agentName: "BD Agent" } }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.BLUE);
    expect(msg.embeds?.[0]?.title).toBe("Run Started: BD Agent");
    expect(msg.embeds?.[0]?.description).toContain("BD Agent");
  });

  it("falls back to entityId when agentName missing", () => {
    const msg = formatAgentRunStarted(makeEvent({ entityId: "fallback-agent" }));
    expect(msg.embeds?.[0]?.description).toContain("fallback-agent");
  });

  it("includes task context when issueIdentifier is provided", () => {
    const msg = formatAgentRunStarted(
      makeEvent({ payload: { agentName: "Engineer", issueIdentifier: "TUM-54", issueTitle: "Humanize output" } }),
    );
    expect(msg.embeds?.[0]?.description).toContain("TUM-54");
    expect(msg.embeds?.[0]?.description).toContain("Humanize output");
  });

  it("shows issueIdentifier without title when title is absent", () => {
    const msg = formatAgentRunStarted(
      makeEvent({ payload: { agentName: "Engineer", issueIdentifier: "TUM-54" } }),
    );
    expect(msg.embeds?.[0]?.description).toContain("TUM-54");
    expect(msg.embeds?.[0]?.description).not.toContain("—");
  });

  it("omits task line when no issue context", () => {
    const msg = formatAgentRunStarted(
      makeEvent({ payload: { agentName: "Engineer" } }),
    );
    expect(msg.embeds?.[0]?.description).not.toContain("Task:");
  });
});

describe("formatAgentRunFinished", () => {
  it("formats run finished with green color and agent name in title", () => {
    const msg = formatAgentRunFinished(
      makeEvent({ payload: { agentName: "BD Agent" } }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.GREEN);
    expect(msg.embeds?.[0]?.title).toBe("Run Finished: BD Agent");
    expect(msg.embeds?.[0]?.description).toContain("completed successfully");
  });

  it("includes task context when issueIdentifier is provided", () => {
    const msg = formatAgentRunFinished(
      makeEvent({ payload: { agentName: "Engineer", issueIdentifier: "TUM-54", issueTitle: "Fix bug" } }),
    );
    expect(msg.embeds?.[0]?.description).toContain("TUM-54");
    expect(msg.embeds?.[0]?.description).toContain("Fix bug");
  });
});

describe("embed color selection", () => {
  it("BLUE for issue created", () => {
    const msg = formatIssueCreated(makeEvent());
    expect(msg.embeds?.[0]?.color).toBe(COLORS.BLUE);
  });

  it("GREEN for issue done", () => {
    const msg = formatIssueDone(makeEvent());
    expect(msg.embeds?.[0]?.color).toBe(COLORS.GREEN);
  });

  it("YELLOW for approval created", () => {
    const msg = formatApprovalCreated(makeEvent());
    expect(msg.embeds?.[0]?.color).toBe(COLORS.YELLOW);
  });

  it("RED for agent error", () => {
    const msg = formatAgentError(makeEvent({ payload: { error: "e" } }));
    expect(msg.embeds?.[0]?.color).toBe(COLORS.RED);
  });
});

describe("agent label formatting", () => {
  it("includes agent name in approval embed fields", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { agentName: "DeployBot", type: "deploy" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const agentField = fields.find((f) => f.name === "Agent");
    expect(agentField?.value).toBe("DeployBot");
  });
});

describe("escalation embed structure", () => {
  it("approval created embed has action row with 3 buttons", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
    );
    expect(msg.components).toHaveLength(1);
    expect(msg.components?.[0]?.type).toBe(1); // action row
    expect(msg.components?.[0]?.components).toHaveLength(3);
  });

  it("approve button uses style 3 (success/green)", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
    );
    const approveBtn = msg.components?.[0]?.components?.[0];
    expect(approveBtn?.style).toBe(3);
    expect(approveBtn?.label).toBe("Approve");
  });

  it("reject button uses style 4 (danger/red)", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
    );
    const rejectBtn = msg.components?.[0]?.components?.[1];
    expect(rejectBtn?.style).toBe(4);
    expect(rejectBtn?.label).toBe("Reject");
  });

  it("view button uses style 5 (link)", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    expect(viewBtn?.style).toBe(5);
    expect(viewBtn?.url).toBeDefined();
  });
});

describe("approval View button URL uses configured base URL", () => {
  it("uses provided baseUrl in the View button URL", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-99" } }),
      "https://app.paperclip.ing",
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    expect(viewBtn?.url).toBe("https://app.paperclip.ing/approvals/apr-99");
  });

  it("falls back to DEFAULT_BASE_URL when baseUrl is undefined", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-99" } }),
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    expect(viewBtn?.url).toBe("http://localhost:3100/approvals/apr-99");
  });

  it("falls back to DEFAULT_BASE_URL when baseUrl is empty string", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-99" } }),
      "",
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    // Empty string is falsy but not nullish — should still fall back
    expect(viewBtn?.url).toBe("http://localhost:3100/approvals/apr-99");
  });

  it("strips trailing slash from baseUrl to avoid double-slash", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-99" } }),
      "https://app.paperclip.ing/",
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    expect(viewBtn?.url).toBe("https://app.paperclip.ing/approvals/apr-99");
  });

  it("uses entityId when approvalId not in payload", () => {
    const msg = formatApprovalCreated(
      makeEvent({ entityId: "entity-abc" }),
      "https://app.paperclip.ing",
    );
    const viewBtn = msg.components?.[0]?.components?.[2];
    expect(viewBtn?.url).toBe("https://app.paperclip.ing/approvals/entity-abc");
  });

  it("View button URL for issue.created also uses configured baseUrl", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "issue-42" }),
      "https://app.paperclip.ing",
    );
    const viewBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Issue");
    expect(viewBtn?.url).toBe("https://app.paperclip.ing/issues/issue-42");
  });
});

describe("humanizeStatus", () => {
  it("converts known statuses to readable labels", () => {
    expect(humanizeStatus("todo")).toBe("To Do");
    expect(humanizeStatus("in_progress")).toBe("In Progress");
    expect(humanizeStatus("in_review")).toBe("In Review");
    expect(humanizeStatus("done")).toBe("Done");
    expect(humanizeStatus("blocked")).toBe("Blocked");
    expect(humanizeStatus("backlog")).toBe("Backlog");
    expect(humanizeStatus("cancelled")).toBe("Cancelled");
  });

  it("returns raw value for unknown statuses", () => {
    expect(humanizeStatus("custom_status")).toBe("custom_status");
  });
});

describe("humanizePriority", () => {
  it("converts known priorities to readable labels", () => {
    expect(humanizePriority("critical")).toBe("Critical");
    expect(humanizePriority("high")).toBe("High");
    expect(humanizePriority("medium")).toBe("Medium");
    expect(humanizePriority("low")).toBe("Low");
  });

  it("returns raw value for unknown priorities", () => {
    expect(humanizePriority("urgent")).toBe("urgent");
  });
});

describe("humanized status and priority in issue embeds", () => {
  it("issue created embed shows humanized status", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { identifier: "X-1", title: "Test", status: "in_progress", priority: "high" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const statusField = fields.find((f) => f.name === "Status");
    const priorityField = fields.find((f) => f.name === "Priority");
    expect(statusField?.value).toBe("`In Progress`");
    expect(priorityField?.value).toBe("`High`");
  });

  it("issue done embed shows humanized status", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-1", status: "done", priority: "low" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const statusField = fields.find((f) => f.name === "Status");
    const priorityField = fields.find((f) => f.name === "Priority");
    expect(statusField?.value).toBe("`Done`");
    expect(priorityField?.value).toBe("`Low`");
  });
});

describe("formatIssueCreated — actionability improvements", () => {
  it("includes Assign to Me button with correct custom_id", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "iss-99", payload: { identifier: "X-1", title: "Task" } }),
    );
    const assignBtn = msg.components?.[0]?.components?.find((c) => c.label === "Assign to Me");
    expect(assignBtn).toBeDefined();
    expect(assignBtn?.style).toBe(1); // blurple/primary
    expect(assignBtn?.custom_id).toBe("issue_assign_iss-99");
  });

  it("shows parent context field when parentIdentifier is provided", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { identifier: "X-2", title: "Sub", parentIdentifier: "X-1", parentTitle: "Parent Task" } }),
    );
    const parentField = msg.embeds?.[0]?.fields?.find((f) => f.name === "Parent");
    expect(parentField).toBeDefined();
    expect(parentField?.value).toContain("X-1");
    expect(parentField?.value).toContain("Parent Task");
  });

  it("shows View Parent button when parentId is provided", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "iss-2", payload: { identifier: "X-2", title: "Sub", parentId: "parent-id-1", parentIdentifier: "X-1" } }),
      "https://app.test.com",
    );
    const parentBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Parent");
    expect(parentBtn).toBeDefined();
    expect(parentBtn?.url).toBe("https://app.test.com/issues/parent-id-1");
  });

  it("does not show View Parent button when no parentId", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "iss-3", payload: { identifier: "X-3", title: "No parent" } }),
    );
    const parentBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Parent");
    expect(parentBtn).toBeUndefined();
  });

  it("shows enhanced footer with creator and project", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { identifier: "X-4", title: "T", creatorName: "CEO", projectName: "Alpha" } }),
    );
    expect(msg.embeds?.[0]?.footer?.text).toBe("Created by CEO • Alpha");
  });

  it("uses description blockquote with 500 char limit", () => {
    const longDesc = "a".repeat(600);
    const msg = formatIssueCreated(
      makeEvent({ payload: { identifier: "X-5", title: "T", description: longDesc } }),
    );
    const desc = msg.embeds?.[0]?.description ?? "";
    // The blockquoted description should be truncated to 500 chars
    expect(desc).toContain("> ");
    expect(desc.length).toBeLessThan(510 + "**T**\n> ".length);
  });

  it("does not include parentIdentifier/parentTitle/parentId/creatorName as dynamic fields", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: {
        identifier: "X-6", title: "T",
        parentIdentifier: "X-5", parentTitle: "P", parentId: "pid", creatorName: "Bob",
      } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const dynamicNames = fields.map((f) => f.name);
    expect(dynamicNames).not.toContain("parentIdentifier");
    expect(dynamicNames).not.toContain("parentTitle");
    expect(dynamicNames).not.toContain("parentId");
    expect(dynamicNames).not.toContain("creatorName");
  });
});

describe("formatIssueDone — actionability improvements", () => {
  it("shows checkmark emoji in title", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "PROJ-10", title: "Done task" } }),
    );
    expect(msg.embeds?.[0]?.title).toContain("✅");
    expect(msg.embeds?.[0]?.title).toContain("PROJ-10");
  });

  it("includes Completed by field when assigneeName is provided", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-1", title: "T", assigneeName: "Engineer" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field).toBeDefined();
    expect(field?.value).toBe("Engineer");
  });

  it("includes Summary field from lastComment, truncated to 200 chars", () => {
    const longComment = "x".repeat(300);
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-2", title: "T", lastComment: longComment } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Summary");
    expect(field).toBeDefined();
    expect(field!.value.length).toBeLessThanOrEqual(200);
  });

  it("includes Parent field when parentIdentifier is provided", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-3", title: "T", parentIdentifier: "X-1", parentTitle: "Parent" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Parent");
    expect(field).toBeDefined();
    expect(field?.value).toContain("X-1");
  });

  it("includes Reopen button with correct custom_id and danger style", () => {
    const msg = formatIssueDone(
      makeEvent({ entityId: "iss-done", payload: { identifier: "X-4", title: "T" } }),
    );
    const reopenBtn = msg.components?.[0]?.components?.find((c) => c.label === "Reopen");
    expect(reopenBtn).toBeDefined();
    expect(reopenBtn?.style).toBe(4); // danger/red
    expect(reopenBtn?.custom_id).toBe("issue_reopen_iss-done");
  });

  it("includes View Diff button when prUrl is provided", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-5", title: "T", prUrl: "https://github.com/org/repo/pull/1" } }),
    );
    const diffBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Diff");
    expect(diffBtn).toBeDefined();
    expect(diffBtn?.url).toBe("https://github.com/org/repo/pull/1");
    expect(diffBtn?.style).toBe(5); // link
  });

  it("does not include View Diff button when no prUrl", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-6", title: "T" } }),
    );
    const diffBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Diff");
    expect(diffBtn).toBeUndefined();
  });

  it("always includes View Issue button", () => {
    const msg = formatIssueDone(
      makeEvent({ entityId: "iss-7", payload: { identifier: "X-7", title: "T" } }),
    );
    const viewBtn = msg.components?.[0]?.components?.find((c) => c.label === "View Issue");
    expect(viewBtn).toBeDefined();
    expect(viewBtn?.url).toBe("http://localhost:3100/issues/iss-7");
  });

  it("falls back to executorName when assigneeName is missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-8", title: "T", executorName: "QA Bot" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("QA Bot");
  });

  it("falls back to agentName when assigneeName and executorName are missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-9", title: "T", agentName: "Deploy Agent" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("Deploy Agent");
  });

  it("falls back to assigneeAgentId when all name fields are missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-10", title: "T", assigneeAgentId: "agent-uuid-123" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("agent-uuid-123");
  });

  it("shows 'Unknown' when no completing agent info is available", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-11", title: "T" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field).toBeDefined();
    expect(field?.value).toBe("Unknown");
  });

  it("always includes Summary field even when lastComment is missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-12", title: "T" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Summary");
    expect(field).toBeDefined();
    expect(field?.value).toBe("No summary available");
  });

  it("prefers assigneeName over executorName", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-13", title: "T", assigneeName: "Engineer", executorName: "Other" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("Engineer");
  });

  it("uses explicit completedBy when provided", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-14", title: "T", completedBy: "discord:alice" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("alice");
  });

  it("falls back to assigneeUserId when assigneeName is missing", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { identifier: "X-15", title: "T", assigneeUserId: "discord:bob" } }),
    );
    const field = msg.embeds?.[0]?.fields?.find((f) => f.name === "Completed by");
    expect(field?.value).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// formatSessionFailure
// ---------------------------------------------------------------------------

describe("formatSessionFailure", () => {
  it("produces a red embed with agent name in title", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Engineer", error: "Something broke" } }),
    );
    expect(msg.embeds?.[0]?.title).toBe("Session Failed: Engineer");
    expect(msg.embeds?.[0]?.color).toBe(COLORS.RED);
  });

  it("classifies token limit errors", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "context length exceeded" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Session / Token Limit");
  });

  it("classifies max_tokens errors", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "max_tokens reached" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Session / Token Limit");
  });

  it("classifies budget exhausted errors", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "budget exhausted for agent" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Budget Exhausted");
  });

  it("classifies timeout errors", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "session timed out" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Timeout");
  });

  it("classifies deadline exceeded as timeout", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "deadline exceeded" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Timeout");
  });

  it("falls back to Unknown Error for unrecognized errors", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "segfault at 0x0000" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorType = fields.find((f) => f.name === "Error Type");
    expect(errorType?.value).toContain("Unknown Error");
  });

  it("includes task identifier and title when present", () => {
    const msg = formatSessionFailure(
      makeEvent({
        payload: {
          agentName: "Bot",
          error: "token limit",
          issueIdentifier: "TUM-42",
          issueTitle: "Fix the widget",
        },
      }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const task = fields.find((f) => f.name === "Task");
    expect(task?.value).toContain("TUM-42");
    expect(task?.value).toContain("Fix the widget");
  });

  it("includes last active timestamp as Discord relative time", () => {
    const msg = formatSessionFailure(
      makeEvent({
        payload: {
          agentName: "Bot",
          error: "timeout",
          lastActiveAt: "2026-04-04T11:55:00Z",
        },
      }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const lastActive = fields.find((f) => f.name === "Last Active");
    expect(lastActive?.value).toMatch(/<t:\d+:R>/);
  });

  it("includes Next Steps field with actionable text", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "deadline exceeded" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const nextSteps = fields.find((f) => f.name === "Next Steps");
    expect(nextSteps).toBeDefined();
    expect(nextSteps!.value).toContain("/clip");
  });

  it("falls back to entityId when agentName is missing", () => {
    const msg = formatSessionFailure(makeEvent({ entityId: "agent-xyz", payload: { error: "err" } }));
    expect(msg.embeds?.[0]?.title).toBe("Session Failed: agent-xyz");
  });

  it("truncates long error messages to 1024 chars", () => {
    const longError = "x".repeat(2000);
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: longError } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    const errorField = fields.find((f) => f.name === "Error");
    expect(errorField!.value.length).toBeLessThanOrEqual(1024);
  });

  it("omits Task field when no issue context", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "err" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Task")).toBeUndefined();
  });

  it("omits Last Active field when not provided", () => {
    const msg = formatSessionFailure(
      makeEvent({ payload: { agentName: "Bot", error: "err" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Last Active")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatBudgetWarning
// ---------------------------------------------------------------------------

describe("formatBudgetWarning", () => {
  const baseData: BudgetWarningData = {
    agentName: "Engineer",
    agentId: "agent-1",
    spent: 8.5,
    limit: 10,
    remaining: 1.5,
    pct: 85,
  };

  it("produces a yellow embed with agent name in title", () => {
    const msg = formatBudgetWarning(baseData);
    expect(msg.embeds?.[0]?.title).toBe("Budget Warning: Engineer");
    expect(msg.embeds?.[0]?.color).toBe(COLORS.YELLOW);
  });

  it("includes spent, limit, and remaining fields with dollar formatting", () => {
    const msg = formatBudgetWarning(baseData);
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Spent")?.value).toBe("$8.50");
    expect(fields.find((f) => f.name === "Limit")?.value).toBe("$10.00");
    expect(fields.find((f) => f.name === "Remaining")?.value).toBe("$1.50");
  });

  it("marks spent/limit/remaining fields as inline", () => {
    const msg = formatBudgetWarning(baseData);
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Spent")?.inline).toBe(true);
    expect(fields.find((f) => f.name === "Limit")?.inline).toBe(true);
    expect(fields.find((f) => f.name === "Remaining")?.inline).toBe(true);
  });

  it("includes next steps referencing /clip budget <agentName>", () => {
    const msg = formatBudgetWarning(baseData);
    const fields = msg.embeds?.[0]?.fields ?? [];
    const nextSteps = fields.find((f) => f.name === "Next Steps");
    expect(nextSteps?.value).toContain("/clip budget Engineer");
  });

  it("shows percentage in description", () => {
    const msg = formatBudgetWarning(baseData);
    expect(msg.embeds?.[0]?.description).toContain("85%");
  });

  it("handles 100% budget usage", () => {
    const data: BudgetWarningData = {
      agentName: "OverBudget",
      agentId: "agent-2",
      spent: 10,
      limit: 10,
      remaining: 0,
      pct: 100,
    };
    const msg = formatBudgetWarning(data);
    expect(msg.embeds?.[0]?.description).toContain("100%");
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Remaining")?.value).toBe("$0.00");
  });
});
