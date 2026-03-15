import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import {
  postEmbed,
  getApplicationId,
  registerSlashCommands,
} from "./discord-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "./formatters.js";
import { handleInteraction, SLASH_COMMANDS } from "./commands.js";
import { runIntelligenceScan, runBackfill } from "./intelligence.js";
import { connectGateway } from "./gateway.js";

type DiscordConfig = {
  discordBotTokenRef: string;
  defaultGuildId: string;
  defaultChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  enableIntelligence: boolean;
  intelligenceChannelIds: string[];
  backfillDays: number;
};

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

    // --- Gateway connection for local interaction handling ---
    // The webhook-based interaction endpoint requires a public URL.
    // The Gateway receives INTERACTION_CREATE events over WebSocket,
    // so button clicks and slash commands work in local deployments too.
    const gateway = await connectGateway(ctx, token, async (interaction) => {
      return handleInteraction(ctx, interaction as any);
    });

    // Clean up Gateway connection when plugin stops
    ctx.events.on("plugin.stopping", async () => {
      gateway.close();
    });

    // --- Event subscriptions (notification pattern from Slack plugin) ---

    const notify = async (event: PluginEvent, formatter: (e: PluginEvent) => ReturnType<typeof formatIssueCreated>) => {
      const channelId = await resolveChannel(ctx, event.companyId, config.defaultChannelId);
      if (!channelId) return;
      const delivered = await postEmbed(ctx, token, channelId, formatter(event));
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
        notify(event, formatApprovalCreated),
      );
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError),
      );
    }

    // Always subscribe to run lifecycle for activity logging
    ctx.events.on("agent.run.started", (event: PluginEvent) =>
      notify(event, formatAgentRunStarted),
    );
    ctx.events.on("agent.run.finished", (event: PluginEvent) =>
      notify(event, formatAgentRunFinished),
    );

    // --- Per-company channel overrides ---

    ctx.data.register("channel-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord-channel",
      });
      return { channelId: saved ?? config.defaultChannelId };
    });

    ctx.actions.register("set-channel", async (params) => {
      const companyId = String(params.companyId);
      const channelId = String(params.channelId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "discord-channel" },
        channelId,
      );
      ctx.logger.info("Updated Discord channel mapping", { companyId, channelId });
      return { ok: true };
    });

    // --- Intelligence: agent-queryable tool ---

    ctx.tools.register(
      "discord_signals",
      {
        displayName: "Discord Signals",
        description:
          "Query recent community signals from Discord (feature requests, pain points, maintainer directives).",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Company ID to query signals for" },
            category: {
              type: "string",
              enum: ["feature_wish", "pain_point", "maintainer_directive", "sentiment"],
              description: "Filter signals by category (optional)",
            },
          },
          required: ["companyId"],
        },
      },
      async (params) => {
        const p = params as Record<string, unknown>;
        const companyId = String(p.companyId);
        const raw = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: "discord_intelligence",
        });
        if (!raw) return { content: JSON.stringify({ signals: [], lastScanned: null }) };

        const data = raw as { signals: Array<{ category: string }>; lastScanned: string };
        const category = p.category ? String(p.category) : null;
        const filtered = category
          ? data.signals.filter((s) => s.category === category)
          : data.signals;

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
          "default",
        );
      });
      ctx.logger.info("Intelligence scan job registered", {
        channels: config.intelligenceChannelIds.length,
      });
    }

    // --- Backfill: auto-run on first install ---

    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      const existing = await ctx.state.get({
        scopeKind: "company",
        scopeId: "default",
        stateKey: "discord_intelligence",
      }) as { backfillComplete?: boolean } | null;

      if (!existing?.backfillComplete) {
        ctx.logger.info("First install detected, starting historical backfill...");
        await runBackfill(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          "default",
          config.backfillDays ?? 90,
        );
      }

      // On-demand re-backfill action
      ctx.actions.register("trigger-backfill", async () => {
        // Clear the flag so backfill runs fresh
        await ctx.state.set(
          { scopeKind: "company", scopeId: "default", stateKey: "discord_intelligence" },
          { signals: [], backfillComplete: false },
        );
        const signals = await runBackfill(
          ctx,
          token,
          config.defaultGuildId,
          config.intelligenceChannelIds,
          "default",
          config.backfillDays ?? 90,
        );
        return { ok: true, signalsFound: signals.length };
      });
    }

    ctx.logger.info("Discord bot plugin started");
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey === WEBHOOK_KEYS.discordInteractions) {
      const body = input.parsedBody as Record<string, unknown>;
      if (!body) return;
      // Handle the interaction but don't return the result
      // (the webhook response is handled by the host)
      await handleInteraction(input as unknown as PluginContext, body as any);
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
