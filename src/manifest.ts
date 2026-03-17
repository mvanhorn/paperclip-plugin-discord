import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Discord Bot",
  description:
    "Bidirectional Discord integration: push notifications on agent events, receive slash commands, and gather community intelligence for agent context.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    // "instance.settings.register",  // no UI in this repo
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      discordBotTokenRef: {
        type: "string",
        title: "Discord Bot Token (secret reference)",
        description:
          "Reference to the Discord Bot token stored in your secret provider.",
        default: DEFAULT_CONFIG.discordBotTokenRef,
      },
      defaultGuildId: {
        type: "string",
        title: "Default Guild (Server) ID",
        description: "The Discord server ID to post notifications to.",
        default: DEFAULT_CONFIG.defaultGuildId,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Channel ID",
        description: "Channel ID to post notifications to.",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description: "Channel ID for approval requests. Falls back to default channel.",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description: "Channel ID for agent error notifications. Falls back to default channel.",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      bdPipelineChannelId: {
        type: "string",
        title: "BD Pipeline Channel ID",
        description: "Channel ID for agent run lifecycle events. Falls back to default channel.",
        default: DEFAULT_CONFIG.bdPipelineChannelId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },
      enableIntelligence: {
        type: "boolean",
        title: "Enable community intelligence",
        description:
          "Periodically scan Discord channels for community signals (feature requests, pain points). Results are queryable by agents.",
        default: DEFAULT_CONFIG.enableIntelligence,
      },
      intelligenceChannelIds: {
        type: "array",
        items: { type: "string" },
        title: "Intelligence channels",
        description: "Channel IDs to scan for community signals.",
        default: DEFAULT_CONFIG.intelligenceChannelIds,
      },
      backfillDays: {
        type: "number",
        title: "Backfill history (days)",
        description:
          "How many days of Discord message history to scan on first install. Set to 0 to skip backfill.",
        default: 90,
        minimum: 0,
        maximum: 365,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL for Paperclip dashboard links and API calls",
        default: "http://localhost:3100",
      },
      intelligenceRetentionDays: {
        type: "number",
        title: "Intelligence retention (days)",
        description: "How many days to retain intelligence signals before expiry.",
        default: 30,
        minimum: 1,
        maximum: 365,
      },
    },
    required: ["discordBotTokenRef", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: "discord-intelligence-scan",
      displayName: "Discord Intelligence Scan",
      description:
        "Periodically scan configured Discord channels for community signals (feature requests, pain points, maintainer directives).",
      schedule: "0 */6 * * *",
    },
  ],
  tools: [
    {
      name: "discord_signals",
      displayName: "Discord Signals",
      description:
        "Query recent community signals from Discord (feature requests, pain points, maintainer directives).",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: {
            type: "string",
            description: "Company ID to query signals for",
          },
          category: {
            type: "string",
            enum: [
              "feature_wish",
              "pain_point",
              "maintainer_directive",
              "sentiment",
            ],
            description: "Filter signals by category (optional)",
          },
        },
        required: ["companyId"],
      },
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.discordInteractions,
      displayName: "Discord Interactions",
      description:
        "Receives Discord slash command and button interaction payloads.",
    },
  ],
  // UI disabled — no settings page source in this repo
  // ui: {
  //   slots: [
  //     {
  //       type: "settingsPage",
  //       id: SLOT_IDS.settingsPage,
  //       displayName: "Discord Settings",
  //       exportName: EXPORT_NAMES.settingsPage,
  //     },
  //   ],
  // },
};

export default manifest;
