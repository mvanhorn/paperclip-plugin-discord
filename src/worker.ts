import {
  definePlugin,
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
import { runIntelligenceScan } from "./intelligence.js";

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

export default definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
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

    // --- Per-company channel overrides (data/action pattern from Slack plugin) ---

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

    ctx.tools.register({
      name: "discord_signals",
      description:
        "Query recent community signals from Discord (feature requests, pain points, maintainer directives).",
      parameters: {
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
      handler: async (params) => {
        const companyId = String(params.companyId);
        const raw = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: "discord_intelligence",
        });
        if (!raw) return { signals: [], lastScanned: null };

        const data = raw as { signals: Array<{ category: string }>; lastScanned: string };
        const category = params.category ? String(params.category) : null;
        const filtered = category
          ? data.signals.filter((s) => s.category === category)
          : data.signals;

        return { signals: filtered, lastScanned: data.lastScanned };
      },
    });

    // --- Intelligence: scheduled scan ---

    if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
      ctx.jobs.schedule({
        name: "discord-intelligence-scan",
        cron: "0 */6 * * *", // every 6 hours
        handler: async () => {
          // Scan for all companies (use default guild for now)
          // In a multi-company setup, each company would have its own guild config
          await runIntelligenceScan(
            ctx,
            token,
            config.defaultGuildId,
            config.intelligenceChannelIds,
            "default", // TODO: iterate companies
          );
        },
      });
      ctx.logger.info("Intelligence scanning scheduled (every 6h)", {
        channels: config.intelligenceChannelIds.length,
      });
    }

    ctx.logger.info("Discord bot plugin started");
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey === WEBHOOK_KEYS.discordInteractions) {
      const body = input.parsedBody as Record<string, unknown>;
      if (!body) return;

      // Discord sends interactions as JSON to the configured endpoint
      // We handle PING, slash commands, and button clicks
      return handleInteraction(input.ctx, body as any);
    }
  },

  async onValidateConfig(config) {
    const c = config as Record<string, unknown>;
    if (!c.discordBotTokenRef || typeof c.discordBotTokenRef !== "string") {
      return { ok: false, errors: ["discordBotTokenRef is required"] };
    }
    if (!c.defaultChannelId || typeof c.defaultChannelId !== "string") {
      return { ok: false, errors: ["defaultChannelId is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});
