export const PLUGIN_ID = "paperclip-plugin-discord";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  discordInteractions: "discord-interactions",
} as const;

export const SLOT_IDS = {
  settingsPage: "discord-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "DiscordSettingsPage",
} as const;

export const DEFAULT_CONFIG = {
  discordBotTokenRef: "",
  defaultGuildId: "",
  defaultChannelId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  enableIntelligence: false,
  intelligenceChannelIds: [] as string[],
} as const;

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export const COLORS = {
  GREEN: 0x2ecc71,
  RED: 0xe74c3c,
  YELLOW: 0xf1c40f,
  BLUE: 0x3498db,
  GRAY: 0x95a5a6,
  PURPLE: 0x9b59b6,
} as const;

export const METRIC_NAMES = {
  sent: "discord_notifications_sent",
  failed: "discord_notification_failures",
  commandsHandled: "discord_commands_handled",
  signalsExtracted: "discord_signals_extracted",
} as const;

export const ROLE_WEIGHTS: Record<string, number> = {
  admin: 5,
  administrator: 5,
  mod: 5,
  moderator: 5,
  maintainer: 5,
  contributor: 3,
  cliptributor: 3,
};
export const DEFAULT_ROLE_WEIGHT = 1;
