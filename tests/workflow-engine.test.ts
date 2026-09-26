import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runWorkflow,
  getWorkflowStore,
  saveWorkflowStore,
  resumeWorkflowAfterApproval,
  BUILTIN_COMMANDS,
  type Workflow,
  type WorkflowStep,
  type WorkflowCommandStore,
} from "../src/workflow-engine.js";

const mockPaperclipFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ id: "issue-1", title: "Test Issue" }),
  text: () => Promise.resolve("ok"),
  headers: { get: () => "application/json" },
});
vi.mock("../src/paperclip-fetch.js", () => ({
  paperclipFetch: (...args: unknown[]) => mockPaperclipFetch(...args),
}));

function makeCtx(stateMap: Map<string, unknown> = new Map()) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(({ stateKey }: { stateKey: string }) => stateMap.get(stateKey) ?? null),
      set: vi.fn(({ stateKey }: { stateKey: string }, val: unknown) => {
        if (val === null) stateMap.delete(stateKey);
        else stateMap.set(stateKey, val);
      }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "issue-1", title: "Test Issue" }),
        text: () => Promise.resolve("ok"),
        headers: { get: () => "application/json" },
      }),
    },
    agents: {
      invoke: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn() },
    events: { emit: vi.fn() },
  } as any;
}

beforeEach(() => {
  mockPaperclipFetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: "issue-1", title: "Test Issue" }),
    text: () => Promise.resolve("ok"),
    headers: { get: () => "application/json" },
  });
});

const baseOpts = {
  token: "test-token",
  channelId: "ch-1",
  companyId: "company-1",
  baseUrl: "http://localhost:3100",
  paperclipBoardApiKey: "",
  args: "",
};

// ---------------------------------------------------------------------------
// Template interpolation (tested through runWorkflow)
// ---------------------------------------------------------------------------

describe("runWorkflow — template interpolation", () => {
  it("interpolates {{args}} and {{arg0}}", async () => {
    const ctx = makeCtx();
    mockPaperclipFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: "i-1" }),
      headers: { get: () => "application/json" },
    });

    const wf: Workflow = {
      name: "test",
      steps: [{ type: "fetch_issue", id: "s1", issueId: "{{arg0}}" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "my-issue-id extra" });
    expect(result.ok).toBe(true);
    expect(mockPaperclipFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/issues/my-issue-id"),
      expect.anything(),
      expect.any(String),
    );
  });

  it("interpolates {{prev.result}}", async () => {
    const ctx = makeCtx();
    // Step 1: set_state, Step 2: send_message referencing prev
    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "set_state", stateKey: "foo", stateValue: "bar" },
        { type: "set_state", stateKey: "captured", stateValue: "{{prev.result}}" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(2);
  });

  it("interpolates {{step_id.result}}", async () => {
    const ctx = makeCtx();
    mockPaperclipFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: "i-1", title: "My Issue" }),
      headers: { get: () => "application/json" },
    });

    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "fetch_issue", id: "fetch", issueId: "issue-1" },
        { type: "set_state", stateKey: "title", stateValue: "{{fetch.result}}" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

describe("runWorkflow — step types", () => {
  it("fetch_issue succeeds", async () => {
    const ctx = makeCtx();
    mockPaperclipFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: "i-1", title: "Test" }),
      headers: { get: () => "application/json" },
    });

    const wf: Workflow = {
      name: "test",
      steps: [{ type: "fetch_issue", issueId: "i-1" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(1);
  });

  it("fetch_issue fails without issueId", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "fetch_issue" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Missing issueId");
  });

  // invoke_agent is removed (plan item 6): no workflow step lets an agent
  // spawn another agent invocation. A stored workflow that still names it
  // (e.g. from before the upgrade) fails that one step cleanly rather than
  // silently invoking anything.
  it("invoke_agent is an unknown step type, not silently executed", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "invoke_agent" as any, agentId: "agent-1", prompt: "hello" } as any],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unknown step type: invoke_agent");
    expect(ctx.agents.invoke).not.toHaveBeenCalled();
  });

  it("http_request makes fetch call via ctx.http.fetch", async () => {
    const ctx = makeCtx();
    // http_request must use ctx.http.fetch (not paperclipFetch) to preserve private-IP restriction
    ctx.http.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ data: "response" }),
      headers: { get: () => "application/json" },
    });

    const wf: Workflow = {
      name: "test",
      steps: [{ type: "http_request", url: "https://example.com/api", method: "POST", body: '{"key":"val"}' }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(ctx.http.fetch).toHaveBeenCalledWith("https://example.com/api", expect.objectContaining({ method: "POST" }));
    // paperclipFetch must NOT be used for user-controlled URLs
    expect(mockPaperclipFetch).not.toHaveBeenCalledWith("https://example.com/api", expect.anything());
  });

  it("http_request fails without url", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "http_request" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Missing url");
  });

  it("send_message fails without message", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "send_message" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Missing message");
  });

  // create_issue is removed (plan item 6): no workflow step lets an agent
  // create a new issue. Same "unknown step type" treatment as invoke_agent.
  it("create_issue is an unknown step type, not silently executed", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "create_issue" as any, title: "Bug: {{arg0}}" } as any],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "login-broken" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unknown step type: create_issue");
    expect(mockPaperclipFetch).not.toHaveBeenCalled();
  });

  it("set_state stores value in workflow context", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "set_state", stateKey: "myKey", stateValue: "myVal" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(1);
  });

  it("set_state fails without stateKey", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "set_state" }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Missing stateKey");
  });

  it("unknown step type returns error", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [{ type: "unknown_type" as any }],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown step type");
  });
});

// ---------------------------------------------------------------------------
// Multi-step and error handling
// ---------------------------------------------------------------------------

describe("runWorkflow — multi-step and errors", () => {
  it("stops on step failure", async () => {
    const ctx = makeCtx();
    mockPaperclipFetch.mockResolvedValueOnce({
      ok: false, status: 404,
      json: () => Promise.resolve({}),
      headers: { get: () => "application/json" },
    });

    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "fetch_issue", issueId: "bad-id" },
        { type: "set_state", stateKey: "k", stateValue: "v" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.error).toContain("API 404");
  });

  it("completes all steps on success", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "set_state", stateKey: "a", stateValue: "1" },
        { type: "set_state", stateKey: "b", stateValue: "2" },
        { type: "set_state", stateKey: "c", stateValue: "3" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({ ...baseOpts, ctx, workflow: wf, args: "" });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(3);
  });

  it("resumes from a given step index", async () => {
    const ctx = makeCtx();
    const wf: Workflow = {
      name: "test",
      steps: [
        { type: "set_state", stateKey: "a", stateValue: "should-skip" },
        { type: "set_state", stateKey: "b", stateValue: "should-run" },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await runWorkflow({
      ...baseOpts,
      ctx,
      workflow: wf,
      args: "",
      resumeFromStep: 1,
      resumeCtx: { args: [], fullArgs: "", results: {}, state: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.stepsCompleted).toBe(2); // reports total steps
  });
});

// ---------------------------------------------------------------------------
// Workflow store
// ---------------------------------------------------------------------------

describe("getWorkflowStore / saveWorkflowStore", () => {
  it("returns empty store when no state exists", async () => {
    const ctx = makeCtx();
    const store = await getWorkflowStore(ctx, "comp-1");
    expect(store.workflows).toEqual({});
  });

  it("round-trips store through save and get", async () => {
    const stateMap = new Map<string, unknown>();
    const ctx = makeCtx(stateMap);

    const store: WorkflowCommandStore = {
      workflows: {
        greet: { name: "greet", steps: [{ type: "send_message", message: "hi" }], createdAt: "2026-01-01" },
      },
    };

    await saveWorkflowStore(ctx, "comp-1", store);
    const loaded = await getWorkflowStore(ctx, "comp-1");
    expect(loaded.workflows.greet).toBeDefined();
    expect(loaded.workflows.greet!.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resumeWorkflowAfterApproval
// ---------------------------------------------------------------------------

describe("resumeWorkflowAfterApproval", () => {
  it("returns error when pending state is missing", async () => {
    const ctx = makeCtx();
    const result = await resumeWorkflowAfterApproval(ctx, "tok", "ch", "comp", "http://localhost:3100", "bad-id", true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns ok without running when rejected", async () => {
    const stateMap = new Map<string, unknown>();
    stateMap.set("wf_pending_approval-1", {
      workflowName: "test",
      stepIndex: 0,
      wfCtx: { args: [], fullArgs: "", results: {}, state: {} },
    });
    const ctx = makeCtx(stateMap);

    const result = await resumeWorkflowAfterApproval(ctx, "tok", "ch", "comp", "http://localhost:3100", "approval-1", false);
    expect(result.ok).toBe(true);
    // Pending state should be cleaned up
    expect(stateMap.has("wf_pending_approval-1")).toBe(false);
  });

  it("returns error when workflow no longer exists", async () => {
    const stateMap = new Map<string, unknown>();
    stateMap.set("wf_pending_approval-2", {
      workflowName: "deleted-wf",
      stepIndex: 0,
      wfCtx: { args: [], fullArgs: "", results: {}, state: {} },
    });
    const ctx = makeCtx(stateMap);

    const result = await resumeWorkflowAfterApproval(ctx, "tok", "ch", "comp", "http://localhost:3100", "approval-2", true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer exists");
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_COMMANDS
// ---------------------------------------------------------------------------

describe("BUILTIN_COMMANDS", () => {
  it("contains all expected commands", () => {
    expect(BUILTIN_COMMANDS.has("status")).toBe(true);
    expect(BUILTIN_COMMANDS.has("approve")).toBe(true);
    expect(BUILTIN_COMMANDS.has("budget")).toBe(true);
    expect(BUILTIN_COMMANDS.has("issues")).toBe(true);
    expect(BUILTIN_COMMANDS.has("agents")).toBe(true);
    expect(BUILTIN_COMMANDS.has("help")).toBe(true);
    expect(BUILTIN_COMMANDS.has("connect")).toBe(true);
    expect(BUILTIN_COMMANDS.has("connect-channel")).toBe(true);
    expect(BUILTIN_COMMANDS.has("digest")).toBe(true);
    expect(BUILTIN_COMMANDS.has("commands")).toBe(true);
  });

  it("does not include arbitrary names", () => {
    expect(BUILTIN_COMMANDS.has("greet")).toBe(false);
    expect(BUILTIN_COMMANDS.has("deploy")).toBe(false);
  });
});
