import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
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
    expect(msg.embeds?.[0]?.title).toBe("Issue Created");
    expect(msg.embeds?.[0]?.description).toContain("PROJ-42");
    expect(msg.embeds?.[0]?.description).toContain("Fix login bug");
    expect(msg.embeds?.[0]?.color).toBe(COLORS.BLUE);
  });

  it("falls back to entityId when identifier is missing", () => {
    const msg = formatIssueCreated(makeEvent({ entityId: "fallback-id" }));
    expect(msg.embeds?.[0]?.description).toContain("fallback-id");
  });

  it("includes assignee field when present", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { assigneeName: "Agent Smith" } }),
    );
    const fields = msg.embeds?.[0]?.fields ?? [];
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe("Assigned to");
    expect(fields[0]?.value).toBe("Agent Smith");
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
  it("includes interactive approve/reject buttons", () => {
    const msg = formatApprovalCreated(
      makeEvent({
        payload: { type: "strategy", approvalId: "apr-123", issueIds: ["i1"] },
      }),
    );
    expect(msg.embeds?.[0]?.color).toBe(COLORS.YELLOW);
    expect(msg.components).toHaveLength(1);
    const buttons = msg.components?.[0]?.components ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.label).toBe("Approve");
    expect(buttons[0]?.custom_id).toBe("approval_approve_apr-123");
    expect(buttons[1]?.label).toBe("Reject");
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
});
