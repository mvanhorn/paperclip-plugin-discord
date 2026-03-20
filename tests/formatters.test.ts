import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
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
  it("formats run started with blue color", () => {
    const msg = formatAgentRunStarted(
      makeEvent({ payload: { agentName: "BD Agent" } }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.BLUE);
    expect(msg.embeds?.[0]?.title).toBe("Agent Run Started");
    expect(msg.embeds?.[0]?.description).toContain("BD Agent");
  });

  it("falls back to entityId when agentName missing", () => {
    const msg = formatAgentRunStarted(makeEvent({ entityId: "fallback-agent" }));
    expect(msg.embeds?.[0]?.description).toContain("fallback-agent");
  });
});

describe("formatAgentRunFinished", () => {
  it("formats run finished with green color", () => {
    const msg = formatAgentRunFinished(
      makeEvent({ payload: { agentName: "BD Agent" } }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.GREEN);
    expect(msg.embeds?.[0]?.title).toBe("Agent Run Finished");
    expect(msg.embeds?.[0]?.description).toContain("completed successfully");
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
