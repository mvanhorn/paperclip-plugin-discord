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
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "tools.register",
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
    },
    required: ["discordBotTokenRef", "defaultChannelId"],
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.discordInteractions,
      displayName: "Discord Interactions",
      description:
        "Receives Discord slash command and button interaction payloads.",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Discord Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
