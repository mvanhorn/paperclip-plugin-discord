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
import { connectGateway, type MessageCreateEvent } from "./gateway.js";
import {
  handleAcpOutput,
  routeMessageToAgent,
  createAgentThread,
  spawnAgentInThread,
  closeAgentInThread,
  initiateHandoff,
  startDiscussion,
} from "./session-registry.js";
import { DiscordAdapter } from "./adapter.js";
import { processMediaMessage, type MediaAttachment } from "./media-pipeline.js";
import { registerCommand, parseCommandMessage, executeCommand, listCommands } from "./custom-commands.js";
import { registerWatch, checkWatches } from "./proactive-suggestions.js";

// Module-level state captured during setup() so onWebhook() can reuse it.
let _pluginCtx: PluginContext | null = null;
let _cmdCtx: CommandContext | null = null;

import { resolveCompanyId } from "./company-resolver.js";
import {
  type EscalationRecord,
  getEscalation,
  saveEscalation,
  trackPendingEscalation,
  untrackPendingEscalation,
  collectPendingEscalationIds,
} from "./escalation-state.js";

type DiscordConfig = {
  discordBotTokenRef: string;
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
};

type IssueNotificationPayload = Record<string, unknown>;

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

async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "discord-channel",
  });
  return (override as string) ?? fallback ?? null;
}

async function enrichIssueNotificationPayload(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<IssueNotificationPayload> {
  const payload = { ...(event.payload as IssueNotificationPayload) };
  if (event.entityType !== "issue" || !event.entityId) return payload;

  try {
    const issue = await ctx.issues.get(event.entityId, event.companyId) as {
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
      if (payload.completedAt == null && issue.completedAt) payload.completedAt = String(issue.completedAt);
      if (payload.updatedAt == null && issue.updatedAt) payload.updatedAt = String(issue.updatedAt);
      if (payload.projectName == null && issue.project?.name) payload.projectName = issue.project.name;
    }

    if (String(payload.status ?? "") === "done") {
      const comments = await ctx.issues.listComments(event.entityId, event.companyId) as Array<{
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
          payload.completedBy = lastComment.authorUserId || lastComment.authorAgentId || null;
        }
      }

      if (payload.completedBy == null) {
        payload.completedBy = payload.assigneeUserId ?? payload.assigneeAgentId ?? payload.agentName ?? null;
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

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    ctx.logger.info(`Discord plugin config: ${JSON.stringify(rawConfig)}`);
    const config = {
      ...DEFAULT_CONFIG,
      ...(rawConfig as Record<string, unknown>),
    } as DiscordConfig;

    if (!config.discordBotTokenRef) {
      ctx.logger.warn("No discordBotTokenRef configured, plugin disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.discordBotTokenRef);
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const retentionDays = config.intelligenceRetentionDays || 30;

    // Company ID is resolved lazily on first /clip command or job invocation,
    // NOT during setup — startup-time API calls can cause worker activation to fail.
    const companyId = "default"; // placeholder; jobs use resolveCompanyId(ctx) at runtime

    const cmdCtx: CommandContext = {
      baseUrl,
      companyId,
      token,
      defaultChannelId: config.defaultChannelId,
      pluginCtx: ctx,
    };

    // Store context at module level so onWebhook() can reuse it.
    _pluginCtx = ctx;
    _cmdCtx = cmdCtx;

    // --- Register slash commands with Discord ---
    if (config.defaultGuildId) {
      const appId = await getApplicationId(ctx, token);
      if (appId) {
        const registered = await registerSlashCommands(
          ctx,
          token,
          appId,
          config.defaultGuildId,
          SLASH_COMMANDS,
        );
        if (registered) {
          ctx.logger.info("Slash commands registered with Discord");
        }
      }
    }

    // --- Reply routing handler for inbound messages ---
    async function handleMessageCreate(message: MessageCreateEvent): Promise<void> {
      if (config.enableInbound === false) return;
      // Ignore bot messages
      if (message.author.bot) return;
      // Only handle replies to other messages
      if (!message.message_reference?.message_id) return;

      const refChannelId = message.message_reference.channel_id ?? message.channel_id;
      const refMessageId = message.message_reference.message_id;

      const mapping = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `msg_${refChannelId}_${refMessageId}`,
      }) as { entityId: string; entityType: string; companyId: string } | null;

      if (!mapping) return;

      const text = message.content;
      if (!text?.trim()) return;

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

        if (record && record.status === "pending") {
          record.status = "resolved";
          record.resolvedAt = new Date().toISOString();
          record.resolvedBy = `discord:${message.author.username}`;
          record.resolution = "human_reply";
          await ctx.state.set(
            { scopeKind: "company", scopeId: escalationCompanyId, stateKey: `escalation_${mapping.entityId}` },
            record,
          );
          await ctx.metrics.write(METRIC_NAMES.escalationsResolved, 1);
          ctx.events.emit("escalation-resolved", mapping.companyId, {
            escalationId: mapping.entityId,
            action: "human_reply",
            resolvedBy: message.author.username,
            responseText: text,
          });
        }

        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Discord reply to escalation", {
          escalationId: mapping.entityId,
          from: message.author.username,
        });
      } else if (mapping.entityType === "issue") {
        // Route to issue comment
        try {
          await paperclipFetch(
            `${baseUrl}/api/issues/${mapping.entityId}/comments`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                body: text,
                authorUserId: `discord:${message.author.username}`,
              }),
            },
          );
          await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
          ctx.logger.info("Routed Discord reply to issue comment", {
            issueId: mapping.entityId,
            from: message.author.username,
          });
        } catch (err) {
          ctx.logger.error("Failed to route inbound message", { error: String(err) });
        }
      }
    }

    const gatewayNeedsMessages =
      config.enableInbound !== false ||
      config.enableMediaPipeline === true ||
      config.enableCustomCommands === true ||
      config.enableProactiveSuggestions === true ||
      config.enableIntelligence === true;

    // --- Gateway connection for real-time interaction handling ---
    const gateway = await connectGateway(
      ctx,
      token,
      async (interaction) => {
        return handleInteraction(ctx, interaction as any, cmdCtx);
      },
      gatewayNeedsMessages ? handleMessageCreate : undefined,
      {
        listenForMessages: gatewayNeedsMessages,
        includeMessageContent: gatewayNeedsMessages,
      },
    );

    ctx.events.on("plugin.stopping", async () => {
      gateway.close();
    });

    // --- ACP bridge: listen for cross-plugin ACP output events ---
    ctx.events.on(`${ACP_PLUGIN_EVENT_PREFIX}.output`, async (event: PluginEvent) => {
      const payload = event.payload as {
        sessionId: string;
        threadId: string;
        agentName: string;
        output: string;
        status?: "running" | "completed" | "failed";
      };
      await handleAcpOutput(ctx, token, payload);
    });

    // --- Event deduplication ---
    // The runtime may redeliver events (retries, replays). Track recently
    // processed eventIds so each event produces at most one Discord message.
    const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const seenEvents = new Map<string, number>(); // eventId → timestamp

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

    // --- Event subscriptions ---

    const resolveTopicChannel = async (event: PluginEvent): Promise<string | null> => {
      if (!config.topicRouting) return null;
      const payload = event.payload as Record<string, unknown>;
      const projectName = payload.projectName ? String(payload.projectName) : null;
      if (!projectName) return null;

      const channelMap = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: "channel-project-map",
      })) as Record<string, string> | null;

      return channelMap?.[projectName] ?? null;
    };

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, baseUrl?: string) => ReturnType<typeof formatIssueCreated>,
      overrideChannelId?: string,
    ) => {
      if (isDuplicate(event.eventId)) {
        ctx.logger.debug(`Skipping duplicate event ${event.eventType} (${event.eventId})`);
        return;
      }

      const topicChannel = overrideChannelId ? null : await resolveTopicChannel(event);
      const channelId = await resolveChannel(ctx, event.companyId, topicChannel || overrideChannelId || config.defaultChannelId);
      if (!channelId) return;

      const message = formatter(event, baseUrl);
      const messageId = await postEmbedWithId(ctx, token, channelId, message);

      if (messageId) {
        // Store message mapping for reply routing
        if (config.enableInbound !== false) {
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
      }
    };

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", (event: PluginEvent) =>
        notify(event, formatIssueCreated),
      );
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
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

        await notify({ ...event, payload }, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", (event: PluginEvent) =>
        notify(event, formatApprovalCreated, config.approvalsChannelId),
      );
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatSessionFailure, config.errorsChannelId),
      );
    }

    ctx.events.on("agent.run.started", (event: PluginEvent) =>
      notify(event, formatAgentRunStarted, config.bdPipelineChannelId),
    );
    ctx.events.on("agent.run.finished", (event: PluginEvent) =>
      notify(event, formatAgentRunFinished, config.bdPipelineChannelId),
    );

    // ===================================================================
    // Phase 1: Escalation - human-in-the-loop support
    // ===================================================================

    const adapter = new DiscordAdapter(ctx, token);
    const escalationChannelId = config.escalationChannelId || config.defaultChannelId;
    const escalationTimeoutMs = (config.escalationTimeoutMinutes || 30) * 60 * 1000;

    // Escalation state helpers are imported from ./escalation-state.js
    // Local wrappers that close over ctx for call-site convenience:
    const _getEscalation = (id: string, cid?: string) => getEscalation(ctx, id, cid);
    const _saveEscalation = (r: EscalationRecord) => saveEscalation(ctx, r);
    const _trackPending = (id: string, cid?: string) => trackPendingEscalation(ctx, id, cid);
    const _untrackPending = (id: string, cid?: string) => untrackPendingEscalation(ctx, id, cid);

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

      if (payload.suggestedReply) {
        buttons.push({
          type: 2,
          style: 3,
          label: "Use Suggested Reply",
          custom_id: `esc_suggest_${payload.escalationId}`,
        });
      }

      buttons.push(
        { type: 2, style: 1, label: "Reply to Customer", custom_id: `esc_reply_${payload.escalationId}` },
        { type: 2, style: 2, label: "Override Agent", custom_id: `esc_override_${payload.escalationId}` },
        { type: 2, style: 4, label: "Dismiss", custom_id: `esc_dismiss_${payload.escalationId}` },
      );

      const components: DiscordComponent[] = [{ type: 1, components: buttons }];
      return { embeds, components };
    }

    if (config.enableEscalations !== false) {
      ctx.events.on(`plugin.${PLUGIN_ID}.escalation-created`, async (event: PluginEvent) => {
        if (isDuplicate(event.eventId)) {
          ctx.logger.debug(`Skipping duplicate escalation event (${event.eventId})`);
          return;
        }

        const payload = event.payload as unknown as EscalationCreatedPayload;
        const escalationId = payload.escalationId || event.entityId || "";
        payload.escalationId = escalationId;

        const channelId = await resolveChannel(ctx, event.companyId, escalationChannelId);
        if (!channelId) return;

        const { embeds, components } = buildEscalationEmbed(payload);
        const messageId = await adapter.sendButtons(channelId, embeds, components);

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
    }

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
            companyId: { type: "string", description: "Company ID" },
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
        const escalationCompanyId = String(p.companyId || runCtx.companyId);

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

        const channelId = await resolveChannel(ctx, escalationCompanyId, escalationChannelId);
        if (!channelId) {
          return { error: "No escalation channel configured." };
        }

        const { embeds, components } = buildEscalationEmbed(payload);
        const messageId = await adapter.sendButtons(channelId, embeds, components);

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
        const p = params as Record<string, unknown>;
        const result = await initiateHandoff(
          ctx,
          token,
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
        const p = params as Record<string, unknown>;
        const result = await startDiscussion(
          ctx,
          token,
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
      const jobCompanyId = await resolveCompanyId(ctx);
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
        if (elapsed < escalationTimeoutMs) continue;

        record.status = "timed_out";
        record.resolvedAt = new Date().toISOString();
        await _saveEscalation(record);
        await _untrackPending(escalationId, record.companyId || jobCompanyId);
        await ctx.metrics.write(METRIC_NAMES.escalationsTimedOut, 1);

        await adapter.editMessage(record.channelId, record.messageId, {
          embeds: [
            {
              title: `Escalation from ${record.agentName} - TIMED OUT`,
              description: `This escalation was not resolved within ${config.escalationTimeoutMinutes || 30} minutes.`,
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
      const jobCompanyId = await resolveCompanyId(ctx);
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
          config.errorsChannelId || config.defaultChannelId,
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

        await postEmbed(ctx, token, channelId, message);

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

    if (config.enableCustomCommands !== false) {
      ctx.tools.register(
        "register_custom_command",
        {
          displayName: "Register Custom Command",
          description: "Register a custom !command for Discord users to invoke.",
          parametersSchema: {
            type: "object",
            properties: {
              companyId: { type: "string", description: "Company ID" },
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
          const p = params as Record<string, unknown>;
          const result = await registerCommand(
            ctx,
            String(p.companyId || runCtx.companyId),
            String(p.command),
            String(p.description),
            (p.parameters as Array<{ name: string; description: string; required: boolean }>) ?? [],
            runCtx.agentId,
            String(p.agentName ?? runCtx.agentId),
          );
          return { content: JSON.stringify(result) };
        },
      );
    }

    // ===================================================================
    // Phase 5: Proactive Suggestions tool (3-arg register)
    // ===================================================================

    if (config.enableProactiveSuggestions !== false) {
      ctx.tools.register(
        "register_watch",
        {
          displayName: "Register Watch",
          description: "Register a watch condition that fires proactive suggestions.",
          parametersSchema: {
            type: "object",
            properties: {
              companyId: { type: "string", description: "Company ID" },
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
          const p = params as Record<string, unknown>;
          const result = await registerWatch(
            ctx,
            String(p.companyId || runCtx.companyId),
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

    }

    ctx.jobs.register("check-watches", async () => {
      if (config.enableProactiveSuggestions === false) {
        ctx.logger.debug("check-watches: proactive suggestions disabled, skipping");
        return;
      }
      const cid = await resolveCompanyId(ctx);
      await checkWatches(ctx, token, cid, config.defaultChannelId);
    });

    // ===================================================================
    // Daily Digest Job
    // ===================================================================

    const effectiveDigestMode = config.digestMode ?? "off";

    ctx.jobs.register("discord-daily-digest", async () => {
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
      const firstHour = parseHour(config.dailyDigestTime || "09:00");
      const secondHour = parseHour(config.bidailySecondTime || "17:00");
      const tridailyHours = (config.tridailyTimes || "07:00,13:00,19:00")
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
        const channelId = await resolveChannel(ctx, company.id, config.defaultChannelId);
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
              { type: 2, style: 5, label: "View Dashboard", url: baseUrl },
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

            await postEmbed(ctx, token, channelId, { embeds, components: digestComponents });
            await ctx.metrics.write(METRIC_NAMES.digestSent, 1);
          } catch (err) {
            ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
            await postEmbed(ctx, token, channelId, {
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

    if (effectiveDigestMode === "off") {
      ctx.logger.debug("Daily digest job registered (inactive)", { mode: effectiveDigestMode });
    } else {
      ctx.logger.info("Daily digest job registered", { mode: effectiveDigestMode });
    }

    // --- Per-company channel overrides ---

    ctx.data.register("channel-mapping", async (params) => {
      const cid = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: cid,
        stateKey: "discord-channel",
      });
      return { channelId: saved ?? config.defaultChannelId };
    });

    ctx.actions.register("set-channel", async (params) => {
      const cid = String(params.companyId);
      const channelId = String(params.channelId);
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
            companyId: { type: "string", description: "Company ID" },
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
        const cid = String(p.companyId || runCtx.companyId);
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
      if (!config.enableIntelligence || !config.intelligenceChannelIds?.length) {
        ctx.logger.debug("discord-intelligence-scan: intelligence disabled or no channels configured, skipping");
        return;
      }
      const cid = await resolveCompanyId(ctx);
      await runIntelligenceScan(
        ctx,
        token,
        config.defaultGuildId,
        config.intelligenceChannelIds,
        cid,
        retentionDays,
      );
    });
    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      ctx.logger.info("Intelligence scan job registered", {
        channels: config.intelligenceChannelIds.length,
      });
    }

    // --- Backfill ---

    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      // Backfill also deferred to avoid startup-time company resolution.
      // It runs as an async task after setup completes.
      const tryBackfill = async () => {
        const cid = await resolveCompanyId(ctx);
        const existing = await ctx.state.get({
          scopeKind: "company",
          scopeId: cid,
          stateKey: "discord_intelligence",
        }) as { backfillComplete?: boolean } | null;

        if (!existing?.backfillComplete) {
          ctx.logger.info("First install detected, starting historical backfill...");
          await runBackfill(
            ctx,
            token,
            config.defaultGuildId,
            config.intelligenceChannelIds,
            cid,
            config.backfillDays ?? 90,
          );
        }
      };
      // Fire-and-forget so it doesn't block setup completion.
      tryBackfill().catch((err) => ctx.logger.warn("Backfill failed", { error: String(err) }));

      ctx.actions.register("trigger-backfill", async () => {
        const cid = await resolveCompanyId(ctx);
        await ctx.state.set(
          { scopeKind: "company", scopeId: cid, stateKey: "discord_intelligence" },
          { signals: [], backfillComplete: false },
        );
        const signals = await runBackfill(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          cid,
          config.backfillDays ?? 90,
        );
        return { ok: true, signalsFound: signals.length };
      });
    }

    ctx.logger.info("Discord bot plugin started (all 5 phases active)");
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey === WEBHOOK_KEYS.discordInteractions) {
      const body = input.parsedBody as Record<string, unknown>;
      if (!body) return;

      const ctx = _pluginCtx;
      const cmdCtx = _cmdCtx;

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
    if (!config.discordBotTokenRef || typeof config.discordBotTokenRef !== "string") {
      return { ok: false, errors: ["discordBotTokenRef is required"] };
    }
    if (!config.defaultChannelId || typeof config.defaultChannelId !== "string") {
      return { ok: false, errors: ["defaultChannelId is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

runWorker(plugin, import.meta.url);
