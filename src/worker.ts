import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, COLORS, METRIC_NAMES, PLUGIN_ID, WEBHOOK_KEYS, ACP_PLUGIN_EVENT_PREFIX, BUDGET_ALERT_THRESHOLD } from "./constants.js";
import { paperclipFetch } from "./paperclip-fetch.js";
import {
  postEmbed,
  postEmbedWithId,
  getApplicationId,
  registerSlashCommands,
  respondToInteraction,
  type DiscordEmbed,
  type DiscordComponent,
} from "./discord-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatSessionFailure,
  formatBudgetWarning,
  formatAgentRunStarted,
  formatAgentRunFinished,
  humanizePriority,
} from "./formatters.js";
import { handleInteraction, SLASH_COMMANDS, type CommandContext } from "./commands.js";
import { runIntelligenceScan, runBackfill } from "./intelligence.js";
import { connectGateway, type GatewayHandle, type MessageCreateEvent } from "./gateway.js";
import {
  handleAcpOutput,
  routeMessageToAgent,
  createAgentThread,
  spawnAgentInThread,
  closeAgentInThread,
  initiateHandoff,
  startDiscussion,
} from "./session-registry.js";
import { AsyncResource } from "node:async_hooks";
import { DiscordAdapter } from "./adapter.js";
import { processMediaMessage, type MediaAttachment } from "./media-pipeline.js";
import { registerCommand, parseCommandMessage, executeCommand, listCommands } from "./custom-commands.js";
import { registerWatch, checkWatches } from "./proactive-suggestions.js";
import {
  describeUnusableSecretRef,
  isUsableSecretRef,
  normalizeSecretRefId,
  resolveStartupDiscordBotToken,
  summarizeError,
  toSecretRefBinding,
  SECRET_RESOLUTION_ISSUE_URL,
  type DiscordRuntimeHealth,
  type DiscordSecretRef,
} from "./runtime-token.js";

import {
  type EscalationRecord,
  getEscalation,
  saveEscalation,
  trackPendingEscalation,
  untrackPendingEscalation,
  collectPendingEscalationIds,
} from "./escalation-state.js";

type DiscordConfig = {
  /**
   * Secret reference for the Discord bot token. Accepts both the settings
   * picker's object binding and a legacy bare secret UUID string.
   */
  discordBotTokenRef: DiscordSecretRef;
  paperclipBoardApiKeyRef?: DiscordSecretRef;
  defaultGuildId: string;
  defaultChannelId: string;
  approvalsChannelId: string;
  errorsChannelId: string;
  bdPipelineChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  enableIntelligence: boolean;
  intelligenceChannelIds: string[];
  backfillDays: number;
  paperclipBaseUrl: string;
  intelligenceRetentionDays: number;
  escalationChannelId: string;
  enableEscalations: boolean;
  escalationTimeoutMinutes: number;
  maxAgentsPerThread: number;
  enableMediaPipeline: boolean;
  mediaChannelIds: string[];
  enableCustomCommands: boolean;
  enableProactiveSuggestions: boolean;
  proactiveScanIntervalMinutes: number;
  enableCommands: boolean;
  enableInbound: boolean;
  topicRouting: boolean;
  digestMode: string;
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  /**
   * Per-company channel overrides. Keys are Paperclip company UUIDs; values are
   * Discord channel IDs. When a plugin install serves multiple companies, each
   * event type routes to the company-specific channel listed here; if a
   * company is not mapped, the event falls back to the default/global channel.
   *
   * Example:
   *   { "3060c8cb-...": "1490608926423646298", "4427f9e2-...": "1490610083728588950" }
   */
  companyChannels?: Record<string, string>;
  /**
   * Per-company approval channel overrides. Checked specifically for
   * `approval.created` events before `companyChannels`. Use this when
   * different companies have dedicated approvals channels.
   */
  approvalsChannels?: Record<string, string>;
};

type IssueNotificationPayload = Record<string, unknown>;

type AgentRunNotificationPayload = Record<string, unknown> & {
  runId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
};

// EscalationRecord is imported from ./escalation-state.js

interface EscalationCreatedPayload {
  escalationId: string;
  companyId: string;
  agentName: string;
  reason: string;
  confidenceScore?: number;
  agentReasoning?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  suggestedReply?: string;
}

const SNOWFLAKE_ID_REGEX = /^\d{17,20}$/;

/** Returned by tools and actions invoked before the runtime is bootstrapped. */
const RUNTIME_NOT_READY_MESSAGE =
  "Discord plugin is not configured yet: save the plugin configuration for this company to activate it.";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
//
// setup() runs OUTSIDE any company scope. Since paperclipai/paperclip#9557 the
// SDK's governed-access gate requires a company scope for `config.get()` and
// `secrets.resolve()`, so a worker cannot read its own configuration while it
// starts: an unscoped `ctx.config.get()` in setup() throws and kills activation.
//
// setup() therefore only registers handlers. Everything that needs config or a
// secret lives in this runtime, and `onConfigChanged` is the ONLY thing that
// starts it: the host delivers stored configuration with its company scope —
// replayed at worker start from v2026.817.0 (paperclipai/paperclip#10092), and
// on every save on every host.
//
// An invocation never bootstraps. It cannot establish ownership the host would
// agree with: `config.get` does not move the SDK's recorded company, so a
// runtime adopted from an invocation would own an install the SDK still
// considers unowned, and on a fresh install it would adopt an empty `{}` row
// while the SDK's owner stayed null. Invocations only ever read the runtime a
// delivery already established.
//
// Ownership follows the host: the first company whose configuration arrives owns
// this install, and any other company is logged and refused — except for the
// host's own equal-config rule, mirrored in `claimOwnership`.
// `multiCompanyConfig` stays unset, so the host also fails a second company's
// config closed rather than rebinding this worker.

/**
 * Everything one voice lifecycle owns, in one object bound to one runtime.
 *
 * Voice is full of work that finishes later — a transcription in flight, a
 * webhook lookup in flight, a health note written minutes ago — and all of it
 * has to agree about which runtime it belongs to. Ownership of an install can
 * legitimately advance from one company to another (see `claimOwnership`), so
 * an async completion that consults whatever runtime happens to be current when
 * it lands can cross the company boundary: an utterance spoken under company A
 * would be filed under company B, with B's credentials, on B's issue.
 *
 * Every async completion therefore consults THIS object, never the module-level
 * runtime. `active` is the single answer to "does my work still count?", and it
 * is false from the moment `stopVoice` runs. Because the session hangs off the
 * runtime, retiring the runtime discards its health notes with it and the
 * successor starts clean.
 */
type VoiceSession = {
  /** The runtime this session serves. Never re-read from module state. */
  readonly runtime: DiscordRuntime;
  /** False from the moment this session is stopped; in-flight work must drop. */
  active: boolean;
  /** Tear-down for the voice client, installed before start() is awaited. */
  stopClient: (() => void) | null;
  /**
   * Can voice connect at all? Set when the client reports itself unavailable,
   * when startup fails, and when the gateway exposes no voice surface.
   */
  connectivityNote: string | null;
  /**
   * Can a transcribed utterance reach Paperclip? Independent of connectivity —
   * a perfectly connected voice client with nowhere to send what it hears is a
   * different problem, and being connected is no evidence that routing works.
   */
  routingNote: string | null;
  /** Single-flight resolution of the text channel behind the voice webhook. */
  textChannel: {
    /** Resolved channel id, cached for the life of the session. */
    channelId: string | null;
    /** The lookup currently in flight, shared by every concurrent caller. */
    inFlight: Promise<string | null> | null;
    /** Epoch ms before which a failed lookup is not attempted again. */
    retryAfter: number;
    /** Keeps a persistently failing lookup from logging on every utterance. */
    logged: boolean;
  };
};

type DiscordRuntime = {
  companyId: string;
  config: DiscordConfig;
  token: string;
  tokenSecretId: string;
  paperclipBoardApiKey: string;
  baseUrl: string;
  cmdCtx: CommandContext;
  adapter: DiscordAdapter;
  gateway: GatewayHandle | null;
  /** Set when the gateway reports a permanent failure, so re-bootstrap reconnects. */
  gatewayFailed: boolean;
  /**
   * This runtime's voice lifecycle, or null when voice is disabled or has not
   * started. Voice is owned by the runtime because it rides the runtime's
   * gateway socket and speaks with the runtime's company: retiring the runtime
   * must take voice with it, or a retired company's connection would keep
   * listening and its pending work would land under whoever came next.
   */
  voice: VoiceSession | null;
  /**
   * Whether the live connection identified with message intents. Intents are
   * fixed at identify time, so a change here needs a reconnect.
   */
  listenForMessages: boolean;
  /** Same, for the voice-state intent: voice cannot be added to a live socket. */
  voiceEnabled: boolean;
  /** The first-install backfill runs at most once per runtime. */
  backfillStarted: boolean;
  defaultGuildId: string | null;
  defaultChannelId: string;
  approvalsChannelId: string | null;
  errorsChannelId: string | null;
  bdPipelineChannelId: string | null;
  escalationChannelId: string | null;
  intelligenceChannelIds: string[];
  retentionDays: number;
  escalationTimeoutMs: number;
  digestMode: string;
};

/** Captured in setup() so onWebhook / onConfigChanged can reach the host APIs. */
let _pluginCtx: PluginContext | null = null;
// Captured at module load, outside any host invocation. The gateway socket is
// opened from inside the host's `configChanged` call, and every callback the
// socket schedules would otherwise inherit that call's invocation id. The host
// retires that id once the call settles, so later slash commands and messages
// would echo a dead id and be denied ("missing, expired, or unknown invocation
// scope"). Opening the socket in this root context makes gateway-driven calls
// genuinely proactive, which the host admits for configured companies.
const rootAsyncScope = new AsyncResource("discord-gateway-root");

let runtime: DiscordRuntime | null = null;
let runtimeHealth: DiscordRuntimeHealth = {
  status: "degraded",
  message: "Waiting for company-scoped configuration from the host",
  details: {
    issue: "discord-awaiting-company-config",
    reference: SECRET_RESOLUTION_ISSUE_URL,
  },
};

/**
 * The single ordered critical section every configuration delivery runs inside.
 * Host->worker requests are NOT serialized by the transport, so two deliveries
 * must queue against each other here.
 */
let bootstrapQueue: Promise<void> = Promise.resolve();
/** Last host error from a scoped config read, for the degraded-health message. */
let lastScopedConfigError: string | null = null;
/**
 * The company this worker serves, once one has been selected.
 *
 * Ownership is decided by the presence of a stored configuration ROW, never by
 * whether the runtime managed to start from it. It is therefore kept here rather
 * than read off the live runtime: an owner whose bot token stopped resolving has
 * no runtime, and forgetting that it is still the owner would let the next
 * company-scoped invocation bind a different company — which the host would then
 * refuse to talk to, since it replays the owner's row first and records the first
 * delivery as the single tenant.
 */
let ownerCompanyId: string | null = null;
/**
 * The configuration last accepted for the owner, for the host's equal-config rule
 * (see `claimOwnership`). Stored as stable JSON so comparison is order-insensitive.
 */
let ownerConfigJson: string | null = null;
/** Companies already refused; keeps a chatty non-owner from flooding the log. */
const refusedCompanies = new Set<string>();

/** Event de-duplication window shared by every notification handler. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
const seenEvents = new Map<string, number>();

function setRuntimeHealth(health: DiscordRuntimeHealth): void {
  runtimeHealth = health;
}

function degradeHealth(message: string, issue: string, details?: Record<string, unknown>): void {
  runtimeHealth = {
    status: "degraded",
    message,
    details: { issue, reference: SECRET_RESOLUTION_ISSUE_URL, ...details },
  };
}

/** Test seam — mirrors `_resetCompanyIdCache()` for the module-level runtime. */
export function _resetRuntimeForTests(): void {
  runtime = null;
  _pluginCtx = null;
  bootstrapQueue = Promise.resolve();
  lastScopedConfigError = null;
  ownerCompanyId = null;
  ownerConfigJson = null;
  refusedCompanies.clear();
  seenEvents.clear();
  runtimeHealth = {
    status: "degraded",
    message: "Waiting for company-scoped configuration from the host",
    details: {
      issue: "discord-awaiting-company-config",
      reference: SECRET_RESOLUTION_ISSUE_URL,
    },
  };
}

/** Current runtime, or null when the plugin has not been bootstrapped yet. */
export function _getRuntimeForTests(): DiscordRuntime | null {
  return runtime;
}

function normalizeDiscordId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDiscordIdList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeDiscordId(value))
    .filter((value): value is string => value !== null);
}

async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback: unknown,
  channelMap?: Record<string, string>,
): Promise<string | null> {
  // 1. Explicit state override via `/clip connect-channel` (per-company set at runtime).
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "discord-channel",
  });
  if (override) return normalizeDiscordId(override);

  // 2. Event-type-specific per-company map passed by the caller (e.g. approvalsChannels).
  if (channelMap && companyId && channelMap[companyId]) {
    return normalizeDiscordId(channelMap[companyId]);
  }

  // 3. General `companyChannels` map from plugin config — applies to every event type
  //    that does not have its own specific map.
  //    Read from the bootstrapped runtime: an unscoped `ctx.config.get()` here
  //    throws on every governed host (paperclipai/paperclip#9557).
  const general = runtime?.config.companyChannels;
  if (general && companyId && general[companyId]) {
    return normalizeDiscordId(general[companyId]);
  }

  // 4. Fall back to whatever the caller passed (topicChannel | overrideChannelId | default).
  return normalizeDiscordId(fallback);
}

async function enrichIssueNotificationPayload(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<IssueNotificationPayload> {
  const payload = { ...(event.payload as IssueNotificationPayload) };
  if (event.entityType !== "issue" || !event.entityId) return payload;

  try {
    const companyId = await resolveIssueCompanyIdForNotification(ctx, event, payload);
    if (!companyId) return payload;

    const issue = await ctx.issues.get(event.entityId, companyId) as {
      id: string;
      identifier?: string | null;
      title?: string | null;
      description?: string | null;
      status?: string | null;
      priority?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      executionAgentNameKey?: string | null;
      completedAt?: Date | string | null;
      updatedAt?: Date | string | null;
      project?: { name?: string | null } | null;
    } | null;

    if (issue) {
      if (payload.identifier == null) payload.identifier = issue.identifier ?? issue.id;
      if (payload.title == null) payload.title = issue.title ?? issue.identifier ?? issue.id;
      if (payload.description == null) payload.description = issue.description;
      if (payload.status == null) payload.status = issue.status;
      if (payload.priority == null) payload.priority = issue.priority;
      if (payload.assigneeAgentId == null) payload.assigneeAgentId = issue.assigneeAgentId;
      if (payload.assigneeUserId == null) payload.assigneeUserId = issue.assigneeUserId;
      if (payload.agentName == null) payload.agentName = issue.executionAgentNameKey;
      // executionAgentNameKey is not always populated — fall back to looking up the
      // assignee agent's display name so "Completed by" shows "Scribe" not "Agent".
      if (payload.agentName == null && (payload.assigneeAgentId || issue.assigneeAgentId)) {
        const agentId = payload.assigneeAgentId ?? issue.assigneeAgentId;
        const agents = await ctx.agents.list({ companyId });
        const match = (agents as Array<{ id: string; name: string }>).find((a) => a.id === agentId);
        if (match?.name) payload.agentName = match.name;
      }
      if (payload.completedAt == null && issue.completedAt) payload.completedAt = String(issue.completedAt);
      if (payload.updatedAt == null && issue.updatedAt) payload.updatedAt = String(issue.updatedAt);
      if (payload.projectName == null && issue.project?.name) payload.projectName = issue.project.name;
    }

    if (String(payload.status ?? "") === "done") {
      const comments = await ctx.issues.listComments(event.entityId, companyId) as Array<{
        authorAgentId?: string | null;
        authorUserId?: string | null;
        body: string;
        createdAt?: Date | string;
        updatedAt?: Date | string;
      }>;
      if (comments.length > 0) {
        const lastComment = [...comments].sort((a, b) => {
          const aTs = new Date(String(a.updatedAt ?? a.createdAt ?? 0)).getTime();
          const bTs = new Date(String(b.updatedAt ?? b.createdAt ?? 0)).getTime();
          return bTs - aTs;
        })[0];
        if (payload.lastComment == null) payload.lastComment = lastComment.body;
        if (payload.completedBy == null) {
          if (lastComment.authorUserId) {
            payload.completedBy = lastComment.authorUserId.startsWith("discord:")
              ? lastComment.authorUserId
              : "Board user";
          } else if (lastComment.authorAgentId) {
            payload.completedBy = payload.agentName ?? "Agent";
          }
        }
      }

      if (payload.completedBy == null) {
        if (typeof payload.assigneeUserId === "string") {
          payload.completedBy = payload.assigneeUserId.startsWith("discord:")
            ? payload.assigneeUserId
            : "Board user";
        } else {
          payload.completedBy = payload.agentName ?? payload.assigneeAgentId ?? null;
        }
      }
    }
  } catch (error) {
    ctx.logger.debug("Issue notification enrichment failed", {
      issueId: event.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return payload;
}

async function resolveIssueCompanyIdForNotification(
  ctx: PluginContext,
  event: PluginEvent,
  payload: IssueNotificationPayload,
): Promise<string | null> {
  const candidates = [
    typeof event.companyId === "string" ? event.companyId : null,
    typeof payload.companyId === "string" ? payload.companyId : null,
  ].filter((value): value is string => Boolean(value));

  for (const companyId of candidates) {
    const issue = await ctx.issues.get(event.entityId!, companyId);
    if (issue) return companyId;
  }

  const companies = await ctx.companies.list();
  for (const company of companies) {
    const issue = await ctx.issues.get(event.entityId!, company.id);
    if (issue) return company.id;
  }

  return candidates[0] ?? null;
}

export async function enrichRunPayload(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<AgentRunNotificationPayload> {
  const payload: AgentRunNotificationPayload = { ...(event.payload as AgentRunNotificationPayload) };

  // Paperclip's agent.run.* events set:
  //   entityType: "heartbeat_run", entityId: <run id>, actorId: <agent id>
  //   payload: { runId, agentId, issueId, status, ... }
  // The formatter wants agentName + issueIdentifier + issueTitle in the payload.
  const companyId =
    (typeof event.companyId === "string" && event.companyId) || null;
  const agentId =
    (typeof payload.agentId === "string" && payload.agentId) ||
    (typeof event.actorId === "string" && event.actorId) ||
    null;
  const issueId =
    (typeof payload.issueId === "string" && payload.issueId) || null;

  if (!companyId) return payload;

  try {
    if (!payload.agentName && agentId) {
      const agents = (await ctx.agents.list({ companyId })) as Array<{
        id: string;
        name: string;
      }>;
      const match = agents.find((a) => a.id === agentId);
      if (match?.name) payload.agentName = match.name;
    }

    if (issueId && (!payload.issueIdentifier || !payload.issueTitle)) {
      const issue = (await ctx.issues.get(issueId, companyId)) as {
        id: string;
        identifier?: string | null;
        title?: string | null;
      } | null;
      if (issue) {
        if (!payload.issueIdentifier) {
          payload.issueIdentifier = issue.identifier ?? issue.id;
        }
        if (!payload.issueTitle && issue.title) {
          payload.issueTitle = issue.title;
        }
      }
    }
  } catch (error) {
    ctx.logger.debug("Agent run notification enrichment failed", {
      runId: typeof payload.runId === "string" ? payload.runId : event.entityId,
      agentId,
      issueId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------
// These used to be closures inside setup() over `config`, `token` and `baseUrl`.
// Those values now arrive with the runtime, so the helpers take it explicitly.

/**
 * The runtime may redeliver events (retries, replays). Track recently processed
 * eventIds so each event produces at most one Discord message.
 */
function isDuplicate(eventId: string | undefined): boolean {
  if (!eventId) return false;
  const now = Date.now();
  // Prune stale entries on each check (cheap for small maps)
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

async function resolveTopicChannel(
  ctx: PluginContext,
  rt: DiscordRuntime,
  event: PluginEvent,
): Promise<string | null> {
  if (!rt.config.topicRouting) return null;
  const payload = event.payload as Record<string, unknown>;
  const projectName = payload.projectName ? String(payload.projectName) : null;
  if (!projectName) return null;

  const channelMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: "channel-project-map",
  })) as Record<string, string> | null;

  return normalizeDiscordId(channelMap?.[projectName]) ?? null;
}

async function notify(
  ctx: PluginContext,
  rt: DiscordRuntime,
  event: PluginEvent,
  formatter: (e: PluginEvent, baseUrl?: string) => ReturnType<typeof formatIssueCreated>,
  overrideChannelId?: string,
  channelMap?: Record<string, string>,
  onPosted?: (channelId: string, messageId: string) => Promise<void>,
): Promise<void> {
  if (isDuplicate(event.eventId)) {
    ctx.logger.debug(`Skipping duplicate event ${event.eventType} (${event.eventId})`);
    return;
  }

  const topicChannel = overrideChannelId ? null : await resolveTopicChannel(ctx, rt, event);
  const channelId = await resolveChannel(
    ctx,
    event.companyId,
    topicChannel || overrideChannelId || rt.defaultChannelId,
    channelMap,
  );
  if (!channelId) return;

  const message = formatter(event, rt.baseUrl);
  const messageId = await postEmbedWithId(ctx, rt.token, channelId, message);

  if (messageId) {
    // Store message mapping for reply routing
    if (rt.config.enableInbound !== false) {
      await ctx.state.set(
        { scopeKind: "instance", stateKey: `msg_${channelId}_${messageId}` },
        {
          entityId: event.entityId,
          entityType: event.entityType,
          companyId: event.companyId,
          eventType: event.eventType,
        },
      );
      // And the channel-level pointer voice routes by. A spoken utterance is
      // not a reply, so it has no message to inherit a destination from; this
      // gives it "whatever this channel is currently about". Last notification
      // wins — see `voiceTargetKey` for what that means at the read side.
      await ctx.state.set(
        { scopeKind: "instance", stateKey: voiceTargetKey(channelId) },
        {
          entityId: event.entityId,
          entityType: event.entityType,
          companyId: event.companyId,
        },
      );
    }

    await ctx.activity.log({
      companyId: event.companyId,
      message: `Forwarded ${event.eventType} to Discord`,
      entityType: "plugin",
      entityId: event.entityId,
    });

    if (onPosted) {
      await onPosted(channelId, messageId);
    }
  }
}

function buildEscalationEmbed(payload: EscalationCreatedPayload): {
  embeds: DiscordEmbed[];
  components: DiscordComponent[];
} {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  fields.push({ name: "Reason", value: payload.reason.slice(0, 1024) });

  if (payload.confidenceScore !== undefined) {
    fields.push({
      name: "Confidence Score",
      value: `${(payload.confidenceScore * 100).toFixed(0)}%`,
      inline: true,
    });
  }

  if (payload.agentReasoning) {
    fields.push({ name: "Agent Reasoning", value: payload.agentReasoning.slice(0, 1024) });
  }

  if (payload.suggestedReply) {
    fields.push({ name: "Suggested Reply", value: payload.suggestedReply.slice(0, 1024) });
  }

  let description: string | undefined;
  if (payload.conversationHistory && payload.conversationHistory.length > 0) {
    const recent = payload.conversationHistory.slice(-5);
    const lines = recent.map((msg) => {
      const role = msg.role === "user" ? "Customer" : msg.role === "assistant" ? "Agent" : msg.role;
      return `**${role}:** ${msg.content.slice(0, 200)}`;
    });
    description = lines.join("\n\n").slice(0, 2048);
  }

  const embeds: DiscordEmbed[] = [
    {
      title: `Escalation from ${payload.agentName}`,
      description,
      color: COLORS.YELLOW,
      fields,
      footer: { text: "Paperclip Escalation" },
      timestamp: new Date().toISOString(),
    },
  ];

  const buttons: DiscordComponent[] = [];
  const cid = payload.companyId || "default";

  if (payload.suggestedReply) {
    buttons.push({
      type: 2,
      style: 3,
      label: "Use Suggested Reply",
      custom_id: `esc_suggest_${cid}_${payload.escalationId}`,
    });
  }

  buttons.push(
    { type: 2, style: 1, label: "Reply to Customer", custom_id: `esc_reply_${cid}_${payload.escalationId}` },
    { type: 2, style: 2, label: "Override Agent", custom_id: `esc_override_${cid}_${payload.escalationId}` },
    { type: 2, style: 4, label: "Dismiss", custom_id: `esc_dismiss_${cid}_${payload.escalationId}` },
  );

  const components: DiscordComponent[] = [{ type: 1, components: buttons }];
  return { embeds, components };
}

/**
 * Where one piece of inbound text is going.
 *
 * A thread key names the conversation the text belongs to and is what decides
 * the destination. `reply:<channelId>:<messageId>` is a typed reply to a message
 * this plugin posted; `voice:<guildId>:<channelId>:<sessionId>` is one join of
 * one voice channel. Adding a source means adding a thread-key form here, not a
 * second way into Paperclip.
 */
type InboundDestination = {
  entityId: string;
  entityType: string;
  companyId: string;
};

/**
 * What became of one piece of inbound text.
 *
 * `no-destination` and `rejected` are both "nothing was written to Paperclip",
 * but they mean different things to an operator: one is a configuration gap,
 * the other a destination that exists and refused.
 */
type InboundOutcome = "routed" | "empty" | "no-destination" | "rejected" | "stale";

/** State key holding what a text channel is currently about, for voice routing. */
function voiceTargetKey(channelId: string): string {
  return `voice_target_${channelId}`;
}

/** Trim a configured string to null when it carries nothing. */
function trimToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Thread key for a typed reply to a message this plugin posted. */
function replyThreadKey(channelId: string, messageId: string): string {
  return `reply:${channelId}:${messageId}`;
}

/**
 * Resolve a thread key to the Paperclip entity the text belongs to.
 *
 * Returns null when the key names nothing this install can route to — an
 * unmapped reply, or voice with no configured destination. Callers drop the
 * text rather than guessing.
 */
async function resolveInboundDestination(
  ctx: PluginContext,
  rt: DiscordRuntime,
  threadKey: string,
  input: { channelId: string | null },
): Promise<InboundDestination | null> {
  if (threadKey.startsWith("reply:")) {
    const [, channelId, messageId] = threadKey.split(":");
    if (!channelId || !messageId) return null;
    const mapping = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${channelId}_${messageId}`,
    })) as InboundDestination | null;
    return mapping ?? null;
  }

  if (threadKey.startsWith("voice:")) {
    // A spoken utterance is not a reply to anything, so it has no message
    // mapping to inherit. Two destinations, in order.
    //
    // First: what the transcript's own channel is currently about — the pointer
    // `notify()` refreshes every time it posts there.
    //
    // KNOWN PHASE-1 PROPERTY: that pointer is last-notification-wins. It follows
    // the most recent thing the plugin announced in the channel, not the thing
    // the room is talking about, so a notification arriving mid-conversation
    // moves where the next utterance lands. Phase 1 accepts this; a real
    // conversation-scoped target needs state voice does not have yet.
    if (input.channelId) {
      const pointer = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: voiceTargetKey(input.channelId),
      })) as InboundDestination | null;
      // Ownership can move between the write and the read (see `claimOwnership`).
      // A pointer written for a company this install no longer serves must never
      // route anything: dropping to the configured default is the safe direction,
      // commenting under the wrong company is not.
      if (pointer?.entityId && pointer.companyId === rt.companyId) {
        return pointer;
      }
      if (pointer?.entityId) {
        ctx.logger.info(
          "voice: ignoring a channel target left by a previous owner of this install",
          { runningCompanyId: rt.companyId, pointerCompanyId: pointer.companyId },
        );
      }
    }

    // Then: the destination the operator configured, under the company that owns
    // this install — never a company read from anywhere else (see "Runtime state").
    const entityId = trimToNull(process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID);
    if (!entityId) return null;
    return { entityId, entityType: "issue", companyId: rt.companyId };
  }

  return null;
}

/**
 * The single inbound ingress: every route by which text from Discord reaches
 * Paperclip goes through here.
 *
 * Both callers — the gateway's MESSAGE_CREATE router and the voice client —
 * arrive with an already-decided destination and an author string. Voice calls
 * this DIRECTLY. It does not post a message and hope the router picks it back
 * up: its webhook transcript is display only, so there is no path by which
 * anything this plugin writes to Discord can be read back in as input. That is
 * what makes a transcript loop impossible by construction, and it is why the
 * router below can keep refusing bot authors and non-replies unconditionally —
 * no webhook, and no bot, is ever a trusted message source.
 */
async function ingestInbound(
  ctx: PluginContext,
  rt: DiscordRuntime,
  input: {
    channelId: string | null;
    /** Attributed author, in the `discord:...` form Paperclip stores. */
    author: string;
    /**
     * Author as the escalation-resolved event has always reported it: the bare
     * Discord username for a typed reply. Kept distinct from `author` so this
     * refactor does not change an event payload other systems already read.
     */
    authorLabel: string;
    text: string;
    threadKey: string;
    /**
     * Whether the caller still has standing to write, asked again immediately
     * before each side effect.
     *
     * Voice supplies this; the typed router does not, because a gateway message
     * is handled synchronously with respect to ownership — there is no window in
     * which it can go stale. Voice's is a long story: an utterance is
     * transcribed, then a webhook is resolved, then a destination pointer is
     * read, and ownership of the install can move at any of those awaits. The
     * predicate is what makes "still ours?" true at the instant of the write
     * rather than at some earlier instant that has since passed.
     */
    isLive?: () => boolean;
  },
): Promise<InboundOutcome> {
  const text = input.text.trim();
  if (!text) return "empty";
  const isLive = input.isLive ?? (() => true);

  const mapping = await resolveInboundDestination(ctx, rt, input.threadKey, input);
  if (!mapping) return "no-destination";
  // Destination resolution reads the channel pointer, and a retirement can
  // interleave with that read.
  if (!isLive()) return "stale";

  if (mapping.entityType === "escalation") {
    // Route to escalation response
    const escalationCompanyId = mapping.companyId || "default";
    let record = await ctx.state.get({
      scopeKind: "company",
      scopeId: escalationCompanyId,
      stateKey: `escalation_${mapping.entityId}`,
    }) as EscalationRecord | null;
    // Backward-compat fallback: check "default" scope if company-scoped read returns null
    if (!record && escalationCompanyId !== "default") {
      record = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: `escalation_${mapping.entityId}`,
      }) as EscalationRecord | null;
    }

    // Two state reads happened above; nothing has been written yet.
    if (!isLive()) return "stale";

    if (record && record.status === "pending") {
      record.status = "resolved";
      record.resolvedAt = new Date().toISOString();
      record.resolvedBy = input.author;
      record.resolution = "human_reply";
      await ctx.state.set(
        { scopeKind: "company", scopeId: escalationCompanyId, stateKey: `escalation_${mapping.entityId}` },
        record,
      );
      await ctx.metrics.write(METRIC_NAMES.escalationsResolved, 1);
      ctx.events.emit("escalation-resolved", mapping.companyId, {
        escalationId: mapping.entityId,
        action: "human_reply",
        resolvedBy: input.authorLabel,
        responseText: text,
      });
    }

    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    ctx.logger.info("Routed inbound Discord text to escalation", {
      escalationId: mapping.entityId,
      from: input.author,
      threadKey: input.threadKey,
    });
    return "routed";
  }

  if (mapping.entityType === "issue") {
    if (!isLive()) return "stale";
    // Route to issue comment
    try {
      await paperclipFetch(
        `${rt.baseUrl}/api/issues/${mapping.entityId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: text,
            authorUserId: input.author,
          }),
        },
        rt.paperclipBoardApiKey,
      );
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed inbound Discord text to issue comment", {
        issueId: mapping.entityId,
        from: input.author,
        threadKey: input.threadKey,
      });
      return "routed";
    } catch (err) {
      // A destination that Paperclip rejects — the issue was deleted, it belongs
      // to another company — must not take the pipeline down with it. The text
      // is lost for this utterance and the transcript still shows in the channel.
      ctx.logger.error("Failed to route inbound message", {
        entityId: mapping.entityId,
        threadKey: input.threadKey,
        error: summarizeError(err, [rt.paperclipBoardApiKey]),
      });
      return "rejected";
    }
  }

  return "no-destination";
}

/**
 * Reply routing for inbound Discord messages.
 *
 * The trust boundary is here and is unchanged: a bot author is refused, and a
 * message that is not a reply to something this plugin posted is refused. Voice
 * does not relax either rule — it does not come through this function at all.
 */
async function handleMessageCreate(
  ctx: PluginContext,
  rt: DiscordRuntime,
  message: MessageCreateEvent,
): Promise<void> {
  if (rt.config.enableInbound === false) return;
  // Ignore bot messages
  if (message.author.bot) return;
  // Only handle replies to other messages
  if (!message.message_reference?.message_id) return;

  const refChannelId = message.message_reference.channel_id ?? message.channel_id;
  const refMessageId = message.message_reference.message_id;

  await ingestInbound(ctx, rt, {
    channelId: message.channel_id,
    author: `discord:${message.author.username}`,
    authorLabel: message.author.username,
    text: message.content ?? "",
    threadKey: replyThreadKey(refChannelId, refMessageId),
  });
}

// ---------------------------------------------------------------------------
// Runtime bootstrap
// ---------------------------------------------------------------------------

/**
 * Start (or refresh) the runtime for one company from its stored config.
 *
 * Idempotent by contract:
 * - same company, same bot token, live gateway → refresh config in place and keep
 *   the Discord connection (no reconnect storm on every settings save);
 * - same company, rotated token or a gateway that failed permanently → tear the
 *   connection down and reconnect;
 * - a different company while one is already running → log and keep the running
 *   one (single-tenant; see "Runtime state").
 *
 * Never throws: every failure path degrades health and returns null.
 */
/**
 * Close and forget the current runtime.
 *
 * Used when ownership moves: the previous company's Discord connection must not
 * outlive its ownership, least of all while the new owner's bootstrap is still
 * fallible.
 */
/**
 * Stop the runtime's voice client, if any. Never throws: voice tear-down runs on
 * paths (retire, reconnect, shutdown) whose real work must proceed regardless.
 *
 * `disposition` says what to do with the stopped session:
 *
 * - `"tombstone"` leaves it attached, inactive, so the session that replaces it
 *   can inherit what it learned. Voice going down with its socket says nothing
 *   about whether utterances had anywhere to go, and a token rotation that
 *   silently restored `ok` would hide a destination that is still missing.
 * - `"discard"` detaches it, for teardown with nothing to hand on to: the
 *   plugin is stopping, or the runtime itself is being retired.
 *
 * Either way the session is invalidated first, so work already in flight — a
 * transcription, a webhook lookup — finds `active` false when it settles.
 */
function stopVoice(
  ctx: PluginContext,
  rt: DiscordRuntime,
  reason: string,
  disposition: "tombstone" | "discard" = "tombstone",
): void {
  const session = rt.voice;
  if (!session) return;
  session.active = false;
  rt.voice = disposition === "tombstone" ? session : null;
  const stop = session.stopClient;
  session.stopClient = null;
  if (!stop) return;
  try {
    stop();
    ctx.logger.info("voice: stopped", { reason });
  } catch (err) {
    ctx.logger.warn("voice: stop failed", { reason, error: summarizeError(err) });
  }
}

function retireRuntime(ctx: PluginContext, reason: string): void {
  const previous = runtime;
  runtime = null;
  if (!previous) return;
  ctx.logger.info("Discord plugin retiring the previous company's runtime", {
    companyId: previous.companyId,
    reason,
  });
  stopVoice(ctx, previous, reason, "discard");
  if (previous.gateway) {
    try {
      previous.gateway.close();
    } catch (err) {
      ctx.logger.debug("Closing the retired Discord gateway failed", { error: summarizeError(err) });
    }
  }
}

/** Stable JSON, so two configurations compare equal regardless of key order. */
function stableConfigJson(config: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(config));
}

/**
 * The single ownership gate. Every bootstrap source goes through it.
 *
 * The first company whose configuration reaches this worker claims it. Claiming
 * does not require the runtime to start — an owner whose bot token stopped
 * resolving stays the owner, so a later company cannot take the install over
 * while the real owner is broken.
 *
 * One exception, mirroring the host exactly: the SDK's single-tenant guard
 * ACCEPTS an identical configuration under a different company and advances its
 * recorded company to that one (`worker-rpc-host.ts`). That is deployed state,
 * not a malformed row — migration 0164 duplicated each unbound legacy plugin
 * config unchanged across every company. Refusing it here would leave the plugin
 * owning A while the SDK owns B, which is precisely the split this gate exists to
 * prevent, so an equal-config delivery advances the owner too.
 */
function claimOwnership(ctx: PluginContext, companyId: string, config: unknown): boolean {
  const configJson = stableConfigJson(config);

  if (!ownerCompanyId) {
    ownerCompanyId = companyId;
    ownerConfigJson = configJson;
    return true;
  }

  if (ownerCompanyId === companyId) {
    ownerConfigJson = configJson;
    return true;
  }

  if (ownerConfigJson !== null && ownerConfigJson === configJson) {
    ctx.logger.info(
      `Discord plugin owner advancing from company ${ownerCompanyId} to ${companyId}: identical configuration, ` +
        "matching the host's single-tenant rule",
      { previousCompanyId: ownerCompanyId, companyId },
    );
    // Retire the outgoing owner FIRST. Everything after this point can fail —
    // the new owner may not even have a secret binding — and a live connection
    // belonging to a company that no longer owns the install is worse than none.
    retireRuntime(ctx, `owner advanced to company ${companyId}`);
    ownerCompanyId = companyId;
    ownerConfigJson = configJson;
    refusedCompanies.delete(companyId);
    return true;
  }

  if (!refusedCompanies.has(companyId)) {
    refusedCompanies.add(companyId);
    ctx.logger.warn(
      `Discord plugin ignoring configuration for company ${companyId}; this install serves ${ownerCompanyId}`,
      { runningCompanyId: ownerCompanyId, deliveredCompanyId: companyId },
    );
  }
  return false;
}

/**
 * Apply one company's stored configuration to the runtime.
 *
 * Callers MUST go through `queueBootstrap` — every bootstrap source shares one
 * ordered critical section, because nothing serializes host->worker requests:
 * the SDK's RPC reader dispatches each call without awaiting the previous one
 * (packages/plugins/sdk/src/worker-rpc-host.ts). Two config saves arriving while
 * a token resolution is pending would otherwise both reach `connectGateway` and
 * leak a live connection.
 *
 * Idempotent by contract:
 * - same company, same bot token, live gateway with the same intents → refresh
 *   the EXISTING runtime object in place and keep the Discord connection. The
 *   object identity matters: the gateway's callbacks were created once, at
 *   connect time, and read the runtime they were given;
 * - same company, rotated token, changed message intents, or a gateway that
 *   failed permanently → tear the connection down and reconnect;
 * - a different company while one is already running → log and keep the running
 *   one (single-tenant; see "Runtime state").
 *
 * Never throws: every failure path degrades health and returns null.
 */
async function bootstrapRuntime(
  ctx: PluginContext,
  companyId: string,
  rawConfig: unknown,
): Promise<DiscordRuntime | null> {
  if (!claimOwnership(ctx, companyId, rawConfig)) return runtime;
  const existing = runtime;

  const config = {
    ...DEFAULT_CONFIG,
    ...(rawConfig as Record<string, unknown>),
  } as DiscordConfig;

  // Required config is reported through health, never thrown: throwing here would
  // kill worker activation on a host that simply has not delivered config yet.
  // `onValidateConfig` is what fails a bad save loudly in the settings UI.
  if (!isUsableSecretRef(config.discordBotTokenRef)) {
    // Never quote the supplied value: an operator can paste the raw bot token
    // into this field and the host will persist it (its Ajv secret-ref format
    // accepts any string; the extractor rejects only UUID-shaped ones).
    degradeHealth(
      `[${PLUGIN_ID}] ${describeUnusableSecretRef("discordBotTokenRef")}`,
      "discord-bot-token-missing",
      { companyId },
    );
    ctx.logger.warn("Discord plugin config has no resolvable bot token reference", { companyId });
    return null;
  }

  const defaultChannelId = normalizeDiscordId(config.defaultChannelId) ?? "";
  if (!defaultChannelId) {
    degradeHealth(
      `[${PLUGIN_ID}] defaultChannelId is missing or empty; set the default Discord channel ID in plugin settings`,
      "discord-default-channel-missing",
      { companyId },
    );
    ctx.logger.warn("Discord plugin config has no default channel", { companyId });
    return null;
  }

  const token = await resolveStartupDiscordBotToken(
    ctx,
    config.discordBotTokenRef,
    setRuntimeHealth,
    { companyId, configPath: "discordBotTokenRef" },
  );
  if (!token) {
    ctx.logger.warn("Discord plugin runtime disabled because bot token could not be resolved", {
      companyId,
    });
    return null;
  }

  let paperclipBoardApiKey = "";
  const boardApiKeyBinding = toSecretRefBinding(config.paperclipBoardApiKeyRef);
  if (boardApiKeyBinding) {
    try {
      paperclipBoardApiKey = await ctx.secrets.resolve(boardApiKeyBinding, {
        companyId,
        configPath: "paperclipBoardApiKeyRef",
      });
    } catch (err) {
      ctx.logger.warn("Discord plugin could not resolve Paperclip board API key; board features are disabled", {
        error: summarizeError(err, [config.paperclipBoardApiKeyRef, boardApiKeyBinding.secretId]),
        companyId,
      });
    }
  } else if (config.paperclipBoardApiKeyRef) {
    ctx.logger.warn(`Discord plugin ignoring paperclipBoardApiKeyRef: ${describeUnusableSecretRef("paperclipBoardApiKeyRef")}`, {
      companyId,
    });
  }

  const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
  const defaultGuildId = normalizeDiscordId(config.defaultGuildId);
  const listenForMessages = gatewayNeedsMessages(config);
  const voiceEnv = readVoiceEnv();
  const voiceEnabled = voiceEnv !== null;

  // Reuse the live connection only when nothing it identified with has changed.
  // Intents are fixed when the socket identifies (src/gateway.ts), so a change to
  // any message-requiring feature needs a new connection, in either direction.
  const reuseGateway = Boolean(
    existing &&
      existing.gateway &&
      !existing.gatewayFailed &&
      existing.token === token &&
      existing.listenForMessages === listenForMessages &&
      existing.voiceEnabled === voiceEnabled,
  );

  // Refresh the EXISTING object rather than replacing it, so a reused gateway's
  // callbacks observe the new configuration immediately.
  const rt: DiscordRuntime = existing ?? ({} as DiscordRuntime);
  rt.companyId = companyId;
  rt.config = config;
  rt.token = token;
  rt.tokenSecretId = normalizeSecretRefId(config.discordBotTokenRef) ?? "";
  rt.paperclipBoardApiKey = paperclipBoardApiKey;
  rt.baseUrl = baseUrl;
  rt.cmdCtx = {
    baseUrl,
    companyId,
    token,
    paperclipBoardApiKey,
    defaultChannelId,
    pluginCtx: ctx,
  };
  rt.adapter = new DiscordAdapter(ctx, token);
  rt.defaultGuildId = defaultGuildId;
  rt.defaultChannelId = defaultChannelId;
  rt.approvalsChannelId = normalizeDiscordId(config.approvalsChannelId);
  rt.errorsChannelId = normalizeDiscordId(config.errorsChannelId);
  rt.bdPipelineChannelId = normalizeDiscordId(config.bdPipelineChannelId);
  rt.escalationChannelId = normalizeDiscordId(config.escalationChannelId) ?? defaultChannelId;
  rt.intelligenceChannelIds = normalizeDiscordIdList(config.intelligenceChannelIds);
  rt.retentionDays = config.intelligenceRetentionDays || 30;
  rt.escalationTimeoutMs = (config.escalationTimeoutMinutes || 30) * 60 * 1000;
  rt.digestMode = config.digestMode ?? "off";
  rt.listenForMessages = listenForMessages;
  rt.voiceEnabled = voiceEnabled;
  rt.voice = rt.voice ?? null;

  if (!reuseGateway) {
    // Voice rides this socket's adapter; it cannot outlive the connection it
    // subscribed to, so it goes down with the gateway it was started on.
    if (existing) stopVoice(ctx, existing, "gateway replaced");
    const staleGateway = rt.gateway;
    rt.gateway = null;
    rt.gatewayFailed = false;
    if (staleGateway) {
      try {
        staleGateway.close();
      } catch (err) {
        ctx.logger.debug("Closing the previous Discord gateway failed", { error: summarizeError(err) });
      }
    }
  }

  // Publish before the network work: gateway callbacks read the module runtime.
  runtime = rt;

  if (defaultGuildId) {
    try {
      const appId = await getApplicationId(ctx, token);
      if (appId) {
        const registered = await registerSlashCommands(ctx, token, appId, defaultGuildId, SLASH_COMMANDS);
        if (registered) {
          ctx.logger.info("Slash commands registered with Discord");
        }
      }
    } catch (err) {
      ctx.logger.warn("Discord slash command registration failed", { error: summarizeError(err, [token]) });
    }
  }

  if (!reuseGateway) {
    try {
      rt.gateway = await rootAsyncScope.runInAsyncScope(() => connectGateway(
        ctx,
        token,
        // Every callback reads the CURRENT runtime rather than closing over the
        // one that existed at connect time — a reused connection must never keep
        // serving a superseded configuration.
        async (interaction) => {
          const current = runtime;
          if (!current) {
            return respondToInteraction({
              type: 4,
              content: "Plugin is still starting up. Please try again in a moment.",
              ephemeral: true,
            });
          }
          return handleInteraction(ctx, interaction as any, current.cmdCtx);
        },
        listenForMessages
          ? async (message) => {
              const current = runtime;
              if (current) await handleMessageCreate(ctx, current, message);
            }
          : undefined,
        {
          listenForMessages,
          includeMessageContent: listenForMessages,
          enableVoice: voiceEnabled,
          // Fatal close codes and identify-budget exhaustion stop the gateway
          // permanently; report it through plugin health instead of running
          // silently without realtime Discord connectivity.
          onPermanentFailure: (message, details) => {
            if (runtime) {
              runtime.gatewayFailed = true;
              // Voice signals over this socket; once it is permanently down the
              // voice connection can neither rejoin nor be torn down cleanly later.
              stopVoice(ctx, runtime, "gateway permanently down");
            }
            runtimeHealth = { status: "degraded", message, details };
          },
        },
      ));
    } catch (err) {
      const error = summarizeError(err, [token]);
      rt.gatewayFailed = true;
      degradeHealth(`Discord gateway connection failed: ${error}`, "discord-gateway-unavailable", {
        companyId,
      });
      ctx.logger.error("Discord gateway connection failed", { error, companyId });
      // Notifications, jobs and tools still work over REST — keep the runtime.
      return rt;
    }
  }

  if (runtimeHealth.status !== "ok") {
    setRuntimeHealth({ status: "ok" });
  }

  await startVoiceIfConfigured(ctx, rt, voiceEnv);
  // The reset above cleared health wholesale. Voice's own notes are not the
  // reset's to discard: a destination that was missing a moment ago is still
  // missing, and a configuration save is no evidence otherwise.
  refreshVoiceHealth(rt);

  ctx.logger.info("Discord plugin runtime started", {
    companyId,
    gateway: rt.gateway ? "connected" : "unavailable",
    reusedConnection: reuseGateway,
  });

  startBackfillIfEnabled(ctx, rt);
  return rt;
}

/** How long a failed webhook lookup is left alone before it is tried again. */
const VOICE_WEBHOOK_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The text channel a voice webhook posts into.
 *
 * Discord's webhook object carries `channel_id`; the URL does not. Voice needs
 * it to find what that channel is currently about, so it has to be asked for.
 *
 * SINGLE-FLIGHT: at most one lookup is ever in flight for a session, and every
 * concurrent caller shares its result. Several people speaking at once finish
 * their utterances at once, and without this each of them would issue its own
 * credential-bearing GET for the same value. A success is cached for the life of
 * the session; a failure is retried, but not before the cooldown, because a
 * webhook that is failing is usually revoked or deleted rather than briefly
 * unwell, and utterances arrive every few seconds while someone is speaking.
 *
 * Every failure path returns null, which costs nothing worse than falling back
 * to the configured default destination.
 *
 * The URL is a credential — it authorizes posting to the channel — so it is
 * never logged, not even on failure.
 */
async function resolveVoiceTextChannelId(
  ctx: PluginContext,
  session: VoiceSession,
  webhookUrl: string,
): Promise<string | null> {
  const state = session.textChannel;
  if (state.channelId) return state.channelId;
  if (state.inFlight) return state.inFlight;
  if (Date.now() < state.retryAfter) return null;

  // Deliberately cannot reject: concurrent callers share this promise, and one
  // rejection would surface as an unhandled rejection in every one of them.
  const lookup = (async (): Promise<string | null> => {
    try {
      const response = await fetch(webhookUrl, { method: "GET" });
      if (!response.ok) throw new Error(`webhook lookup returned ${response.status}`);
      const webhook = (await response.json()) as { channel_id?: unknown };
      const channelId = normalizeDiscordId(webhook.channel_id);
      if (!channelId) throw new Error("webhook carries no channel id");
      state.channelId = channelId;
      return channelId;
    } catch (err) {
      // Armed inside, so every caller sharing this promise leaves with the
      // cooldown already in place rather than racing to start another attempt.
      state.retryAfter = Date.now() + VOICE_WEBHOOK_RETRY_COOLDOWN_MS;
      if (!state.logged) {
        state.logged = true;
        ctx.logger.warn(
          "voice: could not resolve the transcript channel from its webhook; " +
            "utterances will use the configured default destination",
          { error: summarizeError(err, [webhookUrl]) },
        );
      }
      return null;
    }
  })();

  state.inFlight = lookup;
  try {
    return await lookup;
  } finally {
    state.inFlight = null;
  }
}

/** Health issue code for voice that cannot connect. */
const VOICE_UNAVAILABLE_ISSUE = "discord-voice-unavailable";
/** Health issue code for voice that runs but has nowhere to send what it hears. */
const VOICE_DISPLAY_ONLY_ISSUE = "discord-voice-display-only";

/**
 * Recompute plugin health from the session's two voice concerns.
 *
 * Connectivity and routing are independent and neither is evidence about the
 * other: a voice client that just reconnected still has nowhere to send what it
 * hears if nothing configured a destination, and a perfectly routed install can
 * lose its connection. They are therefore tracked separately and only ever
 * cleared by something that actually proves the concern is resolved — a
 * connection coming up for connectivity, an utterance actually reaching
 * Paperclip for routing.
 *
 * A non-voice degradation always outranks both: an unresolvable bot token is a
 * bigger problem than voice, and voice must never overwrite it or clear it.
 */
function refreshVoiceHealth(rt: DiscordRuntime): void {
  const issue = (runtimeHealth.details as { issue?: unknown } | undefined)?.issue;
  const currentIsVoice =
    issue === VOICE_UNAVAILABLE_ISSUE || issue === VOICE_DISPLAY_ONLY_ISSUE;
  if (runtimeHealth.status !== "ok" && !currentIsVoice) return;

  const session = rt.voice;
  // Connectivity first: with no connection there is nothing to route.
  if (session?.connectivityNote) {
    degradeHealth(
      `[${PLUGIN_ID}] voice is unavailable: ${session.connectivityNote}`,
      VOICE_UNAVAILABLE_ISSUE,
      { companyId: rt.companyId },
    );
    return;
  }
  if (session?.routingNote) {
    degradeHealth(
      `[${PLUGIN_ID}] voice transcripts display-only: ${session.routingNote}`,
      VOICE_DISPLAY_ONLY_ISSUE,
      { companyId: rt.companyId },
    );
    return;
  }
  if (currentIsVoice) setRuntimeHealth({ status: "ok" });
}

/**
 * Surface what happened to a spoken utterance through plugin health.
 *
 * An operator who wired voice expects what is said in the channel to reach
 * Paperclip. When it does not, "ok" is the wrong answer — but so is a hard
 * failure: the transcript still posts, the room still has its record, and text
 * routing is untouched. Degraded, with a value-free note, is the honest state.
 *
 * Only a successfully routed utterance clears this. Nothing else can: neither a
 * reconnection nor a configuration save is evidence that a destination exists.
 */
function reportVoiceIngestOutcome(
  ctx: PluginContext,
  session: VoiceSession,
  outcome: InboundOutcome,
): void {
  // "stale" means the caller lost standing mid-flight: it wrote nothing, and it
  // has nothing to say about the health of whoever owns the install now.
  if (outcome === "empty" || outcome === "stale") return;
  session.routingNote =
    outcome === "routed"
      ? null
      : outcome === "no-destination"
        ? "no destination configured"
        : "the destination rejected the comment";
  if (outcome !== "routed") {
    ctx.logger.info("voice: transcript posted to the channel but not ingested", { outcome });
  }
  refreshVoiceHealth(session.runtime);
}

/**
 * The install command every "voice deps are missing" log line ends with.
 *
 * Duplicated from `src/voice/client.ts` on purpose: importing it from there
 * would be a static import of the module whose entire point is to load lazily.
 */
const VOICE_DEPS_INSTALL_HINT =
  "npm install @discordjs/voice prism-media opusscript@0.0.8 libsodium-wrappers ws";

/**
 * Start the voice client for this runtime, if voice is configured.
 *
 * Voice is optional in the strongest sense: its peer dependencies may not be
 * installed at all, so the whole subsystem sits behind one dynamic import that
 * is never reached when the environment does not ask for voice. Nothing in here
 * may propagate — a plugin whose text routing works must keep working when voice
 * does not.
 *
 * Everything this creates is bound to ONE session object owned by `rt`. The
 * callbacks below close over that session and over `rt`, and never read the
 * module-level runtime: by the time an utterance finishes, the install may
 * belong to a different company.
 */
async function startVoiceIfConfigured(
  ctx: PluginContext,
  rt: DiscordRuntime,
  voiceEnv: ReturnType<typeof readVoiceEnv>,
): Promise<void> {
  if (!voiceEnv) {
    ctx.logger.info(
      "voice: disabled — set DISCORD_VOICE_GUILD_ID, DISCORD_VOICE_CHANNEL_ID, " +
        "DISCORD_VOICE_WEBHOOK_URL and DEEPGRAM_API_KEY to enable it",
    );
    return;
  }
  // A live session owns this runtime's voice; a stopped one is only still here
  // to carry the health note explaining why, and a new attempt replaces it.
  if (rt.voice?.active) return;

  const session: VoiceSession = {
    runtime: rt,
    active: true,
    stopClient: null,
    connectivityNote: null,
    // A destination problem outlives a restart — nothing about starting the
    // client again proves an utterance now has somewhere to go.
    routingNote: rt.voice?.routingNote ?? null,
    textChannel: { channelId: null, inFlight: null, retryAfter: 0, logged: false },
  };
  rt.voice = session;

  const gatewayVoice = rt.gateway?.voice;
  if (!gatewayVoice) {
    // The operator configured voice and the gateway came back with no voice
    // surface at all — no gateway URL, or the connection was never established.
    // Voice cannot arm, and saying nothing here is what let health read `ok`
    // while explicitly configured voice was silently absent.
    session.connectivityNote = "the Discord gateway is not connected";
    ctx.logger.warn(
      "voice: configured, but the gateway exposes no voice surface — continuing without voice",
    );
    refreshVoiceHealth(rt);
    return;
  }

  /**
   * Does work that started under this session still count?
   *
   * Both halves matter. `active` catches a session that was stopped. The runtime
   * identity check catches ownership advancing to another company: same-owner
   * redelivery refreshes the existing runtime object in place, so it still
   * matches, while an advancement builds a new one and this fails.
   */
  const stillOurs = (): boolean => session.active && runtime === rt;

  try {
    const { VoiceClient, createPluginDiscordAdapter } = await import("./voice/index.js");

    // Loading the voice module is an await like any other, and a permanent
    // gateway failure or plugin shutdown can tear this session down while it is
    // pending. Constructing a client now would arm one that nothing can reach:
    // its stop closure would be installed on a session already detached, so no
    // later teardown could find it.
    if (!stillOurs()) {
      ctx.logger.info("voice: startup abandoned — the session was stopped while loading", {
        companyId: rt.companyId,
      });
      return;
    }

    const voiceClient = new VoiceClient(ctx, {
      guildId: voiceEnv.guildId,
      voiceChannelId: voiceEnv.voiceChannelId,
      textChannelWebhookUrl: voiceEnv.webhookUrl,
      deepgramApiKey: voiceEnv.deepgramApiKey,
      relayUsername: voiceEnv.relayUsername,
      voiceAdapterCreator: createPluginDiscordAdapter(gatewayVoice),
      // Joining is driven by the gateway's own READY/RESUMED boundary, never by
      // this call returning: an op-4 sent before the socket has identified is
      // not deliverable, and @discordjs/voice does not retry one it could not send.
      onGatewayReady: (handler) => gatewayVoice.onGatewayReady(handler),
      // Voice reaches Paperclip HERE, through the same ingress as a typed reply.
      // The webhook transcript is display only.
      ingestUtterance: async (utterance) => {
        // The channel voice routes by is the one the transcript appears in, not
        // the voice channel it was spoken in: that is where notifications land,
        // and so it is the only one that has a target to inherit.
        const channelId = await resolveVoiceTextChannelId(ctx, session, voiceEnv.webhookUrl);

        // Checked after every await and immediately before the write. An
        // utterance that outlived its owner must not be filed under whoever
        // owns the install now — it would be spoken content from one company
        // posted with another company's credentials — and it must not touch the
        // successor's health either, since it says nothing about the successor.
        if (!stillOurs()) {
          ctx.logger.info(
            "voice: dropping an utterance whose runtime is no longer current",
            { companyId: rt.companyId },
          );
          return;
        }

        const ingested = await ingestInbound(ctx, rt, {
          channelId,
          author: `discord:voice:${utterance.userId}`,
          authorLabel: `voice:${utterance.userId}`,
          text: utterance.text,
          threadKey: utterance.threadKey,
          // Carried INTO the ingress: the destination read is another await, and
          // a check out here cannot speak for what is true on the far side of it.
          isLive: stillOurs,
        });
        if (!stillOurs()) return;
        reportVoiceIngestOutcome(ctx, session, ingested);
      },
      onAvailabilityChange: (available, reason) => {
        if (!stillOurs()) return;
        // Connectivity ONLY. A connection coming up is no evidence that an
        // utterance has anywhere to go, so it never clears the routing note.
        session.connectivityNote = available
          ? null
          : // `reason` is one of a fixed set of phrases (see VoiceUnavailableReason):
            // nothing a failure was holding — a URL, a key — can reach health here.
            (reason ?? "reason not reported");
        refreshVoiceHealth(rt);
      },
    });
    // Retained BEFORE start() is awaited: a client that fails after construction
    // still has a connection and gateway subscriptions that must be released.
    session.stopClient = () => voiceClient.stop();
    await voiceClient.start();
  } catch (error) {
    stopVoice(ctx, rt, "voice startup failed", "tombstone");
    const missingDeps =
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
    ctx.logger.error(
      missingDeps
        ? "voice: optional voice dependencies are not installed — continuing without voice. " +
            `Install them with: ${VOICE_DEPS_INSTALL_HINT}`
        : "voice: startup failed (continuing without voice)",
      { error: summarizeError(error) },
    );
    // The operator explicitly configured voice; saying "ok" while it is dead is
    // the failure mode that hides this from them entirely. The tombstone left by
    // stopVoice is what carries the reason until something replaces it.
    session.connectivityNote = missingDeps
      ? "the optional voice dependencies are not installed"
      : "it could not be started";
    refreshVoiceHealth(rt);
  }
}

/**
 * Voice is configured from the environment, not from company config.
 *
 * Phase 1 deliberately keeps voice off the settings surface: the operator wires
 * the four variables on the container, and an install that sets none of them
 * behaves exactly as it did before voice existed. Returns null unless all four
 * required variables are present, so a half-configured voice never half-starts.
 */
function readVoiceEnv(): {
  guildId: string;
  voiceChannelId: string;
  webhookUrl: string;
  deepgramApiKey: string;
  relayUsername: string | undefined;
} | null {
  const guildId = process.env.DISCORD_VOICE_GUILD_ID;
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  const webhookUrl = process.env.DISCORD_VOICE_WEBHOOK_URL;
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (!guildId || !voiceChannelId || !webhookUrl || !deepgramApiKey) return null;
  return {
    guildId,
    voiceChannelId,
    webhookUrl,
    deepgramApiKey,
    relayUsername: process.env.DISCORD_VOICE_USERNAME,
  };
}

/** Whether this configuration needs the message-carrying gateway intents. */
function gatewayNeedsMessages(config: DiscordConfig): boolean {
  return (
    config.enableInbound !== false ||
    config.enableMediaPipeline === true ||
    config.enableCustomCommands === true ||
    config.enableProactiveSuggestions === true ||
    config.enableIntelligence === true
  );
}

/** First-install historical intelligence backfill, fire-and-forget. */
function startBackfillIfEnabled(ctx: PluginContext, rt: DiscordRuntime): void {
  if (!rt.config.enableIntelligence || rt.intelligenceChannelIds.length === 0 || !rt.defaultGuildId) {
    return;
  }
  if (rt.backfillStarted) return;
  rt.backfillStarted = true;
  void (async () => {
    const cid = rt.companyId;
    const existing = await ctx.state.get({
      scopeKind: "company",
      scopeId: cid,
      stateKey: "discord_intelligence",
    }) as { backfillComplete?: boolean } | null;

    if (!existing?.backfillComplete) {
      ctx.logger.info("First install detected, starting historical backfill");
      await runBackfill(
        ctx,
        rt.token,
        rt.defaultGuildId!,
        rt.intelligenceChannelIds,
        cid,
        rt.config.backfillDays ?? 90,
      );
    }
  })().catch((err) => ctx.logger.warn("Backfill failed", { error: summarizeError(err, [rt.token]) }));
}

/**
 * Read one company's stored config with an explicit scope.
 *
 * On a 2026.720/722 host this doubles as a scope probe: the host enforces the
 * invocation's company, so a read for any other company is denied.
 */
async function readScopedConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const rawConfig = await ctx.config.get(companyId);
    return (rawConfig as Record<string, unknown>) ?? null;
  } catch (err) {
    lastScopedConfigError = summarizeError(err);
    ctx.logger.debug("Company-scoped plugin config is not readable", {
      companyId,
      error: lastScopedConfigError,
    });
    return null;
  }
}

/**
 * Identify which company a context-less config delivery belongs to.
 *
 * The v2026.720.0 and v2026.722.0 SDKs call `onConfigChanged(config)` with no
 * scope, but the host still binds the invocation to the real company and denies
 * a request for any other one. Probing each company inside this invocation
 * therefore identifies the delivered scope: only the right company answers.
 * Guessing `companies[0]` instead gets the request denied as a scope mismatch
 * whenever the configured company is not first in the list. Assuming the running
 * company is just as unfounded: a delivery for a DIFFERENT company arrives the
 * same way, and treating it as the running one attempts a resolution the host
 * denies, degrading a perfectly healthy runtime.
 */
async function identifyDeliveredCompany(
  ctx: PluginContext,
  deliveredConfig: unknown,
): Promise<string | null> {
  // On the hosts where this path runs (2026.720/722), `companies.list` is filtered
  // to the invocation's own company, so this is a one-element list in practice;
  // the scoped probe below is what actually identifies the delivery.
  let companies: Array<{ id: string }>;
  try {
    companies = await ctx.companies.list();
  } catch (err) {
    ctx.logger.info("Could not list companies while attributing a configuration delivery", {
      error: summarizeError(err),
    });
    return null;
  }

  const readable: Array<{ id: string; config: Record<string, unknown> }> = [];
  for (const company of companies) {
    const config = await readScopedConfig(ctx, company.id);
    if (config) readable.push({ id: company.id, config });
  }

  if (readable.length === 0) return null;
  if (readable.length === 1) return readable[0].id;

  // A host that answers for several companies (>= 2026.817.0) is not telling us
  // which one was saved; match the delivered secret reference against the rows.
  const deliveredSecretId = normalizeSecretRefId(
    (deliveredConfig as Record<string, unknown> | null)?.discordBotTokenRef,
  );
  if (deliveredSecretId) {
    const match = readable.find(
      (row) => normalizeSecretRefId(row.config.discordBotTokenRef) === deliveredSecretId,
    );
    if (match) return match.id;
  }
  return readable[0].id;
}

/**
 * Run one bootstrap attempt inside the ordered critical section shared by every
 * configuration delivery — the only thing that bootstraps.
 */
function queueBootstrap<T>(work: () => Promise<T>): Promise<T> {
  const next = bootstrapQueue.then(work, work);
  bootstrapQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The runtime for a company-scoped invocation, or null.
 *
 * This never reads configuration and never bootstraps. Configuration deliveries
 * are the ONLY way a runtime starts (see "Runtime state"): an invocation cannot
 * establish ownership that agrees with the host, because `config.get` does not
 * move the SDK's recorded company. A runtime adopted from an invocation would
 * own an install the SDK still considers unowned, and on a fresh install it
 * would adopt an empty `{}` row while the SDK's owner stayed null.
 *
 * A company that is not the owner gets null, logged once. Callers must treat
 * null as "do nothing for this company".
 */
async function ensureRuntime(
  ctx: PluginContext | null,
  companyId?: string | null,
): Promise<DiscordRuntime | null> {
  if (companyId && ownerCompanyId && companyId !== ownerCompanyId) {
    const pluginCtx = ctx ?? _pluginCtx;
    if (pluginCtx && !refusedCompanies.has(companyId)) {
      refusedCompanies.add(companyId);
      pluginCtx.logger.warn(
        `Discord plugin ignoring an invocation for company ${companyId}; this install serves ${ownerCompanyId}`,
        { runningCompanyId: ownerCompanyId, invokingCompanyId: companyId },
      );
    }
    return null;
  }

  // No runtime means no configuration has been delivered yet: there is nothing
  // to serve, and nothing this invocation may safely adopt.
  if (!runtime) return null;
  if (companyId && companyId !== runtime.companyId) return null;
  return runtime;
}

const plugin = definePlugin({
  async setup(ctx) {
    _pluginCtx = ctx;

    // Handlers are registered unconditionally.
    //
    // The feature flags that used to gate these registrations live in company-
    // scoped config, which is unreadable here (see "Runtime state"), and the SDK
    // requires every registration to complete synchronously within setup().
    // Each handler therefore starts by resolving the runtime and checking its own
    // flag against the live config, and no-ops until the runtime exists.

    ctx.events.on("plugin.stopping", async () => {
      if (runtime) stopVoice(ctx, runtime, "plugin stopping", "discard");
      runtime?.gateway?.close();
    });

    // --- ACP bridge: listen for cross-plugin ACP output events ---
    ctx.events.on(`${ACP_PLUGIN_EVENT_PREFIX}.output`, async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      const payload = event.payload as {
        sessionId: string;
        threadId: string;
        agentName: string;
        output: string;
        status?: "running" | "completed" | "failed";
      };
      await handleAcpOutput(ctx, rt.token, payload);
    });

    // --- Event subscriptions ---

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnIssueCreated) return;
      const payload = await enrichIssueNotificationPayload(ctx, event);
      await notify(ctx, rt, { ...event, payload }, formatIssueCreated);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnIssueDone) return;
      const payload = await enrichIssueNotificationPayload(ctx, event);
      if (payload.status !== "done") return;

      const completionMarker = String(payload.completedAt ?? "");
      if (completionMarker) {
        const stateKey = `issue_done_notified_${event.entityId}`;
        const previousMarker = await ctx.state.get({
          scopeKind: "instance",
          stateKey,
        }) as string | null;
        if (previousMarker === completionMarker) {
          ctx.logger.debug(`Skipping duplicate completion notification for ${event.entityId}`);
          return;
        }
        await ctx.state.set(
          { scopeKind: "instance", stateKey },
          completionMarker,
        );
      }

      await notify(ctx, rt, { ...event, payload }, formatIssueDone);
    });

    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnApprovalCreated) return;
      await notify(
        ctx,
        rt,
        event,
        formatApprovalCreated,
        rt.approvalsChannelId ?? undefined,
        rt.config.approvalsChannels,
        async (channelId, messageId) => {
          // Store reverse mapping so decision events can update the original message
          await ctx.state.set(
            { scopeKind: "instance", stateKey: `approval_${event.entityId}` },
            { channelId, messageId },
          );
        },
      );
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.events.on("approval.approved" as any, async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnApprovalCreated) return;
      const record = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `approval_${event.entityId}`,
      }) as { channelId: string; messageId: string } | null;
      if (!record) return;

      const decidedBy = event.actorId ?? "";
      const label = decidedBy ? `✅ Approved by ${decidedBy}` : "✅ Approved";
      await rt.adapter.editMessage(record.channelId, record.messageId, {
        embeds: [
          {
            title: label,
            color: COLORS.GREEN,
            footer: { text: "Paperclip" },
            timestamp: event.occurredAt,
          },
        ],
        components: [],
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.events.on("approval.rejected" as any, async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnApprovalCreated) return;
      const record = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `approval_${event.entityId}`,
      }) as { channelId: string; messageId: string } | null;
      if (!record) return;

      const decidedBy = event.actorId ?? "";
      const label = decidedBy ? `❌ Rejected by ${decidedBy}` : "❌ Rejected";
      await rt.adapter.editMessage(record.channelId, record.messageId, {
        embeds: [
          {
            title: label,
            color: COLORS.RED,
            footer: { text: "Paperclip" },
            timestamp: event.occurredAt,
          },
        ],
        components: [],
      });
    });

    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.config.notifyOnAgentError) return;
      await notify(ctx, rt, event, formatSessionFailure, rt.errorsChannelId ?? undefined);
    });

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      const payload = await enrichRunPayload(ctx, event);
      await notify(ctx, rt, { ...event, payload }, formatAgentRunStarted, rt.bdPipelineChannelId ?? undefined);
    });
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      const payload = await enrichRunPayload(ctx, event);
      await notify(ctx, rt, { ...event, payload }, formatAgentRunFinished, rt.bdPipelineChannelId ?? undefined);
    });

    // ===================================================================
    // Phase 1: Escalation - human-in-the-loop support
    // ===================================================================

    // Escalation state helpers are imported from ./escalation-state.js
    // Local wrappers that close over ctx for call-site convenience:
    const _getEscalation = (id: string, cid?: string) => getEscalation(ctx, id, cid);
    const _saveEscalation = (r: EscalationRecord) => saveEscalation(ctx, r);
    const _trackPending = (id: string, cid?: string) => trackPendingEscalation(ctx, id, cid);
    const _untrackPending = (id: string, cid?: string) => untrackPendingEscalation(ctx, id, cid);

    ctx.events.on(`plugin.${PLUGIN_ID}.escalation-created`, async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || rt.config.enableEscalations === false) return;
      if (isDuplicate(event.eventId)) {
        ctx.logger.debug(`Skipping duplicate escalation event (${event.eventId})`);
        return;
      }

      const payload = event.payload as unknown as EscalationCreatedPayload;
      const escalationId = payload.escalationId || event.entityId || "";
      payload.escalationId = escalationId;

      const channelId = await resolveChannel(ctx, event.companyId, rt.escalationChannelId);
      if (!channelId) return;

      const { embeds, components } = buildEscalationEmbed(payload);
      const messageId = await rt.adapter.sendButtons(channelId, embeds, components);

      if (messageId) {
        const record: EscalationRecord = {
          escalationId,
          companyId: event.companyId,
          agentName: payload.agentName,
          reason: payload.reason,
          confidenceScore: payload.confidenceScore,
          agentReasoning: payload.agentReasoning,
          conversationHistory: payload.conversationHistory,
          suggestedReply: payload.suggestedReply,
          channelId,
          messageId,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        await _saveEscalation(record);
        await _trackPending(escalationId, event.companyId);
        await ctx.metrics.write(METRIC_NAMES.escalationsCreated, 1);

        await ctx.activity.log({
          companyId: event.companyId,
          message: `Escalation created by ${payload.agentName}: ${payload.reason.slice(0, 100)}`,
          entityType: "escalation",
          entityId: escalationId,
        });

        ctx.logger.info("Escalation posted to Discord", { escalationId, channelId, messageId });
      }
    });

    // --- Phase 1: escalate_to_human tool (3-arg register with ToolRunContext) ---

    ctx.tools.register(
      "escalate_to_human",
      {
        displayName: "Escalate to Human",
        description:
          "Escalate a conversation to a human operator via Discord with interactive action buttons.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Ignored: the host-authenticated company of the invocation is always used" },
            agentName: { type: "string", description: "Agent name" },
            reason: { type: "string", description: "Why escalating" },
            confidenceScore: { type: "number", description: "Confidence (0-1)" },
            agentReasoning: { type: "string", description: "Internal reasoning" },
            conversationHistory: {
              type: "array",
              items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
              description: "Last N messages",
            },
            suggestedReply: { type: "string", description: "Suggested reply" },
          },
          required: ["companyId", "agentName", "reason"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const escalationId = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // The company comes from the host-authenticated run context, never from
        // caller-supplied parameters: the dispatcher forwards tool parameters
        // unchanged, so a `companyId` argument is an unauthenticated claim.
        const escalationCompanyId = runCtx.companyId;

        const rt = await ensureRuntime(ctx, escalationCompanyId);
        if (!rt) return { error: RUNTIME_NOT_READY_MESSAGE };

        const payload: EscalationCreatedPayload = {
          escalationId,
          companyId: escalationCompanyId,
          agentName: String(p.agentName),
          reason: String(p.reason),
          confidenceScore: p.confidenceScore !== undefined ? Number(p.confidenceScore) : undefined,
          agentReasoning: p.agentReasoning ? String(p.agentReasoning) : undefined,
          conversationHistory: p.conversationHistory as Array<{ role: string; content: string }> | undefined,
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
        };

        const channelId = await resolveChannel(ctx, escalationCompanyId, rt.escalationChannelId);
        if (!channelId) {
          return { error: "No escalation channel configured." };
        }

        const { embeds, components } = buildEscalationEmbed(payload);
        const messageId = await rt.adapter.sendButtons(channelId, embeds, components);

        if (messageId) {
          const record: EscalationRecord = {
            escalationId,
            companyId: escalationCompanyId,
            agentName: payload.agentName,
            reason: payload.reason,
            confidenceScore: payload.confidenceScore,
            agentReasoning: payload.agentReasoning,
            conversationHistory: payload.conversationHistory,
            suggestedReply: payload.suggestedReply,
            channelId,
            messageId,
            status: "pending",
            createdAt: new Date().toISOString(),
          };
          await _saveEscalation(record);
          await _trackPending(escalationId, escalationCompanyId);
          await ctx.metrics.write(METRIC_NAMES.escalationsCreated, 1);
        }

        return {
          content: JSON.stringify({
            escalationId,
            status: "pending",
            message: "Escalation posted to Discord for human review.",
          }),
        };
      },
    );

    // ===================================================================
    // Phase 2: Multi-Agent tools (3-arg register with ToolRunContext)
    // ===================================================================

    ctx.tools.register(
      "handoff_to_agent",
      {
        displayName: "Handoff to Agent",
        description: "Hand off a conversation to another agent. Requires human approval.",
        parametersSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Discord thread ID" },
            fromAgent: { type: "string", description: "Agent initiating the handoff" },
            toAgent: { type: "string", description: "Target agent name" },
            reason: { type: "string", description: "Reason for the handoff" },
            context: { type: "string", description: "Context to pass to target agent" },
          },
          required: ["threadId", "fromAgent", "toAgent", "reason"],
        },
      },
      async (params, runCtx) => {
        const rt = await ensureRuntime(ctx, runCtx.companyId);
        if (!rt) return { error: RUNTIME_NOT_READY_MESSAGE };
        const p = params as Record<string, unknown>;
        const result = await initiateHandoff(
          ctx,
          rt.token,
          String(p.threadId),
          String(p.fromAgent),
          String(p.toAgent),
          runCtx.companyId,
          String(p.reason),
          p.context ? String(p.context) : undefined,
        );
        return {
          content: JSON.stringify({
            handoffId: result.handoffId,
            status: result.status,
            message: "Handoff posted to Discord for human approval.",
          }),
        };
      },
    );

    ctx.tools.register(
      "discuss_with_agent",
      {
        displayName: "Discuss with Agent",
        description: "Start a multi-turn discussion between two agents with human checkpoints.",
        parametersSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Discord thread ID" },
            initiator: { type: "string", description: "Agent starting the discussion" },
            target: { type: "string", description: "Agent to discuss with" },
            topic: { type: "string", description: "Topic or question" },
            maxTurns: { type: "number", description: "Max turns (default 10, max 50)" },
            humanCheckpointInterval: { type: "number", description: "Pause every N turns (0 = none)" },
          },
          required: ["threadId", "initiator", "target", "topic"],
        },
      },
      async (params, runCtx) => {
        const rt = await ensureRuntime(ctx, runCtx.companyId);
        if (!rt) return { error: RUNTIME_NOT_READY_MESSAGE };
        const p = params as Record<string, unknown>;
        const result = await startDiscussion(
          ctx,
          rt.token,
          String(p.threadId),
          String(p.initiator),
          String(p.target),
          runCtx.companyId,
          String(p.topic),
          p.maxTurns ? Number(p.maxTurns) : 10,
          p.humanCheckpointInterval ? Number(p.humanCheckpointInterval) : 0,
        );
        return {
          content: JSON.stringify({
            discussionId: result.discussionId,
            status: result.status,
            message: "Discussion loop started.",
          }),
        };
      },
    );

    // ===================================================================
    // Phase 1: Escalation timeout check job
    // ===================================================================

    ctx.jobs.register("check-escalation-timeouts", async () => {
      const rt = await ensureRuntime(ctx);
      if (!rt) return;
      // Jobs are not company-scoped invocations. The company they operate on is
      // the owner's — the only company this install serves — never whatever
      // `resolveCompanyId` happens to pick, which would pair one company's data
      // with another company's Discord connection.
      const jobCompanyId = rt.companyId;
      const pendingIds = await collectPendingEscalationIds(ctx, jobCompanyId);
      if (pendingIds.length === 0) return;

      const now = Date.now();

      for (const escalationId of pendingIds) {
        const record = await _getEscalation(escalationId, jobCompanyId);
        if (!record || record.status !== "pending") {
          await _untrackPending(escalationId, record?.companyId || jobCompanyId);
          continue;
        }

        const elapsed = now - new Date(record.createdAt).getTime();
        if (elapsed < rt.escalationTimeoutMs) continue;

        record.status = "timed_out";
        record.resolvedAt = new Date().toISOString();
        await _saveEscalation(record);
        await _untrackPending(escalationId, record.companyId || jobCompanyId);
        await ctx.metrics.write(METRIC_NAMES.escalationsTimedOut, 1);

        await rt.adapter.editMessage(record.channelId, record.messageId, {
          embeds: [
            {
              title: `Escalation from ${record.agentName} - TIMED OUT`,
              description: `This escalation was not resolved within ${rt.config.escalationTimeoutMinutes || 30} minutes.`,
              color: COLORS.RED,
              fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
              footer: { text: "Paperclip Escalation" },
              timestamp: record.resolvedAt,
            },
          ],
          components: [],
        });

        ctx.events.emit("escalation-timed-out", record.companyId, {
          escalationId,
          companyId: record.companyId,
          agentName: record.agentName,
          reason: record.reason,
        });

        ctx.logger.info("Escalation timed out", { escalationId });
      }
    });

    // ===================================================================
    // Budget threshold check job
    // ===================================================================

    ctx.jobs.register("check-budget-thresholds", async () => {
      const rt = await ensureRuntime(ctx);
      if (!rt) return;
      const jobCompanyId = rt.companyId;
      const agents = await ctx.agents.list({ companyId: jobCompanyId });

      for (const agent of agents) {
        const a = agent as { id: string; name: string; status?: string };
        if (a.status && a.status !== "active") continue;

        const budgetState = await ctx.state.get({
          scopeKind: "agent",
          scopeId: a.id,
          stateKey: "budget",
        }) as { spent?: number; limit?: number } | null;

        if (!budgetState?.limit || budgetState.limit <= 0) continue;

        const spent = budgetState.spent ?? 0;
        const limit = budgetState.limit;
        const pct = spent / limit;

        if (pct < BUDGET_ALERT_THRESHOLD) continue;

        // Dedup: check if we already alerted for this billing cycle
        const alertState = await ctx.state.get({
          scopeKind: "agent",
          scopeId: a.id,
          stateKey: "budget-alert-last-sent",
        }) as { limit?: number; sentAt?: string } | null;

        // Only alert once per agent per billing cycle (identified by limit value)
        if (alertState?.limit === limit) continue;

        const remaining = limit - spent;
        const pctRounded = Math.round(pct * 100);

        const channelId = await resolveChannel(
          ctx,
          jobCompanyId,
          rt.errorsChannelId ?? rt.defaultChannelId,
        );
        if (!channelId) continue;

        const message = formatBudgetWarning({
          agentName: a.name,
          agentId: a.id,
          spent,
          limit,
          remaining,
          pct: pctRounded,
        });

        await postEmbed(ctx, rt.token, channelId, message);

        // Record that we sent the alert for this billing cycle
        await ctx.state.set(
          { scopeKind: "agent", scopeId: a.id, stateKey: "budget-alert-last-sent" },
          { limit, sentAt: new Date().toISOString() },
        );

        await ctx.metrics.write(METRIC_NAMES.budgetWarningsSent, 1);
        ctx.logger.info("Budget threshold alert sent", { agentId: a.id, agentName: a.name, pct: pctRounded });
      }
    });

    // ===================================================================
    // Phase 4: Custom Commands tool (3-arg register)
    // ===================================================================

    ctx.tools.register(
      "register_custom_command",
      {
        displayName: "Register Custom Command",
        description: "Register a custom !command for Discord users to invoke.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Ignored: the host-authenticated company of the invocation is always used" },
            command: { type: "string", description: "Command name (without !)" },
            description: { type: "string", description: "Description" },
            parameters: {
              type: "array",
              items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } } },
              description: "Parameters",
            },
          },
          required: ["companyId", "command", "description"],
        },
      },
      async (params, runCtx) => {
        const rt = await ensureRuntime(ctx, runCtx.companyId);
        if (!rt) return { error: RUNTIME_NOT_READY_MESSAGE };
        if (rt.config.enableCustomCommands === false) {
          return { error: "Custom commands are disabled in this plugin configuration." };
        }
        const p = params as Record<string, unknown>;
        const result = await registerCommand(
          ctx,
          runCtx.companyId,
          String(p.command),
          String(p.description),
          (p.parameters as Array<{ name: string; description: string; required: boolean }>) ?? [],
          runCtx.agentId,
          String(p.agentName ?? runCtx.agentId),
        );
        return { content: JSON.stringify(result) };
      },
    );

    // ===================================================================
    // Phase 5: Proactive Suggestions tool (3-arg register)
    // ===================================================================

    ctx.tools.register(
      "register_watch",
      {
        displayName: "Register Watch",
        description: "Register a watch condition that fires proactive suggestions.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Ignored: the host-authenticated company of the invocation is always used" },
            watchName: { type: "string", description: "Watch name" },
            patterns: { type: "array", items: { type: "string" }, description: "Regex patterns" },
            channelIds: { type: "array", items: { type: "string" }, description: "Channel IDs (empty = all)" },
            responseTemplate: { type: "string", description: "Suggestion template" },
            cooldownMinutes: { type: "number", description: "Cooldown minutes (default 60)" },
          },
          required: ["companyId", "watchName", "patterns", "responseTemplate"],
        },
      },
      async (params, runCtx) => {
        const rt = await ensureRuntime(ctx, runCtx.companyId);
        if (!rt) return { error: RUNTIME_NOT_READY_MESSAGE };
        if (rt.config.enableProactiveSuggestions === false) {
          return { error: "Proactive suggestions are disabled in this plugin configuration." };
        }
        const p = params as Record<string, unknown>;
        const result = await registerWatch(
          ctx,
          runCtx.companyId,
          String(p.watchName),
          (p.patterns as string[]) ?? [],
          (p.channelIds as string[]) ?? [],
          String(p.responseTemplate),
          p.cooldownMinutes ? Number(p.cooldownMinutes) : 60,
          runCtx.agentId,
          String(p.agentName ?? runCtx.agentId),
        );
        return { content: JSON.stringify(result) };
      },
    );

    ctx.jobs.register("check-watches", async () => {
      const rt = await ensureRuntime(ctx);
      if (!rt) return;
      const cid = rt.companyId;
      if (rt.config.enableProactiveSuggestions === false) {
        ctx.logger.debug("check-watches: proactive suggestions disabled, skipping");
        return;
      }
      await checkWatches(ctx, rt.token, cid, rt.defaultChannelId);
    });

    // ===================================================================
    // Daily Digest Job
    // ===================================================================

    ctx.jobs.register("discord-daily-digest", async () => {
      const rt = await ensureRuntime(ctx);
      if (!rt) return;
      const effectiveDigestMode = rt.digestMode;
      if (effectiveDigestMode === "off") {
        ctx.logger.debug("discord-daily-digest: digest mode is off, skipping");
        return;
      }
      const nowHour = new Date().getUTCHours();
      const nowMin = new Date().getUTCMinutes();
      if (nowMin >= 5) return; // only fire within first 5 min of the hour

      const parseHour = (t: string) => {
        const [h] = (t || "").split(":");
        return parseInt(h ?? "", 10);
      };
      const firstHour = parseHour(rt.config.dailyDigestTime || "09:00");
      const secondHour = parseHour(rt.config.bidailySecondTime || "17:00");
      const tridailyHours = (rt.config.tridailyTimes || "07:00,13:00,19:00")
        .split(",")
        .map((t) => parseHour(t.trim()));

      let shouldSend = false;
      if (effectiveDigestMode === "daily") {
        shouldSend = nowHour === firstHour;
      } else if (effectiveDigestMode === "bidaily") {
        shouldSend = nowHour === firstHour || nowHour === secondHour;
      } else if (effectiveDigestMode === "tridaily") {
        shouldSend = tridailyHours.includes(nowHour);
      }
      if (!shouldSend) return;

      const companies = await ctx.companies.list();
      for (const company of companies) {
        const channelId = await resolveChannel(ctx, company.id, rt.defaultChannelId);
        if (!channelId) continue;

        try {
          const agents = await ctx.agents.list({ companyId: company.id });
          const activeAgents = agents.filter((a: { status: string }) => a.status === "active");
          const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });

          const now = Date.now();
          const oneDayMs = 24 * 60 * 60 * 1000;
          const completedToday = issues.filter((i: { status: string; completedAt?: Date | null }) =>
            i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
          );
          const createdToday = issues.filter((i: { createdAt: Date }) =>
            (now - new Date(i.createdAt).getTime()) < oneDayMs
          );

          const inProgress = issues.filter((i: { status: string }) => i.status === "in_progress");
          const inReview = issues.filter((i: { status: string }) => i.status === "in_review");
          const blocked = issues.filter((i: { status: string }) => i.status === "blocked");

          const dateStr = new Date().toISOString().split("T")[0];
          const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
          const companyLabel = company.name ? ` — ${company.name}` : "";

            const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

            // Blocked items first (attention-first ordering)
            if (blocked.length > 0) {
              const blockedLines = blocked.slice(0, 10).map((i: { identifier?: string | null; id: string; title: string; assigneeName?: string; blockerReason?: string }) => {
                const reason = i.blockerReason ? ` → ${i.blockerReason}` : "";
                return `• **${i.identifier ?? i.id}** — ${i.title}${reason}`;
              }).join("\n");
              fields.push({ name: `🚫 Blocked (${blocked.length})`, value: blockedLines.slice(0, 1024) });
            }

            // In Progress with assignee and priority
            if (inProgress.length > 0) {
              const ipLines = inProgress.slice(0, 10).map((i: { identifier?: string | null; id: string; title: string; assigneeName?: string; priority?: string }) => {
                const meta: string[] = [];
                if (i.assigneeName) meta.push(String(i.assigneeName));
                if (i.priority) meta.push(humanizePriority(String(i.priority)));
                const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
                return `• **${i.identifier ?? i.id}** — ${i.title}${suffix}`;
              }).join("\n");
              fields.push({ name: `🔄 In Progress (${inProgress.length})`, value: ipLines.slice(0, 1024) });
            }

            if (inReview.length > 0) {
              const reviewLines = inReview.slice(0, 10).map((i: { identifier?: string | null; id: string; title: string }) =>
                `• **${i.identifier ?? i.id}** — ${i.title}`
              ).join("\n");
              fields.push({ name: `🔍 In Review (${inReview.length})`, value: reviewLines.slice(0, 1024) });
            }

            // Completed: collapse after 3
            if (completedToday.length > 0) {
              const shownCompleted = completedToday.slice(0, 3).map((i: { identifier?: string | null; id: string; title: string }) =>
                `• **${i.identifier ?? i.id}** — ${i.title}`
              );
              if (completedToday.length > 3) {
                shownCompleted.push(`*+ ${completedToday.length - 3} more*`);
              }
              fields.push({ name: `✅ Completed Today (${completedToday.length})`, value: shownCompleted.join("\n").slice(0, 1024) });
            }

            // Summary stats
            fields.push(
              { name: "📋 Created Today", value: String(createdToday.length), inline: true },
              { name: "🤖 Active Agents", value: `${activeAgents.length}/${agents.length}`, inline: true },
            );

            // Trend line in footer
            const footerText = `Paperclip • ${completedToday.length} completed, ${blocked.length} blocked, ${inProgress.length} in progress`;

            const digestComponents: DiscordComponent[] = [];
            const digestButtons: DiscordComponent[] = [
              { type: 2, style: 5, label: "View Dashboard", url: rt.baseUrl },
            ];
            if (blocked.length > 0) {
              digestButtons.push({
                type: 2,
                style: 1,
                label: "View Blocked",
                custom_id: `digest_blocked_${company.id}`,
              });
            }
            digestComponents.push({ type: 1, components: digestButtons });

            const embeds: DiscordEmbed[] = [
              {
                title: `📊 ${digestLabel}${companyLabel} — ${dateStr}`,
                color: COLORS.BLUE,
                fields,
                footer: { text: footerText },
                timestamp: new Date().toISOString(),
              },
            ];

            await postEmbed(ctx, rt.token, channelId, { embeds, components: digestComponents });
            await ctx.metrics.write(METRIC_NAMES.digestSent, 1);
          } catch (err) {
            ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
            await postEmbed(ctx, rt.token, channelId, {
              embeds: [{
                title: "📊 Daily Digest",
                description: "Could not generate digest. Check plugin logs for details.",
                color: COLORS.RED,
                footer: { text: "Paperclip" },
                timestamp: new Date().toISOString(),
              }],
            });
          }
      }
    });

    ctx.logger.debug("Daily digest job registered; digest mode is read from the live config at run time");

    // --- Per-company channel overrides ---

    ctx.data.register("channel-mapping", async (params) => {
      const cid = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: cid,
        stateKey: "discord-channel",
      });
      return { channelId: normalizeDiscordId(saved) ?? runtime?.defaultChannelId ?? "" };
    });

    ctx.actions.register("set-channel", async (params) => {
      const cid = String(params.companyId);
      if (typeof params.channelId !== "string") {
        return { ok: false, error: "Invalid channel ID - must be a snowflake string" };
      }
      const channelId = params.channelId.trim();
      if (!SNOWFLAKE_ID_REGEX.test(channelId)) {
        return { ok: false, error: "Invalid channel ID - must be a snowflake string" };
      }
      await ctx.state.set(
        { scopeKind: "company", scopeId: cid, stateKey: "discord-channel" },
        channelId,
      );
      ctx.logger.info("Updated Discord channel mapping", { companyId: cid, channelId });
      return { ok: true };
    });

    // --- Intelligence: agent-queryable tool (3-arg register) ---

    ctx.tools.register(
      "discord_signals",
      {
        displayName: "Discord Signals",
        description: "Query recent community signals from Discord.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Ignored: the host-authenticated company of the invocation is always used" },
            category: {
              type: "string",
              enum: ["feature_wish", "pain_point", "maintainer_directive", "sentiment"],
              description: "Filter by category",
            },
          },
          required: ["companyId"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const cid = runCtx.companyId;
        const raw = await ctx.state.get({
          scopeKind: "company",
          scopeId: cid,
          stateKey: "discord_intelligence",
        });
        if (!raw) return { content: JSON.stringify({ signals: [], lastScanned: null }) };

        const data = raw as { signals: Array<{ category: string; expiresAt?: string }>; lastScanned: string };
        const now = new Date().toISOString();
        const fresh = data.signals.filter((s) => !s.expiresAt || s.expiresAt > now);
        const category = p.category ? String(p.category) : null;
        const filtered = category ? fresh.filter((s) => s.category === category) : fresh;

        return { content: JSON.stringify({ signals: filtered, lastScanned: data.lastScanned }) };
      },
    );

    // --- Intelligence: scheduled scan ---

    ctx.jobs.register("discord-intelligence-scan", async () => {
      const rt = await ensureRuntime(ctx);
      if (!rt) return;
      const cid = rt.companyId;
      if (!rt.config.enableIntelligence || rt.intelligenceChannelIds.length === 0 || !rt.defaultGuildId) {
        ctx.logger.debug("discord-intelligence-scan: intelligence disabled or no channels configured, skipping");
        return;
      }
      await runIntelligenceScan(
        ctx,
        rt.token,
        rt.defaultGuildId,
        rt.intelligenceChannelIds,
        cid,
        rt.retentionDays,
      );
    });

    // --- Backfill ---
    //
    // The first-install backfill is fired from the runtime bootstrap (it needs a
    // bot token). This action re-runs it on demand and is registered
    // unconditionally, because whether intelligence is enabled is only known once
    // the runtime exists.

    ctx.actions.register("trigger-backfill", async (_params, actionCtx) => {
      // The host supplies the authorized company for this action; a non-owner is
      // refused rather than silently backfilling the owner's data.
      const rt = await ensureRuntime(ctx, actionCtx?.companyId ?? null);
      if (!rt) return { ok: false, error: RUNTIME_NOT_READY_MESSAGE };
      const cid = rt.companyId;
      if (!rt.config.enableIntelligence || rt.intelligenceChannelIds.length === 0 || !rt.defaultGuildId) {
        return { ok: false, error: "Intelligence is disabled or no intelligence channels are configured." };
      }
      await ctx.state.set(
        { scopeKind: "company", scopeId: cid, stateKey: "discord_intelligence" },
        { signals: [], backfillComplete: false },
      );
      const signals = await runBackfill(
        ctx,
        rt.token,
        rt.defaultGuildId,
        rt.intelligenceChannelIds,
        cid,
        rt.config.backfillDays ?? 90,
      );
      return { ok: true, signalsFound: signals.length };
    });

    // Registration is all setup() does. The runtime starts only when the host
    // delivers configuration (>= v2026.817.0 replays it at worker start; a save
    // arrives this way on every host). Invocations never bootstrap.
    ctx.logger.info("Discord plugin registered; waiting for configuration");
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey === WEBHOOK_KEYS.discordInteractions) {
      const body = input.parsedBody as Record<string, unknown>;
      if (!body) return;

      const ctx = _pluginCtx;
      // An interaction carries no company scope, so this consumes whatever
      // runtime a configuration delivery has already established, if any.
      const cmdCtx = (await ensureRuntime(ctx))?.cmdCtx ?? null;

      if (!ctx || !cmdCtx) {
        // Return a valid Discord interaction response even before setup completes.
        // The host framework forwards the return value as the HTTP response body.
        return respondToInteraction({
          type: 4,
          content: "Plugin is still starting up. Please try again in a moment.",
          ephemeral: true,
        }) as unknown as void;
      }

      try {
        const response = await handleInteraction(ctx, body as any, cmdCtx);
        // The host framework forwards this as the HTTP response body to Discord.
        return response as unknown as void;
      } catch (err) {
        ctx.logger.error("Interaction handler failed", { error: String(err) });
        return respondToInteraction({
          type: 4,
          content: "An error occurred while processing this command. Please try again.",
          ephemeral: true,
        }) as unknown as void;
      }
    }
  },

  async onValidateConfig(config) {
    // Accepts both stored shapes: the settings picker's secret binding
    // ({ type: "secret_ref", secretId }) and a legacy bare secret UUID string.
    if (!isUsableSecretRef(config.discordBotTokenRef)) {
      return { ok: false, errors: [`[${PLUGIN_ID}] discordBotTokenRef is required`] };
    }
    if (
      !config.defaultChannelId ||
      typeof config.defaultChannelId !== "string" ||
      !config.defaultChannelId.trim()
    ) {
      return { ok: false, errors: [`[${PLUGIN_ID}] defaultChannelId is required`] };
    }
    return { ok: true };
  },

  /**
   * The host delivers stored config here — at worker startup and on every save —
   * and, from SDK v2026.817.0, with its company scope.
   *
   * The v2026.720.0 and v2026.722.0 SDKs call this with the config ALONE
   * (`onConfigChanged(params.config)`), even though the host binds the RPC
   * invocation to the real company and denies a read for any other one. So when
   * no scope is handed over, probe for it inside this invocation instead of
   * guessing: only the delivered company answers a scoped config read.
   */
  async onConfigChanged(newConfig, context): Promise<void> {
    const ctx = _pluginCtx;
    if (!ctx) return;

    // Queue against every other bootstrap source, including other deliveries:
    // two concurrent saves would otherwise each open a gateway and leak one.
    await queueBootstrap(async () => {
      let companyId = context?.companyId ?? null;
      if (!companyId) {
        const running = runtime;
        if (running) {
          // Do NOT assume a context-less delivery belongs to the running company.
          // Probe it inside this invocation: on 720/722 only the invocation's own
          // company answers, so a success is evidence, and a denial means this
          // delivery belongs to somebody else.
          const ownConfig = await readScopedConfig(ctx, running.companyId);
          if (ownConfig) {
            companyId = running.companyId;
          } else {
            const other = await identifyDeliveredCompany(ctx, newConfig);
            ctx.logger.warn(
              other
                ? `Discord plugin ignoring configuration for company ${other}; this install serves ${running.companyId}`
                : `Discord plugin ignoring a configuration delivery it could not attribute; this install serves ${running.companyId}`,
              { runningCompanyId: running.companyId, deliveredCompanyId: other },
            );
            // The running company is untouched: keep its gateway and its health.
            return;
          }
        } else {
          companyId = await identifyDeliveredCompany(ctx, newConfig);
        }

        if (companyId) {
          ctx.logger.info("Config delivered without a company scope; identified it by scoped probe", {
            companyId,
          });
        }
      }

      if (!companyId) {
        degradeHealth(
          "Configuration was delivered without a company scope and no company answered a scoped " +
            "configuration read, so its secrets cannot be resolved. Upgrade the host to v2026.817.0 or newer.",
          "discord-config-scope-unknown",
        );
        return;
      }

      try {
        // Bootstrap from the DELIVERED config, not a probe result: the delivery
        // is the fresher of the two.
        await bootstrapRuntime(ctx, companyId, newConfig);
      } catch (err) {
        const error = summarizeError(err);
        ctx.logger.error("Discord plugin failed to apply a configuration change", { error, companyId });
        degradeHealth(`Applying the delivered configuration failed: ${error}`, "discord-config-apply-failed", {
          companyId,
        });
      }
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return runtimeHealth;
  },
});

runWorker(plugin, import.meta.url);
