import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const mocks = vi.hoisted(() => ({ fetchApprovalRecord: vi.fn() }));
vi.mock("../src/approval-details.js", () => ({
  fetchApprovalRecord: mocks.fetchApprovalRecord,
}));

import { enrichApprovalPayload } from "../src/worker.js";
import { formatApprovalCreated } from "../src/formatters.js";
import {
  setPluginErrorSink,
  resetPluginErrorReports,
  type PluginErrorReport,
} from "../src/error-reporting.js";

const BASE_URL = "https://app.example.com";
const OPTS = { companyId: "co-1", baseUrl: BASE_URL, apiKey: "board-key" };

const ISSUE_IDS = [
  "1111aaaa-0000-4000-8000-000000000001",
  "2222bbbb-0000-4000-8000-000000000002",
  "3333cccc-0000-4000-8000-000000000003",
];

function issueRow(id: string, n: number) {
  return { id, identifier: `SOO-${n}`, title: `Issue ${n}`, status: "todo", priority: "high" };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { get: vi.fn().mockResolvedValue(null) },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeApprovalEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventType: "approval.created",
    eventId: "evt-1",
    companyId: "co-1",
    entityId: "apr-1",
    entityType: "approval",
    actorId: "agent-uuid",
    occurredAt: "2026-10-21T09:00:00Z",
    payload: { type: "strategy", title: "Ship it", issueIds: [...ISSUE_IDS] },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** issues.get that resolves every id except the ones listed as failing. */
function issuesGet(failing: string[]) {
  return vi.fn().mockImplementation((id: string) => {
    if (failing.includes(id)) return Promise.reject(new Error(`issues.get refused ${id}`));
    return Promise.resolve(issueRow(id, ISSUE_IDS.indexOf(id) + 1));
  });
}

function renderCard(payload: Record<string, unknown>) {
  return formatApprovalCreated({ ...makeApprovalEvent(), payload } as PluginEvent, BASE_URL);
}

function linkedField(payload: Record<string, unknown>) {
  const fields = renderCard(payload).embeds?.[0]?.fields ?? [];
  return fields.find((f) => f.name.startsWith("Linked Issue"));
}

beforeEach(() => {
  setPluginErrorSink(null);
  resetPluginErrorReports();
  mocks.fetchApprovalRecord.mockReset();
  mocks.fetchApprovalRecord.mockResolvedValue({ record: null, failure: null });
});

describe("enrichApprovalPayload linked issue fault isolation", () => {
  it("keeps the issues that resolved when one issues.get throws", async () => {
    const ctx = makeCtx({ issues: { get: issuesGet([ISSUE_IDS[1]]) } });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.linkedIssues).toHaveLength(2);
    expect((payload.linkedIssues as Array<{ id: string }>).map((i) => i.id)).toEqual([
      ISSUE_IDS[0],
      ISSUE_IDS[2],
    ]);
    expect(payload.failedIssueIds).toEqual([ISSUE_IDS[1]]);
    expect(payload.enrichmentDegraded).toBe(true);
    expect(payload.issueIds).toEqual(ISSUE_IDS);

    const field = linkedField(payload);
    expect(field?.name).toBe("Linked Issues (3)");
    expect(field?.value).toContain("**SOO-1** Issue 1");
    expect(field?.value).toContain("**SOO-3** Issue 3");
    expect(field?.value).toContain(`[2222bbbb](${BASE_URL}/issues/${ISSUE_IDS[1]})`);
  });

  it("renders a deep link for every issue when all lookups fail", async () => {
    const ctx = makeCtx({ issues: { get: issuesGet(ISSUE_IDS) } });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.linkedIssues).toBeUndefined();
    expect(payload.failedIssueIds).toEqual(ISSUE_IDS);

    const field = linkedField(payload);
    expect(field?.name).toBe("Linked Issues (3)");
    for (const id of ISSUE_IDS) {
      expect(field?.value).toContain(`[${id.slice(0, 8)}](${BASE_URL}/issues/${id})`);
    }
  });

  it("does not treat a deleted issue (issues.get returns null) as a failure", async () => {
    const ctx = makeCtx({
      issues: {
        get: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === ISSUE_IDS[1] ? null : issueRow(id, ISSUE_IDS.indexOf(id) + 1)),
        ),
      },
    });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.linkedIssues).toHaveLength(2);
    expect(payload.failedIssueIds).toBeUndefined();
    expect(payload.enrichmentDegraded).toBeUndefined();
    expect(linkedField(payload)?.value).toContain(
      `[2222bbbb](${BASE_URL}/issues/${ISSUE_IDS[1]})`,
    );
  });
});

describe("enrichApprovalPayload stage isolation", () => {
  it("still resolves the requester name and linked issues when the approval lookup throws", async () => {
    mocks.fetchApprovalRecord.mockRejectedValue(new Error("approvals API is down"));
    const ctx = makeCtx({
      agents: { list: vi.fn().mockResolvedValue([{ id: "agent-uuid", name: "Scribe" }]) },
      issues: { get: issuesGet([]) },
    });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.agentName).toBe("Scribe");
    expect(payload.linkedIssues).toHaveLength(3);
    expect(payload.enrichmentDegraded).toBe(true);
    expect(payload.failedIssueIds).toBeUndefined();
  });

  it("still resolves linked issues when the agent lookup throws", async () => {
    const ctx = makeCtx({
      agents: { list: vi.fn().mockRejectedValue(new Error("agents.list exploded")) },
      issues: { get: issuesGet([]) },
    });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.agentName).toBeUndefined();
    expect(payload.linkedIssues).toHaveLength(3);
    expect(payload.enrichmentDegraded).toBe(true);
  });

  it("merges the approval row payload without overwriting the event payload", async () => {
    mocks.fetchApprovalRecord.mockResolvedValue({
      record: {
        id: "apr-1",
        type: "budget",
        requestedByAgentId: "requester-agent",
        payload: { title: "From the approval row", description: "Why this matters" },
      },
      failure: null,
    });
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.title).toBe("Ship it");
    expect(payload.description).toBe("Why this matters");
    expect(payload.type).toBe("strategy");
    expect(payload.agentId).toBe("requester-agent");
    expect(payload.enrichmentDegraded).toBeUndefined();
  });

  it("treats an approval lookup that returns no row as degraded, not as silence", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    mocks.fetchApprovalRecord.mockResolvedValue({
      record: null,
      failure: "GET /api/approvals: 401 Unauthorized",
    });
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.enrichmentDegraded).toBe(true);
    expect(payload.linkedIssues).toHaveLength(3);
    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0][1] as PluginErrorReport).detail).toContain("401 Unauthorized");
  });

  it("stays quiet when no approval lookup path was available", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.enrichmentDegraded).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();
  });

  it("never throws, even when every stage fails", async () => {
    mocks.fetchApprovalRecord.mockRejectedValue(new Error("boom"));
    const ctx = makeCtx({
      agents: { list: vi.fn().mockRejectedValue(new Error("boom")) },
      issues: { get: issuesGet(ISSUE_IDS) },
    });

    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload.approvalId).toBe("apr-1");
    expect(payload.issueIds).toEqual(ISSUE_IDS);
    expect(payload.enrichmentDegraded).toBe(true);
  });
});

describe("enrichApprovalPayload error channel reporting", () => {
  it("reports a degraded enrichment once with the approval dedup key", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx({ issues: { get: issuesGet([ISSUE_IDS[1]]) } });

    await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);
    await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(sink).toHaveBeenCalledTimes(1);
    const report = sink.mock.calls[0][1] as PluginErrorReport;
    expect(report.source).toBe("approval-enrichment");
    expect(report.dedupKey).toBe("approval-enrichment:apr-1");
    expect(report.companyId).toBe("co-1");
    expect(report.detail).toContain(ISSUE_IDS[1]);
  });

  it("scopes the stage dedup key to the company, so a second company still hears about it", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    mocks.fetchApprovalRecord.mockResolvedValue({
      record: null,
      failure: "GET /api/approvals: 503 Service Unavailable",
    });
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });

    await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);
    await enrichApprovalPayload(ctx, makeApprovalEvent({ entityId: "apr-2" }), OPTS);
    expect(sink).toHaveBeenCalledTimes(1);

    await enrichApprovalPayload(ctx, makeApprovalEvent({ companyId: "co-2", entityId: "apr-3" }), {
      ...OPTS,
      companyId: "co-2",
    });

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map((call) => (call[1] as PluginErrorReport).dedupKey)).toEqual([
      "approval-enrichment:stage:co-1:approval record",
      "approval-enrichment:stage:co-2:approval record",
    ]);
    expect((sink.mock.calls[1][1] as PluginErrorReport).companyId).toBe("co-2");
  });

  it("does not report when nothing degraded", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });

    await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(sink).not.toHaveBeenCalled();
  });
});

describe("formatApprovalCreated degraded footer", () => {
  it("counts the unresolved linked issues in the footer", async () => {
    const ctx = makeCtx({ issues: { get: issuesGet([ISSUE_IDS[0], ISSUE_IDS[1]]) } });
    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(renderCard(payload).embeds?.[0]?.footer?.text).toBe(
      "Paperclip • ⚠️ 일부 연결 이슈 정보를 불러오지 못했습니다 (2건)",
    );
  });

  it("warns about approval detail when a stage failed but no issue id did", async () => {
    mocks.fetchApprovalRecord.mockRejectedValue(new Error("approvals API is down"));
    const ctx = makeCtx({ issues: { get: issuesGet([]) } });
    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(renderCard(payload).embeds?.[0]?.footer?.text).toBe(
      "Paperclip • ⚠️ 일부 승인 정보를 불러오지 못했습니다",
    );
  });

  it("leaves the footer and payload untouched on the healthy path", async () => {
    const ctx = makeCtx({
      agents: { list: vi.fn().mockResolvedValue([{ id: "agent-uuid", name: "Scribe" }]) },
      issues: { get: issuesGet([]) },
    });
    const payload = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);

    expect(payload).not.toHaveProperty("enrichmentDegraded");
    expect(payload).not.toHaveProperty("failedIssueIds");

    const embed = renderCard(payload).embeds?.[0];
    expect(embed?.footer?.text).toBe("Paperclip");
    const fieldNames = (embed?.fields ?? []).map((f) => f.name);
    expect(fieldNames).not.toContain("enrichmentDegraded");
    expect(fieldNames).not.toContain("failedIssueIds");
  });

  it("never exposes the degradation flags as catch-all fields", () => {
    const embed = renderCard({
      type: "strategy",
      issueIds: [ISSUE_IDS[0]],
      enrichmentDegraded: true,
      failedIssueIds: [ISSUE_IDS[0]],
    }).embeds?.[0];

    const fieldNames = (embed?.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(["Type", "Linked Issue"]);
  });
});

describe("formatApprovalCreated linked issue field", () => {
  it("names the field in the singular for one issue", () => {
    const field = linkedField({ issueIds: [ISSUE_IDS[0]] });
    expect(field?.name).toBe("Linked Issue");
    expect(field?.value).toBe(`[1111aaaa](${BASE_URL}/issues/${ISSUE_IDS[0]})`);
  });

  it("falls back to the bare id when there is no dashboard base url", () => {
    const msg = formatApprovalCreated(
      { ...makeApprovalEvent(), payload: { issueIds: [ISSUE_IDS[0]] } } as PluginEvent,
      "http://localhost:3100",
    );
    const field = (msg.embeds?.[0]?.fields ?? []).find((f) => f.name.startsWith("Linked Issue"));
    expect(field?.value).toBe(ISSUE_IDS[0]);
  });

  it("renders linkedIssues that no issueIds entry points at", () => {
    const field = linkedField({
      issueIds: [],
      linkedIssues: [{ id: ISSUE_IDS[0], identifier: "SOO-1", title: "Issue 1", status: "todo" }],
    });
    expect(field?.name).toBe("Linked Issue");
    expect(field?.value).toContain("**SOO-1** Issue 1");
  });

  it("drops whole issues rather than cutting one in half at the Discord limit", () => {
    const linkedIssues = ISSUE_IDS.map((id, n) => ({
      id,
      identifier: `SOO-${n}`,
      title: "x".repeat(600),
    }));
    const field = linkedField({ issueIds: ISSUE_IDS, linkedIssues });

    expect(field?.value.length).toBeLessThanOrEqual(1024);
    expect(field?.value).toContain("**SOO-0**");
    expect(field?.value).toMatch(/…and 2 more$/);
  });

  it("never cuts through a deep link when many issues go unresolved", () => {
    const ids = Array.from(
      { length: 40 },
      (_, n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const field = linkedField({ issueIds: ids });

    expect(field?.value.length).toBeLessThanOrEqual(1024);
    expect(field?.value).toMatch(/…and \d+ more$/);
    const rendered = field?.value.split("\n\n").filter((line) => line.startsWith("[")) ?? [];
    for (const line of rendered) {
      expect(line).toMatch(/^\[[0-9a-f]{8}\]\(https:\/\/\S+\/issues\/\S+\)$/);
    }
    const omitted = Number(/…and (\d+) more$/.exec(field?.value ?? "")?.[1]);
    expect(rendered.length + omitted).toBe(ids.length);
  });
});
