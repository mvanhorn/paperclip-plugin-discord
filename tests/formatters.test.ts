import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
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
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe("Assignee");
    expect(fields[0]?.value).toBe("Agent Smith");
  });

  it("uses configurable base URL for dashboard link", () => {
    const msg = formatIssueCreated(
      makeEvent({ entityId: "iss-1" }),
      "https://app.paperclip.dev",
    );
    const link = msg.components?.[0]?.components?.[0];
    expect(link?.url).toBe("https://app.paperclip.dev/issues/iss-1");
  });

  it("uses default base URL when none provided", () => {
    const msg = formatIssueCreated(makeEvent({ entityId: "iss-1" }));
    const link = msg.components?.[0]?.components?.[0];
    expect(link?.url).toBe("http://localhost:3100/issues/iss-1");
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
    const viewBtn = msg.components?.[0]?.components?.[0];
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
