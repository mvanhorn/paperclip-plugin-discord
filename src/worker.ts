import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { COLORS, METRIC_NAMES, WEBHOOK_KEYS, ACP_PLUGIN_EVENT_PREFIX } from "./constants.js";
import {
  postEmbed,
  getApplicationId,
  registerSlashCommands,
  type DiscordEmbed,
  type DiscordComponent,
} from "./discord-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "./formatters.js";
import { handleInteraction, SLASH_COMMANDS, type CommandContext } from "./commands.js";
import { runIntelligenceScan, runBackfill } from "./intelligence.js";
import { connectGateway } from "./gateway.js";
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
};

interface EscalationRecord {
  escalationId: string;
  companyId: string;
  agentName: string;
  reason: string;
  confidenceScore?: number;
  agentReasoning?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  suggestedReply?: string;
  channelId: string;
  messageId: string;
  status: "pending" | "resolved" | "timed_out";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

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

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    ctx.logger.info(`Discord plugin config: ${JSON.stringify(rawConfig)}`);
    const config = rawConfig as unknown as DiscordConfig;

    if (!config.discordBotTokenRef) {
      ctx.logger.warn("No discordBotTokenRef configured, plugin disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.discordBotTokenRef);
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const retentionDays = config.intelligenceRetentionDays || 30;
    const companyId = "default";
    const cmdCtx: CommandContext = {
      baseUrl,
      companyId,
      token,
      defaultChannelId: config.defaultChannelId,
    };

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

    // --- Gateway connection for real-time interaction handling ---
    const gateway = await connectGateway(ctx, token, async (interaction) => {
      return handleInteraction(ctx, interaction as any, cmdCtx);
    });

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

    // --- Event subscriptions ---

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, baseUrl?: string) => ReturnType<typeof formatIssueCreated>,
      overrideChannelId?: string,
    ) => {
      const channelId = await resolveChannel(ctx, event.companyId, overrideChannelId || config.defaultChannelId);
      if (!channelId) return;
      const delivered = await postEmbed(ctx, token, channelId, formatter(event, baseUrl));
      if (delivered) {
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
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", (event: PluginEvent) =>
        notify(event, formatApprovalCreated, config.approvalsChannelId),
      );
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError, config.errorsChannelId),
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

    async function getEscalation(escalationId: string): Promise<EscalationRecord | null> {
      const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: `escalation_${escalationId}`,
      });
      return (raw as EscalationRecord) ?? null;
    }

    async function saveEscalation(record: EscalationRecord): Promise<void> {
      await ctx.state.set(
        { scopeKind: "company", scopeId: "default", stateKey: `escalation_${record.escalationId}` },
        record,
      );
    }

    async function trackPendingEscalation(escalationId: string): Promise<void> {
      const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: "escalation_pending_ids",
      });
      const ids = (raw as string[]) ?? [];
      if (!ids.includes(escalationId)) {
        ids.push(escalationId);
        await ctx.state.set(
          { scopeKind: "company", scopeId: "default", stateKey: "escalation_pending_ids" },
          ids,
        );
      }
    }

    async function untrackPendingEscalation(escalationId: string): Promise<void> {
      const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: "escalation_pending_ids",
      });
      const ids = (raw as string[]) ?? [];
      const filtered = ids.filter((id) => id !== escalationId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: "default", stateKey: "escalation_pending_ids" },
        filtered,
      );
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
      ctx.events.on("escalation.created", async (event: PluginEvent) => {
        const payload = event.payload as unknown as EscalationCreatedPayload;
        const escalationId = payload.escalationId || event.entityId;
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
          await saveEscalation(record);
          await trackPendingEscalation(escalationId);
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
          await saveEscalation(record);
          await trackPendingEscalation(escalationId);
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
      const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: "escalation_pending_ids",
      });
      const pendingIds = (raw as string[]) ?? [];
      if (pendingIds.length === 0) return;

      const now = Date.now();

      for (const escalationId of pendingIds) {
        const record = await getEscalation(escalationId);
        if (!record || record.status !== "pending") {
          await untrackPendingEscalation(escalationId);
          continue;
        }

        const elapsed = now - new Date(record.createdAt).getTime();
        if (elapsed < escalationTimeoutMs) continue;

        record.status = "timed_out";
        record.resolvedAt = new Date().toISOString();
        await saveEscalation(record);
        await untrackPendingEscalation(escalationId);
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

      ctx.jobs.register("check-watches", async () => {
        await checkWatches(ctx, token, companyId, config.defaultChannelId);
      });
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

    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      ctx.jobs.register("discord-intelligence-scan", async () => {
        await runIntelligenceScan(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          companyId,
          retentionDays,
        );
      });
      ctx.logger.info("Intelligence scan job registered", {
        channels: config.intelligenceChannelIds.length,
      });
    }

    // --- Backfill ---

    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      const existing = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord_intelligence",
      }) as { backfillComplete?: boolean } | null;

      if (!existing?.backfillComplete) {
        ctx.logger.info("First install detected, starting historical backfill...");
        await runBackfill(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          companyId,
          config.backfillDays ?? 90,
        );
      }

      ctx.actions.register("trigger-backfill", async () => {
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: "discord_intelligence" },
          { signals: [], backfillComplete: false },
        );
        const signals = await runBackfill(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          companyId,
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
      await handleInteraction(
        input as unknown as PluginContext,
        body as any,
        { baseUrl: "http://localhost:3100", companyId: "default", token: "", defaultChannelId: "" },
      );
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
