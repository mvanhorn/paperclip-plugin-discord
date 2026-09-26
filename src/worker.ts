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
  type DiscordMessage,
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
import {
  connectGateway,
  type GatewayHandle,
  type MessageCreateEvent,
  type DiscordMessageAttachment,
} from "./gateway.js";
// Statically imported: stt-whisper.ts has no optional peer dependencies of its
// own (unlike the rest of ./voice/, gated behind a dynamic import), so item 8's
// voice-message path works even when live voice (#talk) is not configured.
import { WhisperSTTAdapter } from "./voice/stt-whisper.js";
import {
  handleAcpOutput,
  routeMessageToAgent,
  createAgentThread,
  spawnAgentInThread,
  closeAgentInThread,
} from "./session-registry.js";
import { DiscordAdapter } from "./adapter.js";
import { processMediaMessage, type MediaAttachment } from "./media-pipeline.js";
import { parseCommandMessage, executeCommand, listCommands } from "./custom-commands.js";
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
  /**
   * One Discord bot per agent. An outbound notification about an issue posts
   * through the assignee's bot; with no match, it falls back to the
   * discordBotTokenRef bot. Empty by default, matching upstream's single-bot
   * behavior exactly.
   */
  agentBots?: Array<{
    agentId: string;
    botTokenRef: DiscordSecretRef;
    channelId: string;
    /** Worker agent IDs whose outbound posts also go through this entry's bot and channel — named explicitly, never looked up via reportsTo at runtime. */
    alsoForAgentIds?: string[];
  }>;
  /**
   * When set, every inbound path drops any author whose ID does not match this
   * snowflake. Unset (the default) keeps upstream's unrestricted behavior.
   */
  hannaDiscordUserId?: string;
  /**
   * Outbound item 4: when a lead's issue reaches `done`, the lead's bot posts
   * one line here. Empty (the default) posts nothing.
   */
  accomplishmentsChannelId?: string;
  /**
   * Outbound item 5: when a goal reaches `achieved` or a project reaches
   * `completed`, the owner's or lead's bot (else the default bot) posts one
   * line here. Empty (the default) posts nothing.
   */
  milestonesChannelId?: string;
  /** Local Whisper (whisper.cpp) config — see src/voice/stt-whisper.ts for the defaults. */
  whisperBinaryPath?: string;
  ffmpegPath?: string;
  whisperModelPath?: string;
  whisperLanguage?: string;
  /**
   * Standing Paperclip issue a live-voice utterance routes to when there is no
   * thread Hanna last replied in. Empty (the default) means the plugin creates
   * one on first need and remembers its id in plugin state.
   */
  voiceInboxIssueId?: string;
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
  /**
   * Resolved agent bot map: one live Gateway client per configured entry,
   * alongside the plain bot token an outbound REST post authenticates with.
   * `gateway` is null when that entry's token could not be resolved or its
   * connection failed — the entry still participates in outbound routing via
   * its token, only presence/liveness is affected.
   */
  agentBots: Array<{
    agentId: string;
    /** Effective, deduped worker ids this entry also posts for (see resolveAgentBots). */
    alsoForAgentIds: string[];
    token: string;
    channelId: string;
    gateway: GatewayHandle | null;
  }>;
  /** Normalized snowflake, or null when the operator has not set one (opt-out). */
  hannaDiscordUserId: string | null;
  /** Null when unset: no accomplishment posts. */
  accomplishmentsChannelId: string | null;
  /** Null when unset: no milestone posts, and no goal or project reads. */
  milestonesChannelId: string | null;
};

/** Captured in setup() so onWebhook / onConfigChanged can reach the host APIs. */
let _pluginCtx: PluginContext | null = null;
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

/**
 * The author allowlist. Every inbound path — typed replies, button clicks,
 * slash commands, voice — calls this before doing anything with what it
 * received.
 *
 * Fails CLOSED: `hannaDiscordUserId` unset drops every author, on every path.
 * The plan is a single-operator surface; the failure-open shape upstream has
 * (no ID configured means every author is trusted) is exactly wrong for that —
 * a missed configuration step must not silently become "everyone is Hanna".
 * See `applyInboundAllowlistHealth`, which reports this through plugin health
 * and logs it once per configuration delivery.
 */
function isAllowedInboundAuthor(rt: DiscordRuntime, authorId: string | null | undefined): boolean {
  if (!rt.hannaDiscordUserId) return false;
  return normalizeDiscordId(authorId) === rt.hannaDiscordUserId;
}

/** Health issue code: no operator configured, so every inbound author is dropped. */
const INBOUND_DISABLED_ISSUE = "discord-inbound-disabled";

/**
 * Surface "no operator configured" through plugin health and the log, once
 * per configuration delivery. Called right after health is reset to "ok" for
 * this delivery (see the bootstrap flow), so it never has to fight an
 * unrelated degradation to report this one — and voice's own health refresh,
 * called after this, bails out on seeing a non-"ok", non-voice status, so
 * this note is not overwritten by a voice note in the same delivery.
 */
function applyInboundAllowlistHealth(ctx: PluginContext, rt: DiscordRuntime): void {
  if (rt.hannaDiscordUserId) return;
  const message =
    `[${PLUGIN_ID}] inbound is disabled: hannaDiscordUserId is not configured, ` +
    "so no Discord author is trusted and every reply, button, command, and voice input is dropped";
  ctx.logger.warn(message, { companyId: rt.companyId });
  degradeHealth(message, INBOUND_DISABLED_ISSUE, { companyId: rt.companyId });
}

/** The Discord user ID on an interaction payload (slash command or button click). */
function interactionAuthorId(interaction: unknown): string | null {
  const member = (interaction as { member?: { user?: { id?: unknown } } } | null)?.member;
  return normalizeDiscordId(member?.user?.id);
}

/** The ephemeral refusal an interaction from a non-operator author gets. */
function unauthorizedInteractionResponse(): unknown {
  return respondToInteraction({
    type: 4,
    content: "This bot only takes commands from its configured operator.",
    ephemeral: true,
  });
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

    const statusForCommentLookup = String(payload.status ?? "");
    // "done" needs the last comment for the "Completed by" field. `in_review`
    // and `blocked` need it too — it is the agent's ask that the board-wake
    // notification (outbound trigger 1) posts to Hanna. Only "done" derives
    // completedBy from it; the other two statuses just want the text.
    if (statusForCommentLookup === "done" || statusForCommentLookup === "in_review" || statusForCommentLookup === "blocked") {
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
        if (statusForCommentLookup === "done" && payload.completedBy == null) {
          if (lastComment.authorUserId) {
            payload.completedBy = lastComment.authorUserId.startsWith("discord:")
              ? lastComment.authorUserId
              : "Board user";
          } else if (lastComment.authorAgentId) {
            payload.completedBy = payload.agentName ?? "Agent";
          }
        }
      }
    }

    if (statusForCommentLookup === "done" && payload.completedBy == null) {
      if (typeof payload.assigneeUserId === "string") {
        payload.completedBy = payload.assigneeUserId.startsWith("discord:")
          ? payload.assigneeUserId
          : "Board user";
      } else {
        payload.completedBy = payload.agentName ?? payload.assigneeAgentId ?? null;
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

/** Discord's hard cap for one message is 2,000 characters; the spec sets a
 * narrower budget of 1,900 for the ask text itself, leaving headroom for the
 * mention and the issue link on their own lines. */
const BOARD_WAKE_ASK_LIMIT = 1900;

/** Every status that ever wakes Hanna (spec's Message flow, outbound trigger 1). */
const BOARD_WAKE_STATUSES = new Set(["in_review", "blocked"]);

/** The pseudo-user an issue is assigned to while it waits on the board. */
const BOARD_ASSIGNEE = "local-board";

/**
 * Outbound trigger 1 from the spec's "Message flow": an issue moves to
 * `in_review` or `blocked`, assigned to `local-board`. The assignee's own bot
 * posts the agent's ask and mentions the configured operator. This is the
 * only event that ever posts that mention. If no agent bot and channel match,
 * the wake is dropped rather than sent through the default channel.
 *
 * Opt-in: with no `hannaDiscordUserId` configured there is no one to mention,
 * so this never fires — matching upstream, which has no such event at all.
 */
async function notifyBoardWake(
  ctx: PluginContext,
  rt: DiscordRuntime,
  event: PluginEvent,
  payload: IssueNotificationPayload,
): Promise<void> {
  if (!rt.hannaDiscordUserId) return;
  const status = String(payload.status ?? "");
  if (!BOARD_WAKE_STATUSES.has(status)) return;
  if (payload.assigneeUserId !== BOARD_ASSIGNEE) return;

  // Dedup on status + the issue's own updatedAt, mirroring the "done"
  // notification's completedAt marker: a redelivered event with nothing new
  // to say produces no second message, while a later move back through the
  // same status (a fresh updatedAt) wakes Hanna again.
  const marker = `${status}:${String(payload.updatedAt ?? event.occurredAt ?? "")}`;
  const stateKey = `board_wake_notified_${event.entityId}`;
  const previousMarker = (await ctx.state.get({ scopeKind: "instance", stateKey })) as string | null;
  if (previousMarker === marker) return;

  const agentId = typeof payload.assigneeAgentId === "string" ? payload.assigneeAgentId : null;
  const outboundBot = resolveOutboundBot(rt, agentId);
  if (!outboundBot.channelId) {
    ctx.logger.warn("board-wake: no agent bot/channel resolved, dropping the wake", {
      issueId: event.entityId,
      companyId: event.companyId,
      agentId,
    });
    return;
  }
  const channelId = await resolveChannel(ctx, event.companyId, outboundBot.channelId);
  if (!channelId) {
    ctx.logger.warn("board-wake: no channel resolved, dropping the wake", {
      issueId: event.entityId,
      companyId: event.companyId,
    });
    return;
  }

  const scope = { scopeKind: "instance" as const, stateKey };
  // Claim before the post, so a concurrent handler for the same wake skips.
  await ctx.state.set(scope, marker);

  const askText = String(payload.lastComment ?? payload.title ?? "").trim();
  const truncatedAsk =
    askText.length > BOARD_WAKE_ASK_LIMIT ? askText.slice(0, BOARD_WAKE_ASK_LIMIT) : askText;
  const identifier = String(payload.identifier ?? event.entityId);
  const issueUrl = `${rt.baseUrl}/issues/${identifier}`;
  const mention = `<@${rt.hannaDiscordUserId}>`;
  const content = [mention, truncatedAsk, issueUrl].filter((line) => line.length > 0).join("\n\n");

  const messageId = await postEmbedWithId(ctx, outboundBot.token, channelId, { content });
  if (!messageId) {
    ctx.logger.warn("board-wake: failed to post the wake message to Discord", {
      issueId: event.entityId,
      companyId: event.companyId,
      status,
    });
    await releaseClaim(ctx, scope, previousMarker);
    return;
  }

  if (rt.config.enableInbound !== false) {
    // So a reply to this exact message routes back to the issue, same as any
    // other notification (see `notify()` and `resolveInboundDestination`).
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `msg_${channelId}_${messageId}` },
      { entityId: event.entityId, entityType: event.entityType, companyId: event.companyId, eventType: event.eventType },
    );
  }

  await ctx.activity.log({
    companyId: event.companyId,
    message: `Woke Hanna for ${identifier} (${status})`,
    entityType: "plugin",
    entityId: event.entityId,
  });
}

/**
 * Posts to the shared channels carry this: Discord resolves no user, role, or
 * @everyone mention in the content, so a title that happens to contain one
 * still sends no push. Neither shared channel ever mentions Hanna.
 */
const NO_MENTIONS: NonNullable<DiscordMessage["allowed_mentions"]> = { parse: [] };

/** A shared-channel post is one line; a long title is cut to this length. */
const SHARED_LINE_TEXT_LIMIT = 300;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SHARED_LINE_TEXT_LIMIT ? `${flat.slice(0, SHARED_LINE_TEXT_LIMIT - 1)}…` : flat;
}

/**
 * Undo a dedup claim after a failed post. If the undo itself fails, the claim
 * stays set and blocks every later post for this item, so say so loudly.
 */
async function releaseClaim(
  ctx: PluginContext,
  scope: { scopeKind: "instance"; stateKey: string },
  restore: string | null,
): Promise<void> {
  try {
    if (restore == null) await ctx.state.delete(scope);
    else await ctx.state.set(scope, restore);
  } catch (error) {
    ctx.logger.error("shared channel post: could not release the dedup claim; this item will not post again until the state key is cleared", {
      stateKey: scope.stateKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Outbound item 4 from the spec's "Message flow": an issue assigned to a lead
 * reaches `done`, and the lead's bot posts one line in the accomplishments
 * channel. A lead is the `agentId` of an `agentBots` entry; an issue assigned
 * to an `alsoForAgentIds` member posts nothing here (its thread post stays).
 *
 * `issue.updated` fires on every issue change, so the plugin must tell a move
 * into `done` from a later update to a done issue:
 * - `_previous` names `status`: a change exactly when it was not `done`.
 * - `_previous` exists without `status`: the status did not change. This also
 *   covers a PATCH that re-sends `done`, which Paperclip answers with a fresh
 *   `completedAt` (applyStatusSideEffects) and a `_previous` of that field only.
 * - No `_previous` (some server paths omit it): the issue's `completedAt`,
 *   stored per issue, is the marker, as for the thread's done post.
 * The stored marker also drops a redelivered event in every case.
 */
async function notifyAccomplishment(
  ctx: PluginContext,
  rt: DiscordRuntime,
  event: PluginEvent,
  payload: IssueNotificationPayload,
): Promise<void> {
  const channelId = rt.accomplishmentsChannelId;
  if (!channelId || !event.entityId) return;
  if (payload.status !== "done") return;
  // Enrichment sets assigneeAgentId (null when unassigned); undefined means
  // the issue read failed, which must not pass as "not a lead's issue".
  if (payload.assigneeAgentId === undefined) {
    ctx.logger.warn("accomplishment: could not read the done issue's assignee; posting nothing", {
      issueId: event.entityId,
      companyId: event.companyId,
    });
    return;
  }
  const agentId = typeof payload.assigneeAgentId === "string" ? payload.assigneeAgentId : null;
  const lead = agentId ? rt.agentBots.find((b) => b.agentId === agentId) : undefined;
  if (!lead) return;

  const previous = (event.payload as Record<string, unknown> | null)?._previous;
  if (previous && typeof previous === "object") {
    if (!("status" in previous)) return;
    if ((previous as Record<string, unknown>).status === "done") return;
  }

  const marker = String(payload.completedAt ?? "");
  if (!marker) {
    ctx.logger.warn("accomplishment: a done issue has no completedAt, so a repeat cannot be told apart; posting nothing", {
      issueId: event.entityId,
      companyId: event.companyId,
    });
    return;
  }
  const scope = { scopeKind: "instance" as const, stateKey: `accomplishment_posted_${event.entityId}` };
  const previousMarker = (await ctx.state.get(scope)) as string | null;
  if (previousMarker === marker) return;
  // Claim before the post, so a second handler for the same completion skips.
  await ctx.state.set(scope, marker);

  const identifier = String(payload.identifier ?? event.entityId);
  const title = oneLine(String(payload.title ?? ""));
  // Angle brackets keep Discord from unfurling the link into an embed.
  const content = `✅ ${[identifier, title].filter(Boolean).join(" ")} is done. <${rt.baseUrl}/issues/${identifier}>`;

  const messageId = await postEmbedWithId(ctx, lead.token, channelId, { content, allowed_mentions: NO_MENTIONS });
  if (!messageId) {
    ctx.logger.warn("accomplishment: failed to post to Discord", {
      issueId: event.entityId,
      companyId: event.companyId,
      channelId,
    });
    // Release the claim, so the next update to this done issue tries again.
    await releaseClaim(ctx, scope, previousMarker);
    return;
  }

  await ctx.activity.log({
    companyId: event.companyId,
    message: `Posted accomplishment ${identifier} to Discord`,
    entityType: "plugin",
    entityId: event.entityId,
  });
}

type MilestoneKind = "goal" | "project";

const MILESTONE_STATUS: Record<MilestoneKind, string> = { goal: "achieved", project: "completed" };
const MILESTONE_LABEL: Record<MilestoneKind, string> = { goal: "Goal achieved", project: "Project completed" };

/**
 * Outbound item 5 from the spec's "Message flow": a goal reaches `achieved`,
 * or a project reaches `completed`. The bot of the goal's `ownerAgentId` or
 * the project's `leadAgentId` posts one line in the milestones channel,
 * matched on `agentId` or `alsoForAgentIds`; with no match, the default bot.
 *
 * Neither event carries the previous status. `goal.updated` carries the PATCH
 * body, so `status` is present only when the update set it. `project.updated`
 * carries only `changedKeys`, with no status at all. So an update that did
 * not name `status` is skipped with no read. For one that did, the plugin
 * reads the entity for its current status and owner, and keeps a per-entity
 * marker in plugin state: it posts when the entity is at its end status and
 * the marker is not set, and clears the marker when the status moves away,
 * so a later return posts again.
 */
async function notifyMilestone(
  ctx: PluginContext,
  rt: DiscordRuntime,
  event: PluginEvent,
  kind: MilestoneKind,
): Promise<void> {
  const channelId = rt.milestonesChannelId;
  const entityId = event.entityId;
  if (!channelId || !entityId) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const touchedStatus =
    kind === "goal"
      ? typeof payload.status === "string"
      : Array.isArray(payload.changedKeys) && payload.changedKeys.includes("status");
  if (!touchedStatus) return;

  let current: { status: string; name: string; agentId: string | null } | null;
  try {
    if (kind === "goal") {
      const goal = await ctx.goals.get(entityId, event.companyId);
      current = goal ? { status: goal.status, name: goal.title, agentId: goal.ownerAgentId } : null;
    } else {
      const project = await ctx.projects.get(entityId, event.companyId);
      current = project ? { status: project.status, name: project.name, agentId: project.leadAgentId } : null;
    }
  } catch (error) {
    ctx.logger.warn(`milestone: could not read the ${kind}; posting nothing`, {
      entityId,
      companyId: event.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!current) {
    ctx.logger.warn(`milestone: the ${kind} was not found; posting nothing`, { entityId, companyId: event.companyId });
    return;
  }

  const endStatus = MILESTONE_STATUS[kind];
  const scope = { scopeKind: "instance" as const, stateKey: `milestone_posted_${kind}_${entityId}` };
  const posted = await ctx.state.get(scope);
  if (current.status !== endStatus) {
    if (posted != null) await ctx.state.delete(scope);
    return;
  }
  if (posted != null) return;
  // Claim before the post, so a second handler for the same change skips.
  await ctx.state.set(scope, endStatus);

  const bot = resolveOutboundBot(rt, current.agentId);
  const content = `🏁 ${MILESTONE_LABEL[kind]}: ${oneLine(current.name)}`;
  const messageId = await postEmbedWithId(ctx, bot.token, channelId, { content, allowed_mentions: NO_MENTIONS });
  if (!messageId) {
    ctx.logger.warn(`milestone: failed to post the ${kind} to Discord`, {
      entityId,
      companyId: event.companyId,
      channelId,
    });
    // Release the claim, so the next status update to this entity tries again.
    await releaseClaim(ctx, scope, null);
    return;
  }

  await ctx.activity.log({
    companyId: event.companyId,
    message: `Posted ${kind} milestone to Discord`,
    entityType: "plugin",
    entityId,
  });
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

/**
 * Company-scoped state key: the issue of the thread Hanna last replied in
 * (plan item 9). Written only from a reply — typed or a voice-message
 * attachment (item 8), both threadKey-prefixed "reply:" — never from a live
 * #talk utterance itself, so an utterance never becomes its own target.
 */
const LAST_REPLIED_THREAD_STATE_KEY = "last_replied_thread";

/** Company-scoped state key caching the standing voice-inbox issue this install created. */
const VOICE_INBOX_ISSUE_STATE_KEY = "voice_inbox_issue_id";

const VOICE_INBOX_ISSUE_TITLE = "Hanna voice inbox";

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
    // mapping to inherit. Two destinations, in order (plan item 9):
    //
    // First: the issue of the thread Hanna last replied in — written only by
    // an actual reply (typed, or a voice-message attachment), scoped to the
    // company that owns this install, never read across a company boundary.
    const lastReplied = (await ctx.state.get({
      scopeKind: "company",
      scopeId: rt.companyId,
      stateKey: LAST_REPLIED_THREAD_STATE_KEY,
    })) as InboundDestination | null;
    if (lastReplied?.entityId) {
      return lastReplied;
    }

    // Then: the standing voice inbox — configured, or created on first need.
    const inboxIssueId = await resolveVoiceInboxIssueId(ctx, rt);
    if (!inboxIssueId) return null;
    return { entityId: inboxIssueId, entityType: "issue", companyId: rt.companyId };
  }

  return null;
}

/**
 * The standing "Hanna voice inbox" issue a live-voice utterance falls back to
 * when there is no thread Hanna last replied in (plan item 9).
 *
 * `voiceInboxIssueId` in plugin config wins outright when set. Otherwise the
 * id is cached in company-scoped plugin state after being created once, so a
 * install only ever creates one such issue — never re-created just because a
 * later utterance also finds no reply yet.
 */
async function resolveVoiceInboxIssueId(ctx: PluginContext, rt: DiscordRuntime): Promise<string | null> {
  const configured = trimToNull(rt.config.voiceInboxIssueId);
  if (configured) return configured;

  const cached = (await ctx.state.get({
    scopeKind: "company",
    scopeId: rt.companyId,
    stateKey: VOICE_INBOX_ISSUE_STATE_KEY,
  })) as string | null;
  if (cached) return cached;

  try {
    const agents = (await ctx.agents.list({ companyId: rt.companyId })) as Array<{ id: string; name: string }>;
    const emery = agents.find((a) => a.name === "Emery" || a.name.toLowerCase() === "emery");
    if (!emery) {
      ctx.logger.warn("voice: could not find Emery to assign the standing voice inbox issue", {
        companyId: rt.companyId,
      });
      return null;
    }

    const response = await paperclipFetch(
      `${rt.baseUrl}/api/companies/${rt.companyId}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: VOICE_INBOX_ISSUE_TITLE,
          description: "Standing inbox for a live #talk utterance with no thread to route to.",
          status: "todo",
          assigneeAgentId: emery.id,
        }),
      },
      rt.paperclipBoardApiKey,
    );
    const issue = (await response.json()) as { id?: string };
    if (!issue.id) return null;

    await ctx.state.set(
      { scopeKind: "company", scopeId: rt.companyId, stateKey: VOICE_INBOX_ISSUE_STATE_KEY },
      issue.id,
    );
    return issue.id;
  } catch (err) {
    ctx.logger.error("voice: failed to create the standing voice inbox issue", {
      companyId: rt.companyId,
      error: summarizeError(err, [rt.paperclipBoardApiKey]),
    });
    return null;
  }
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

  const mapping = await resolveInboundDestination(ctx, rt, input.threadKey);
  if (!mapping) return "no-destination";
  // Destination resolution reads plugin state (and, for voice with no reply
  // yet, may create the standing inbox issue), and a retirement can
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
    // Route to issue comment. No mention prefix: Paperclip's
    // shouldWakeAssigneeForIssueComment wakes the assignee on any non-self
    // comment while the issue is open, and a plain "@Name" is not parsed as a
    // mention there anyway (only "[@Name](agent://<id>)" is) — so the board
    // comment itself is the whole wake path, and the reply text is posted as
    // the author wrote it.
    const commentBody = text;
    try {
      await paperclipFetch(
        `${rt.baseUrl}/api/issues/${mapping.entityId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: commentBody,
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
      // A reply — typed, or a voice-message attachment (item 8) — is what
      // "the thread Hanna last replied in" means for live-voice routing (item
      // 9). A live #talk utterance never reaches this branch through a
      // "reply:" threadKey, so it never becomes its own target.
      if (input.threadKey.startsWith("reply:")) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: mapping.companyId, stateKey: LAST_REPLIED_THREAD_STATE_KEY },
          { entityId: mapping.entityId, entityType: mapping.entityType, companyId: mapping.companyId },
        );
      }
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

/** Discord's IS_VOICE_MESSAGE flag (message.flags bit 1<<13). */
const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;

/**
 * Bound on a voice-message attachment download. Discord voice messages are
 * short by nature; this is generous headroom, not a target.
 */
const MAX_VOICE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * The first attachment on a message that qualifies as spoken audio (plan item
 * 8): its own content type says audio/*, or the message itself carries
 * Discord's voice-message flag (some voice-message attachments report a
 * generic or missing content type). Returns null when nothing qualifies, so
 * the caller falls through to the ordinary typed-text path.
 */
function findQualifyingVoiceAttachment(message: MessageCreateEvent): DiscordMessageAttachment | null {
  const attachments = message.attachments ?? [];
  const isVoiceMessage =
    typeof message.flags === "number" && (message.flags & DISCORD_VOICE_MESSAGE_FLAG) !== 0;
  for (const attachment of attachments) {
    const contentType = attachment.content_type?.toLowerCase() ?? "";
    if (contentType.startsWith("audio/") || isVoiceMessage) {
      return attachment;
    }
  }
  return null;
}

/**
 * Discord's own CDN hosts for message attachments. An attachment URL that
 * Discord itself did not point at one of these is not trusted — the
 * attachment record on a message is client-suppliable metadata, not
 * something Discord signed off on.
 */
const ALLOWED_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** https, and a host on the allowlist above — nothing else is fetched. */
function isAllowedAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_ATTACHMENT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** The host of a URL, safe to log even when the URL itself should not be. */
function safeUrlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable URL)";
  }
}

/** Ceiling on one attachment download, so a stalled or slow host cannot hang the handler forever. */
const VOICE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Download one Discord attachment: only from Discord's own CDN, over https,
 * bounded on both the size Discord reports up front and the size actually
 * received — a lying or stale metadata field must not be trusted on its own,
 * and that bound is enforced WHILE STREAMING, not after buffering the whole
 * body, so a response that never stops sending bytes is aborted the moment it
 * crosses the bound rather than after it has already been held in memory.
 * Returns null (never throws) on anything that stops the download, so a bad
 * attachment degrades to "nothing transcribed", not a broken message handler.
 */
/** Context every inbound-drop log carries, so a drop is diagnosable without reading the message content. */
type InboundLogContext = { channelId: string; threadKey: string; author: string };

async function downloadVoiceAttachment(
  ctx: PluginContext,
  attachment: DiscordMessageAttachment,
  logContext: InboundLogContext,
): Promise<Buffer | null> {
  if (attachment.size > MAX_VOICE_ATTACHMENT_BYTES) {
    ctx.logger.warn("voice-message: attachment exceeds the size bound, dropping", {
      size: attachment.size,
      maxBytes: MAX_VOICE_ATTACHMENT_BYTES,
      ...logContext,
    });
    return null;
  }
  if (!isAllowedAttachmentUrl(attachment.url)) {
    ctx.logger.warn("voice-message: attachment URL is not an allowed Discord CDN host, dropping", {
      host: safeUrlHost(attachment.url),
      ...logContext,
    });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await ctx.http.fetch(attachment.url, { signal: controller.signal });
    if (!response.ok) {
      ctx.logger.warn("voice-message: failed to download the audio attachment", {
        status: response.status,
        ...logContext,
      });
      return null;
    }

    const reader = (response.body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null)
      ?.getReader?.();
    if (!reader) {
      // No streaming body from this fetch implementation — the upfront size
      // check above is still the bound, just not a streaming one.
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_VOICE_ATTACHMENT_BYTES) {
        ctx.logger.warn("voice-message: downloaded audio exceeded the size bound, dropping", {
          bytes: arrayBuffer.byteLength,
          maxBytes: MAX_VOICE_ATTACHMENT_BYTES,
          ...logContext,
        });
        return null;
      }
      return Buffer.from(arrayBuffer);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_VOICE_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => {});
        ctx.logger.warn("voice-message: downloaded audio exceeded the size bound mid-stream, dropping", {
          maxBytes: MAX_VOICE_ATTACHMENT_BYTES,
          ...logContext,
        });
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (controller.signal.aborted) {
      ctx.logger.warn("voice-message: attachment download timed out, dropping", {
        timeoutMs: VOICE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
        ...logContext,
      });
      return null;
    }
    ctx.logger.warn("voice-message: attachment download failed", { error: summarizeError(err), ...logContext });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A voice message from the allowed author, as a reply in a thread: download,
 * transcribe locally, then route through the SAME ingress a typed reply uses.
 * The comment carries the transcript and a link to the audio (spec's "Voice
 * in"); `ingestInbound` itself is untouched.
 */
async function handleVoiceMessageReply(
  ctx: PluginContext,
  rt: DiscordRuntime,
  message: MessageCreateEvent,
  attachment: DiscordMessageAttachment,
  threadKey: string,
): Promise<void> {
  const author = `discord:${message.author.username}`;
  const logContext: InboundLogContext = { channelId: message.channel_id, threadKey, author };

  const audio = await downloadVoiceAttachment(ctx, attachment, logContext);
  if (!audio) return;

  const sttAdapter = new WhisperSTTAdapter({
    binaryPath: rt.config.whisperBinaryPath,
    ffmpegPath: rt.config.ffmpegPath,
    modelPath: rt.config.whisperModelPath,
    language: rt.config.whisperLanguage,
  });

  let transcript: string;
  try {
    transcript = await sttAdapter.transcribeBuffer(audio, attachment.filename);
  } catch (err) {
    ctx.logger.warn("voice-message: transcription failed", { error: summarizeError(err), ...logContext });
    return;
  }

  const outcome = await ingestInbound(ctx, rt, {
    channelId: message.channel_id,
    author,
    authorLabel: message.author.username,
    text: `${transcript}\n\n${attachment.url}`,
    threadKey,
  });
  await reportInboundOutcome(ctx, rt, outcome, logContext);
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
  // The author allowlist: everyone but the configured operator is dropped.
  // This is a MESSAGE_CREATE with no interaction to respond to, so a log is
  // the only trace — logged with the author and channel, never the content.
  if (!isAllowedInboundAuthor(rt, message.author.id)) {
    ctx.logger.info("handleMessageCreate: dropping a message from an author who is not the configured operator", {
      authorId: message.author.id,
      channelId: message.channel_id,
    });
    return;
  }
  // Only handle replies to other messages
  if (!message.message_reference?.message_id) return;

  const refChannelId = message.message_reference.channel_id ?? message.channel_id;
  const refMessageId = message.message_reference.message_id;
  const threadKey = replyThreadKey(refChannelId, refMessageId);

  // A voice message (plan item 8) takes a different path — local transcription
  // first — then joins the same ingress a typed reply uses. Anything else, the
  // ordinary typed-text path, unchanged.
  const voiceAttachment = findQualifyingVoiceAttachment(message);
  if (voiceAttachment) {
    await handleVoiceMessageReply(ctx, rt, message, voiceAttachment, threadKey);
    return;
  }

  const author = `discord:${message.author.username}`;
  const outcome = await ingestInbound(ctx, rt, {
    channelId: message.channel_id,
    author,
    authorLabel: message.author.username,
    text: message.content ?? "",
    threadKey,
  });
  await reportInboundOutcome(ctx, rt, outcome, { channelId: message.channel_id, threadKey, author });
}

/**
 * Log a non-"routed" `ingestInbound` outcome, mirroring
 * `reportVoiceIngestOutcome`'s "empty"/"stale" exclusion (they say nothing
 * diagnosable — an empty reply has no missing destination to report, and a
 * stale one belongs to an owner that no longer exists). For "no-destination"
 * and "rejected", ALSO tells the author in the same Discord channel: a reply
 * that never reached Paperclip must not look, from Discord's side, exactly
 * like one that did.
 */
async function reportInboundOutcome(
  ctx: PluginContext,
  rt: DiscordRuntime,
  outcome: InboundOutcome,
  context: InboundLogContext,
): Promise<void> {
  if (outcome === "routed" || outcome === "empty" || outcome === "stale") return;

  ctx.logger.info("inbound reply did not reach an issue", { outcome, ...context });

  const note =
    outcome === "no-destination"
      ? "This reply did not reach a Paperclip issue: no destination is configured for this thread."
      : "This reply did not reach a Paperclip issue: the destination rejected the comment.";
  await postEmbed(ctx, rt.token, context.channelId, { content: note });
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
  for (const bot of previous.agentBots ?? []) {
    try {
      bot.gateway?.close();
    } catch (err) {
      ctx.logger.debug("Closing a retired agent bot gateway failed", {
        agentId: bot.agentId,
        error: summarizeError(err),
      });
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
/**
 * Tear down and rebuild the resolved agent bot map for this runtime.
 *
 * Every previous connection is superseded here — a config save that drops or
 * rotates an entry must not leave an orphaned socket running under a stale
 * token. An entry with an unresolvable token or a failed connection is
 * skipped for presence, never fatal: it still participates in outbound
 * routing via its token once resolved (`resolveOutboundBot` falls back to the
 * default bot when there is no match at all).
 */
async function resolveAgentBots(
  ctx: PluginContext,
  companyId: string,
  entries: NonNullable<DiscordConfig["agentBots"]>,
  previous: DiscordRuntime["agentBots"],
): Promise<DiscordRuntime["agentBots"]> {
  // A shared token (see below) means two resolved entries can point at the
  // SAME gateway object; close each live connection at most once.
  const alreadyClosed = new Set<GatewayHandle>();
  for (const prev of previous) {
    if (!prev.gateway || alreadyClosed.has(prev.gateway)) continue;
    alreadyClosed.add(prev.gateway);
    try {
      prev.gateway.close();
    } catch (err) {
      ctx.logger.debug("Closing a superseded agent bot gateway failed", {
        agentId: prev.agentId,
        error: summarizeError(err),
      });
    }
  }

  /** Label an entry for a log line by its own configured agent id, or its position when that itself is unusable. */
  const entryLabel = (entry: { agentId?: unknown }, index: number): string =>
    normalizeDiscordId(entry?.agentId) ?? `entry #${index}`;

  // Claim every agent id an entry names — its own agentId, then
  // alsoForAgentIds, in that order — against the FIRST entry to claim it.
  // Checked across ALL entries and within one entry's own list alike (a
  // repeated or self-referential id is exactly as much a config error as two
  // leads both naming the same worker). A later claim never moves the work
  // to a second bot: it is dropped, and logged.
  const claimedBy = new Map<string, number>();
  const effectiveIds: string[][] = entries.map(() => []);
  entries.forEach((entry, index) => {
    const alsoFor = Array.isArray(entry?.alsoForAgentIds) ? entry.alsoForAgentIds : [];
    const claims = [entry?.agentId, ...alsoFor]
      .map((id) => normalizeDiscordId(id))
      .filter((id): id is string => id !== null);
    for (const id of claims) {
      const existingIndex = claimedBy.get(id);
      if (existingIndex === undefined) {
        claimedBy.set(id, index);
        effectiveIds[index]!.push(id);
        continue;
      }
      ctx.logger.warn("agentBots: agent id claimed by more than one entry; the first entry wins", {
        agentId: id,
        firstEntry: entryLabel(entries[existingIndex]!, existingIndex),
        droppedEntry: entryLabel(entry, index),
      });
    }
  });

  const resolved: DiscordRuntime["agentBots"] = [];
  // One Gateway connection per resolved TOKEN, however many entries share it
  // (a copy-pasted botTokenRef, or two secrets holding the same value).
  const gatewayByToken = new Map<string, GatewayHandle | null>();
  const firstAgentIdForToken = new Map<string, string>();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const agentId = normalizeDiscordId(entry?.agentId);
    const channelId = normalizeDiscordId(entry?.channelId);
    const binding = toSecretRefBinding(entry?.botTokenRef);
    if (!agentId || !channelId || !binding) {
      ctx.logger.warn(
        "Skipping an agentBots entry with a missing agentId, channelId, or a usable botTokenRef",
        { agentId },
      );
      continue;
    }

    let token: string;
    try {
      token = await ctx.secrets.resolve(binding, { companyId, configPath: "agentBots.botTokenRef" });
    } catch (err) {
      ctx.logger.warn(
        "Could not resolve an agent bot token; that agent's outbound posts fall back to the default bot",
        { agentId, error: summarizeError(err, [entry?.botTokenRef, binding.secretId]) },
      );
      continue;
    }

    let gateway: GatewayHandle | null;
    if (gatewayByToken.has(token)) {
      gateway = gatewayByToken.get(token) ?? null;
      ctx.logger.warn("agentBots: two entries resolve to the same bot token; reusing one Gateway connection", {
        agentId,
        sharedWithAgentId: firstAgentIdForToken.get(token),
      });
    } else {
      gateway = null;
      try {
        // listenForMessages is false: Hanna's replies reach Paperclip over the
        // single default-bot gateway already listening in this guild (see
        // "Server layout" — every bot sits in the one private server), so a
        // second listener here would only duplicate MESSAGE_CREATE handling.
        // This connection exists so the agent's bot user shows online and so a
        // REST post through its token has a live session behind it.
        gateway = await connectGateway(
          ctx,
          token,
          async () =>
            respondToInteraction({
              type: 4,
              content: "This bot does not handle commands here.",
              ephemeral: true,
            }),
          undefined,
          { listenForMessages: false },
        );
      } catch (err) {
        ctx.logger.warn("Agent bot gateway connection failed; outbound posts still use its token", {
          agentId,
          error: summarizeError(err, [token]),
        });
      }
      gatewayByToken.set(token, gateway);
      firstAgentIdForToken.set(token, agentId);
    }

    // Effective alsoForAgentIds: everything this entry won its claim on,
    // minus its own leadAgentId (kept separately as `agentId` on the record).
    const alsoForAgentIds = effectiveIds[index]!.filter((id) => id !== agentId);
    resolved.push({ agentId, alsoForAgentIds, token, channelId, gateway });
  }

  return resolved;
}

/**
 * Which bot an outbound post about an agent's work should go through: that
 * agent's own bot when the agent bot map has one, else the default
 * `discordBotTokenRef` bot. With `agentBots` empty (upstream's default) this
 * always returns the default bot — unchanged from before the map existed.
 */
function resolveOutboundBot(
  rt: DiscordRuntime,
  agentId: string | null | undefined,
): { token: string; channelId: string | null } {
  if (agentId) {
    // A lead's own id, or a worker id explicitly listed under it
    // (alsoForAgentIds) — both post through the lead's bot and channel.
    const match = rt.agentBots.find((b) => b.agentId === agentId || b.alsoForAgentIds.includes(agentId));
    if (match) return { token: match.token, channelId: match.channelId };
  }
  return { token: rt.token, channelId: null };
}

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
  rt.hannaDiscordUserId = normalizeDiscordId(config.hannaDiscordUserId);
  rt.accomplishmentsChannelId = normalizeDiscordId(config.accomplishmentsChannelId);
  rt.milestonesChannelId = normalizeDiscordId(config.milestonesChannelId);
  if (rt.accomplishmentsChannelId && (config.agentBots ?? []).length === 0) {
    ctx.logger.warn(
      "accomplishmentsChannelId is set but agentBots is empty: only a lead in agentBots posts accomplishments, so none will post",
      { companyId },
    );
  }

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
      rt.gateway = await connectGateway(
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
          if (!isAllowedInboundAuthor(current, interactionAuthorId(interaction))) {
            return unauthorizedInteractionResponse();
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
      );
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

  // Connected after the default bot, so gatewayConnects (and any log ordering
  // depending on it) always shows the default bot first.
  rt.agentBots = await resolveAgentBots(ctx, companyId, config.agentBots ?? [], existing?.agentBots ?? []);

  if (runtimeHealth.status !== "ok") {
    setRuntimeHealth({ status: "ok" });
  }
  // Reapplied every delivery, same as voice's own note below: a configuration
  // save is not evidence that an operator is now configured.
  applyInboundAllowlistHealth(ctx, rt);

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
        "and DISCORD_VOICE_WEBHOOK_URL to enable it. Speech-to-text is local " +
        "Whisper, configured from the plugin's own settings, not the environment.",
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
    const { VoiceClient, createPluginDiscordAdapter, WhisperSTTAdapter } = await import("./voice/index.js");

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

    const sttAdapter = new WhisperSTTAdapter({
      binaryPath: rt.config.whisperBinaryPath,
      ffmpegPath: rt.config.ffmpegPath,
      modelPath: rt.config.whisperModelPath,
      language: rt.config.whisperLanguage,
    });

    const voiceClient = new VoiceClient(
      ctx,
      {
      guildId: voiceEnv.guildId,
      voiceChannelId: voiceEnv.voiceChannelId,
      textChannelWebhookUrl: voiceEnv.webhookUrl,
      relayUsername: voiceEnv.relayUsername,
      voiceAdapterCreator: createPluginDiscordAdapter(gatewayVoice),
      // Joining is driven by the gateway's own READY/RESUMED boundary, never by
      // this call returning: an op-4 sent before the socket has identified is
      // not deliverable, and @discordjs/voice does not retry one it could not send.
      onGatewayReady: (handler) => gatewayVoice.onGatewayReady(handler),
      // The FIRST allowlist check, in VoiceClient itself, before it even
      // subscribes to a speaker's audio — so a non-operator speaker is never
      // decoded, transcribed, or relayed (security review A2).
      isAllowedSpeaker: (userId) => isAllowedInboundAuthor(rt, userId),
      // Voice reaches Paperclip HERE, through the same ingress as a typed reply.
      // The webhook transcript is display only.
      ingestUtterance: async (utterance) => {
        // Checked again here: `rt` can be reconfigured between VoiceClient
        // construction and this call landing, and this is what actually
        // decides whether Paperclip gets written to.
        if (!isAllowedInboundAuthor(rt, utterance.userId)) {
          ctx.logger.info("voice: dropping an utterance from an author who is not the configured operator");
          return;
        }

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
      },
      sttAdapter,
    );
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
  relayUsername: string | undefined;
} | null {
  const guildId = process.env.DISCORD_VOICE_GUILD_ID;
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  const webhookUrl = process.env.DISCORD_VOICE_WEBHOOK_URL;
  if (!guildId || !voiceChannelId || !webhookUrl) return null;
  return {
    guildId,
    voiceChannelId,
    webhookUrl,
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
      for (const bot of runtime?.agentBots ?? []) {
        bot.gateway?.close();
      }
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

    // Outbound trigger 1 (spec's "Message flow"): an issue moved to
    // `in_review` or `blocked`, assigned to `local-board`, wakes Hanna. Opt-in
    // via `rt.hannaDiscordUserId` — see `notifyBoardWake`.
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      const payload = await enrichIssueNotificationPayload(ctx, event);
      await notifyBoardWake(ctx, rt, event, payload);
    });

    // Outbound item 4: a lead's issue reaching `done` posts one line in the
    // accomplishments channel. Opt-in via accomplishmentsChannelId, and only a
    // lead in agentBots qualifies — see `notifyAccomplishment`.
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt || !rt.accomplishmentsChannelId || rt.agentBots.length === 0) return;
      const payload = await enrichIssueNotificationPayload(ctx, event);
      await notifyAccomplishment(ctx, rt, event, payload);
    });

    // Outbound item 5: a goal reaching `achieved` or a project reaching
    // `completed` posts one line in the milestones channel. Opt-in via
    // milestonesChannelId — see `notifyMilestone`.
    ctx.events.on("goal.updated", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      await notifyMilestone(ctx, rt, event, "goal");
    });

    ctx.events.on("project.updated", async (event: PluginEvent) => {
      const rt = await ensureRuntime(ctx, event.companyId);
      if (!rt) return;
      await notifyMilestone(ctx, rt, event, "project");
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

    // Phase 2's multi-agent tools (handoff_to_agent, discuss_with_agent) are
    // removed: the v1 runaway came from agents waking agents (see "What stays
    // off" in the spec), so no tool lets an agent hand off to, or discuss
    // with, another agent. Security review A5 went further: the handoff_/
    // disc_ button-click path in commands.ts no longer dispatches to
    // session-registry's handleHandoffButton/handleDiscussionButton at all —
    // both are refused with an ephemeral reply, so a stale or replayed
    // custom_id cannot complete one either.

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

    // register_custom_command and register_watch tools are removed (plan item
    // 6): no tool lets an agent register a command or a watch. Security
    // review A5 went further for watches specifically: this job used to still
    // evaluate whatever watch a PREVIOUS install had registered, and a match
    // invoked an agent with no human step in between — a residual
    // agent-to-agent surface even with no tool left to register a new one.
    // It is now fully inert, unconditionally, regardless of config. The
    // manifest still lists the job (the host expects a handler for every job
    // it declares), and custom-commands.ts / proactive-suggestions.ts stay as
    // dead code paths rather than being torn out wholesale in this pass.
    ctx.jobs.register("check-watches", async () => {
      ctx.logger.debug("check-watches: retired — proactive suggestions are removed from this fork");
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
      const rt = await ensureRuntime(ctx);
      const cmdCtx = rt?.cmdCtx ?? null;

      if (!ctx || !cmdCtx) {
        // Return a valid Discord interaction response even before setup completes.
        // The host framework forwards the return value as the HTTP response body.
        return respondToInteraction({
          type: 4,
          content: "Plugin is still starting up. Please try again in a moment.",
          ephemeral: true,
        }) as unknown as void;
      }

      if (!isAllowedInboundAuthor(rt!, interactionAuthorId(body))) {
        return unauthorizedInteractionResponse() as unknown as void;
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
