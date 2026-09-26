import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postEmbedWithId } from "./discord-api.js";
import { COLORS } from "./constants.js";
import { paperclipFetch } from "./paperclip-fetch.js";

// ---------------------------------------------------------------------------
// Workflow Engine — sequential step execution with template interpolation
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id?: string;
  // "invoke_agent" and "create_issue" are removed (plan item 6): the v1
  // runaway came from agents waking agents, so no workflow step lets one
  // spawn an agent invocation or create a new issue.
  type:
    | "fetch_issue"
    | "http_request"
    | "send_message"
    | "wait_approval"
    | "set_state";
  // Per-step config (varies by type)
  issueId?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  message?: string;
  channelId?: string;
  stateKey?: string;
  stateValue?: string;
  approvalMessage?: string;
}

export interface Workflow {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  createdAt: string;
  createdBy?: string;
}

export interface WorkflowCommandStore {
  workflows: Record<string, Workflow>;
}

interface StepResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface WorkflowContext {
  args: string[];
  fullArgs: string;
  results: Record<string, StepResult>;
  prevResult: StepResult | null;
  state: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

function interpolate(template: string, wfCtx: WorkflowContext): string {
  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key: string) => {
    // {{arg0}}, {{arg1}}, ...
    const argMatch = key.match(/^arg(\d+)$/);
    if (argMatch) {
      const idx = parseInt(argMatch[1]!, 10);
      return wfCtx.args[idx] ?? "";
    }

    // {{args}} — full args string
    if (key === "args") {
      return wfCtx.fullArgs;
    }

    // {{prev.result}}
    if (key === "prev.result") {
      return wfCtx.prevResult ? stringify(wfCtx.prevResult.result) : "";
    }

    // {{step_id.result}}
    const dotIdx = key.indexOf(".");
    if (dotIdx > 0) {
      const stepId = key.slice(0, dotIdx);
      const field = key.slice(dotIdx + 1);
      const stepResult = wfCtx.results[stepId];
      if (stepResult && field === "result") {
        return stringify(stepResult.result);
      }
    }

    // {{state_key}}
    if (key in wfCtx.state) {
      return stringify(wfCtx.state[key]);
    }

    return `{{${key}}}`;
  });
}

function stringify(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

async function execFetchIssue(
  ctx: PluginContext,
  step: WorkflowStep,
  wfCtx: WorkflowContext,
  baseUrl: string,
  apiKey: string,
): Promise<StepResult> {
  const issueId = interpolate(step.issueId ?? "", wfCtx);
  if (!issueId) return { ok: false, error: "Missing issueId" };

  try {
    const resp = await paperclipFetch(`${baseUrl}/api/issues/${issueId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }, apiKey);
    if (!resp.ok) return { ok: false, error: `API ${resp.status}` };
    const data = await resp.json();
    return { ok: true, result: data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function execHttpRequest(
  ctx: PluginContext,
  step: WorkflowStep,
  wfCtx: WorkflowContext,
): Promise<StepResult> {
  const url = interpolate(step.url ?? "", wfCtx);
  const method = (step.method ?? "GET").toUpperCase();
  if (!url) return { ok: false, error: "Missing url" };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (step.headers) {
    for (const [k, v] of Object.entries(step.headers)) {
      headers[k] = interpolate(v, wfCtx);
    }
  }

  const init: RequestInit = { method, headers };
  if (step.body && method !== "GET") {
    init.body = interpolate(step.body, wfCtx);
  }

  try {
    // Use ctx.http.fetch (NOT paperclipFetch) for user-configured URLs to
    // preserve the private-IP restriction and prevent SSRF.
    const resp = await ctx.http.fetch(url, init);
    let data: unknown;
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }
    return resp.ok
      ? { ok: true, result: data }
      : { ok: false, error: `HTTP ${resp.status}`, result: data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function execSendMessage(
  ctx: PluginContext,
  step: WorkflowStep,
  wfCtx: WorkflowContext,
  token: string,
  defaultChannelId: string,
): Promise<StepResult> {
  const message = interpolate(step.message ?? "", wfCtx);
  const channelId = interpolate(step.channelId ?? "", wfCtx) || defaultChannelId;
  if (!message) return { ok: false, error: "Missing message" };

  const msgId = await postEmbedWithId(ctx, token, channelId, {
    embeds: [
      {
        description: message,
        color: COLORS.BLUE,
        footer: { text: "Paperclip Workflow" },
        timestamp: new Date().toISOString(),
      },
    ],
  });

  return msgId
    ? { ok: true, result: { messageId: msgId, channelId } }
    : { ok: false, error: "Failed to send message" };
}

async function execWaitApproval(
  ctx: PluginContext,
  step: WorkflowStep,
  wfCtx: WorkflowContext,
  token: string,
  defaultChannelId: string,
  workflowName: string,
  stepIndex: number,
  companyId: string,
): Promise<StepResult & { suspended?: true }> {
  const message = interpolate(step.approvalMessage ?? "Workflow requires approval to continue.", wfCtx);
  const channelId = interpolate(step.channelId ?? "", wfCtx) || defaultChannelId;

  const approvalId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const msgId = await postEmbedWithId(ctx, token, channelId, {
    embeds: [
      {
        title: "Workflow Approval Required",
        description: message,
        color: COLORS.YELLOW,
        fields: [
          { name: "Workflow", value: workflowName, inline: true },
          { name: "Step", value: `${stepIndex + 1}`, inline: true },
        ],
        footer: { text: `Approval ID: ${approvalId}` },
        timestamp: new Date().toISOString(),
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
            custom_id: `wf_approve_${approvalId}`,
          },
          {
            type: 2,
            style: 4,
            label: "Reject",
            custom_id: `wf_reject_${approvalId}`,
          },
        ],
      },
    ],
  });

  if (!msgId) return { ok: false, error: "Failed to send approval message" };

  // Store suspended workflow state so it can be resumed on button click
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `wf_pending_${approvalId}` },
    {
      approvalId,
      workflowName,
      stepIndex,
      wfCtx: {
        args: wfCtx.args,
        fullArgs: wfCtx.fullArgs,
        results: wfCtx.results,
        state: wfCtx.state,
      },
      channelId,
      messageId: msgId,
      createdAt: new Date().toISOString(),
    },
  );

  return { ok: true, result: { approvalId, suspended: true }, suspended: true };
}

async function execSetState(
  step: WorkflowStep,
  wfCtx: WorkflowContext,
): Promise<StepResult> {
  const key = interpolate(step.stateKey ?? "", wfCtx);
  const value = interpolate(step.stateValue ?? "", wfCtx);
  if (!key) return { ok: false, error: "Missing stateKey" };

  wfCtx.state[key] = value;
  return { ok: true, result: { key, value } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WorkflowRunOptions {
  ctx: PluginContext;
  token: string;
  channelId: string;
  companyId: string;
  baseUrl: string;
  /** Paperclip board API key. Empty string disables Authorization header
   * (correct for `local_trusted` deployments). Required for `authenticated`. */
  paperclipBoardApiKey: string;
  workflow: Workflow;
  args: string;
  /** Resume from this step index (for approval continuation) */
  resumeFromStep?: number;
  /** Restored context when resuming */
  resumeCtx?: { args: string[]; fullArgs: string; results: Record<string, StepResult>; state: Record<string, unknown> };
}

export async function runWorkflow(opts: WorkflowRunOptions): Promise<{
  ok: boolean;
  stepsCompleted: number;
  suspended?: boolean;
  error?: string;
}> {
  const { ctx, token, channelId, companyId, baseUrl, paperclipBoardApiKey, workflow, args } = opts;

  const wfCtx: WorkflowContext = opts.resumeCtx
    ? { ...opts.resumeCtx, prevResult: null }
    : {
        args: args.split(/\s+/).filter(Boolean),
        fullArgs: args,
        results: {},
        prevResult: null,
        state: {},
      };

  const startStep = opts.resumeFromStep ?? 0;

  for (let i = startStep; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    let result: StepResult & { suspended?: true };

    switch (step.type) {
      case "fetch_issue":
        result = await execFetchIssue(ctx, step, wfCtx, baseUrl, paperclipBoardApiKey);
        break;
      case "http_request":
        result = await execHttpRequest(ctx, step, wfCtx);
        break;
      case "send_message":
        result = await execSendMessage(ctx, step, wfCtx, token, channelId);
        break;
      case "wait_approval":
        result = await execWaitApproval(ctx, step, wfCtx, token, channelId, workflow.name, i, companyId);
        break;
      case "set_state":
        result = await execSetState(step, wfCtx);
        break;
      default:
        result = { ok: false, error: `Unknown step type: ${(step as WorkflowStep).type}` };
    }

    // Store result by step id
    if (step.id) {
      wfCtx.results[step.id] = { ok: result.ok, result: result.result, error: result.error };
    }
    wfCtx.prevResult = { ok: result.ok, result: result.result, error: result.error };

    // If suspended (wait_approval), stop execution — will resume on button click
    if (result.suspended) {
      return { ok: true, stepsCompleted: i + 1, suspended: true };
    }

    // Stop on error
    if (!result.ok) {
      ctx.logger.warn("Workflow step failed", {
        workflow: workflow.name,
        step: i,
        type: step.type,
        error: result.error,
      });
      return { ok: false, stepsCompleted: i, error: result.error };
    }
  }

  return { ok: true, stepsCompleted: workflow.steps.length };
}

// ---------------------------------------------------------------------------
// Workflow store helpers
// ---------------------------------------------------------------------------

const STORE_KEY_PREFIX = "commands_";

export async function getWorkflowStore(
  ctx: PluginContext,
  companyId: string,
): Promise<WorkflowCommandStore> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `${STORE_KEY_PREFIX}${companyId}`,
  });
  if (!raw) return { workflows: {} };
  return raw as WorkflowCommandStore;
}

export async function saveWorkflowStore(
  ctx: PluginContext,
  companyId: string,
  store: WorkflowCommandStore,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `${STORE_KEY_PREFIX}${companyId}` },
    store,
  );
}

// ---------------------------------------------------------------------------
// Resume a suspended workflow after approval button click
// ---------------------------------------------------------------------------

export async function resumeWorkflowAfterApproval(
  ctx: PluginContext,
  token: string,
  channelId: string,
  companyId: string,
  baseUrl: string,
  approvalId: string,
  approved: boolean,
  paperclipBoardApiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const pending = (await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `wf_pending_${approvalId}`,
  })) as {
    workflowName: string;
    stepIndex: number;
    wfCtx: { args: string[]; fullArgs: string; results: Record<string, StepResult>; state: Record<string, unknown> };
  } | null;

  if (!pending) return { ok: false, error: "Pending workflow not found" };

  // Clean up the pending state
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `wf_pending_${approvalId}` },
    null,
  );

  if (!approved) {
    return { ok: true };
  }

  // Load the workflow definition
  const store = await getWorkflowStore(ctx, companyId);
  const workflow = store.workflows[pending.workflowName];
  if (!workflow) return { ok: false, error: `Workflow "${pending.workflowName}" no longer exists` };

  // Inject the approval result into the context
  const resumeCtx = {
    ...pending.wfCtx,
    prevResult: null,
  };

  // Store approval result for the wait_approval step
  const step = workflow.steps[pending.stepIndex];
  if (step?.id) {
    resumeCtx.results[step.id] = { ok: true, result: { approved: true } };
  }

  const result = await runWorkflow({
    ctx,
    token,
    channelId,
    companyId,
    baseUrl,
    paperclipBoardApiKey,
    workflow,
    args: pending.wfCtx.fullArgs,
    resumeFromStep: pending.stepIndex + 1,
    resumeCtx,
  });

  return { ok: result.ok, error: result.error };
}

// ---------------------------------------------------------------------------
// Built-in command names that cannot be overridden
// ---------------------------------------------------------------------------

export const BUILTIN_COMMANDS = new Set([
  "status",
  "approve",
  "budget",
  "issues",
  "agents",
  "help",
  "connect",
  "connect-channel",
  "digest",
  "commands",
]);
