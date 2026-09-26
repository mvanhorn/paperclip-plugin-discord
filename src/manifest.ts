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
    "Bidirectional Discord integration: push notifications on agent events, receive slash commands, gather community intelligence, multi-agent sessions, media pipeline, custom commands, and proactive suggestions.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "goals.read",
    "issues.read",
    "issue.comments.read",
    "issues.create",
    "issues.update",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "agents.invoke",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
    "jobs.schedule",
    "events.emit",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      // Secret-ref fields accept BOTH shapes the host can store:
      //   - the object binding written by the settings secret picker
      //     ({ type: "secret_ref", secretId, version }), and
      //   - a bare secret UUID string from an older hand-written config.
      // The schema must therefore declare `["string", "object"]`: the host
      // validates config with Ajv against this schema BEFORE its secret-ref
      // extractor runs, and that extractor rejects bare UUID strings on every
      // `format: "secret-ref"` path — a `type: "string"` field can no longer be
      // saved at all. No `default` either: an empty-string default fails the
      // same extractor on a fresh install.
      discordBotTokenRef: {
        type: ["string", "object"],
        format: "secret-ref",
        title: "Discord Bot Token (secret reference)",
        description:
          "Your Discord bot token, stored as a secret. Create the secret in Settings → Secrets, then pick it here with the secret picker.",
      },
      paperclipBoardApiKeyRef: {
        type: ["string", "object"],
        format: "secret-ref",
        title: "Paperclip Board API Key (secret reference)",
        description:
          "Optional. A Paperclip board API key, stored as a secret. Required when Paperclip is deployed in `authenticated` mode so that plugin-originated calls (approve/reject buttons, workflow steps, inbound reply routing) can satisfy server-side board-auth checks. Create a board API key in Settings → API Keys, store it as a secret, then pick it here. Leave empty for `local_trusted` deployments.",
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
      companyChannels: {
        type: "object",
        title: "Per-company channel overrides",
        description:
          "Route notifications per Paperclip company. Keys are company UUIDs, values are Discord channel IDs. Applied to every event type that does not have a more specific map. Falls through to the default/global channel when a company is not listed.",
        additionalProperties: { type: "string" },
        default: DEFAULT_CONFIG.companyChannels,
      },
      approvalsChannels: {
        type: "object",
        title: "Per-company approvals channel overrides",
        description:
          "Route approval.created events to a specific channel per company. Keys are company UUIDs, values are Discord channel IDs. Checked before companyChannels; falls through to approvalsChannelId (global) when unset.",
        additionalProperties: { type: "string" },
        default: DEFAULT_CONFIG.approvalsChannels,
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
      escalationChannelId: {
        type: "string",
        title: "Escalation Channel ID",
        description:
          "Channel ID for human-in-the-loop escalation messages. Falls back to default channel.",
        default: "",
      },
      enableEscalations: {
        type: "boolean",
        title: "Enable escalation support",
        description:
          "Allow agents to escalate conversations to humans via Discord with actionable buttons.",
        default: true,
      },
      escalationTimeoutMinutes: {
        type: "number",
        title: "Escalation timeout (minutes)",
        description:
          "How long to wait for a human response before marking an escalation as timed out.",
        default: 30,
        minimum: 5,
        maximum: 1440,
      },
      maxAgentsPerThread: {
        type: "number",
        title: "Max agents per thread",
        description:
          "Maximum number of concurrent agent sessions allowed in a single Discord thread.",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
      enableMediaPipeline: {
        type: "boolean",
        title: "Enable media pipeline (Phase 3)",
        description:
          "Detect audio/video/image attachments in Discord messages, transcribe with Whisper, and route to Brief Agent.",
        default: false,
      },
      mediaChannelIds: {
        type: "array",
        items: { type: "string" },
        title: "Media pipeline channels",
        description: "Channel IDs to monitor for media attachments. Falls back to all channels.",
        default: [],
      },
      enableCustomCommands: {
        type: "boolean",
        title: "Enable custom commands (Phase 4)",
        description:
          "Allow agents to register custom slash-style commands that Discord users can invoke.",
        default: false,
      },
      enableProactiveSuggestions: {
        type: "boolean",
        title: "Enable proactive suggestions (Phase 5)",
        description:
          "Allow agents to register watch conditions that fire proactive suggestions when matched.",
        default: false,
      },
      proactiveScanIntervalMinutes: {
        type: "number",
        title: "Proactive scan interval (minutes)",
        description: "How often to check registered watches for new matches.",
        default: 15,
        minimum: 5,
        maximum: 60,
      },
      enableCommands: {
        type: "boolean",
        title: "Enable slash commands",
        description: "Allow Discord users to invoke /clip and /acp slash commands.",
        default: DEFAULT_CONFIG.enableCommands,
      },
      enableInbound: {
        type: "boolean",
        title: "Enable inbound reply routing",
        description:
          "Route Discord replies to bot notifications back to Paperclip as issue comments or escalation responses.",
        default: DEFAULT_CONFIG.enableInbound,
      },
      topicRouting: {
        type: "boolean",
        title: "Enable topic/channel routing",
        description:
          "Route notifications to specific Discord channels based on project-to-channel mappings set via /clip connect-channel.",
        default: DEFAULT_CONFIG.topicRouting,
      },
      digestMode: {
        type: "string",
        enum: ["off", "daily", "bidaily", "tridaily"],
        title: "Digest mode",
        description: "How often to send a summary digest to mapped channels.",
        default: DEFAULT_CONFIG.digestMode,
      },
      dailyDigestTime: {
        type: "string",
        title: "Daily digest time (HH:MM UTC)",
        description: "Time to send the daily digest in UTC.",
        default: DEFAULT_CONFIG.dailyDigestTime,
      },
      bidailySecondTime: {
        type: "string",
        title: "Second digest time for bidaily mode (HH:MM UTC)",
        default: DEFAULT_CONFIG.bidailySecondTime,
      },
      tridailyTimes: {
        type: "string",
        title: "Digest times for tridaily mode (comma-separated HH:MM UTC)",
        default: DEFAULT_CONFIG.tridailyTimes,
      },
      agentBots: {
        type: "array",
        title: "Agent bot map",
        description:
          "One Discord bot per lead agent. An outbound notification about an issue posts " +
          "through the assignee's bot — its own lead's entry, or the lead's entry that " +
          "lists it under alsoForAgentIds — falling back to the discordBotTokenRef bot " +
          "for anyone not listed. Leave empty to keep upstream's single-bot behavior.",
        items: {
          type: "object",
          properties: {
            agentId: { type: "string", title: "Lead agent ID" },
            // Same Ajv note as discordBotTokenRef above: accepts both the settings
            // picker's object binding and a bare secret UUID string, and carries no
            // default so a fresh install never persists an empty-string secret ref.
            botTokenRef: {
              type: ["string", "object"],
              format: "secret-ref",
              title: "Bot token (secret reference)",
              description: "This lead's Discord bot token, stored as a secret.",
            },
            channelId: { type: "string", title: "Channel ID" },
            alsoForAgentIds: {
              type: "array",
              items: { type: "string" },
              title: "Also posts for (worker agent IDs)",
              description:
                "Worker agent IDs whose outbound posts also go through this lead's bot and " +
                "channel. Named explicitly; nothing here is looked up (e.g. reportsTo) at run time.",
            },
          },
          required: ["agentId", "botTokenRef", "channelId"],
        },
        default: DEFAULT_CONFIG.agentBots,
      },
      hannaDiscordUserId: {
        type: "string",
        title: "Hanna's Discord user ID (required for inbound)",
        description:
          "Every inbound path (typed replies, button clicks, slash commands, " +
          "voice) drops any author whose ID does not match this snowflake. " +
          "This fails CLOSED: left empty, every author is dropped on every " +
          "path — not upstream's unrestricted default — and the plugin " +
          "reports itself degraded until this is set.",
        default: DEFAULT_CONFIG.hannaDiscordUserId,
      },
      discordPublicKey: {
        type: "string",
        title: "Discord application public key (required for webhook interactions)",
        description:
          "The public key from your Discord application's General Information page: " +
          "exactly 64 hexadecimal characters. " +
          "It is PUBLIC, not a secret, so it belongs here rather than in a secret " +
          "reference. Discord signs every webhook-delivered interaction with the " +
          "matching private key, and Paperclip's webhook route is unauthenticated — " +
          "so this is the only thing proving a delivery came from Discord. This fails " +
          "CLOSED: left empty, every webhook-delivered interaction is dropped " +
          "unverified and the plugin reports itself degraded once one arrives. " +
          "An install that receives interactions over the Discord gateway instead " +
          "needs nothing here. A value that is set but not a usable key is refused " +
          "when you save, and a delivery whose signed timestamp is more than five " +
          "minutes old is dropped as a replay.",
        default: DEFAULT_CONFIG.discordPublicKey,
      },
      accomplishmentsChannelId: {
        type: "string",
        title: "Accomplishments Channel ID",
        description:
          "When a lead's issue (the agentId of an agentBots entry, not an alsoForAgentIds " +
          "member) reaches done, the lead's bot posts one line here. No mention. " +
          "Leave empty to post nothing.",
        default: DEFAULT_CONFIG.accomplishmentsChannelId,
      },
      milestonesChannelId: {
        type: "string",
        title: "Milestones Channel ID",
        description:
          "When a goal reaches achieved or a project reaches completed, the bot of the " +
          "goal's ownerAgentId or the project's leadAgentId posts one line here, else the " +
          "discordBotTokenRef bot. No mention. Leave empty to post nothing.",
        default: DEFAULT_CONFIG.milestonesChannelId,
      },
      whisperBinaryPath: {
        type: "string",
        title: "Whisper binary path",
        description:
          "Path to the whisper.cpp whisper-cli binary that transcribes voice locally. " +
          "No audio ever leaves the machine.",
        default: DEFAULT_CONFIG.whisperBinaryPath,
      },
      ffmpegPath: {
        type: "string",
        title: "ffmpeg path",
        description:
          "Path to ffmpeg, used to resample audio to the 16 kHz mono WAV whisper-cli expects.",
        default: DEFAULT_CONFIG.ffmpegPath,
      },
      whisperModelPath: {
        type: "string",
        title: "Whisper model path",
        description:
          "Path to the ggml Whisper model file (large-v3 turbo, quantized). " +
          "`~` expands to the current user's home directory.",
        default: DEFAULT_CONFIG.whisperModelPath,
      },
      whisperLanguage: {
        type: "string",
        title: "Whisper language",
        description: "Language code passed to whisper-cli.",
        default: DEFAULT_CONFIG.whisperLanguage,
      },
      voiceInboxIssueId: {
        type: "string",
        title: "Voice inbox issue ID",
        description:
          "Standing Paperclip issue an utterance in the live voice channel routes to " +
          "when there is no thread Hanna last replied in. Leave empty and the plugin " +
          "creates one automatically, titled \"Hanna voice inbox\", assigned to Emery, " +
          "and remembers its ID.",
        default: DEFAULT_CONFIG.voiceInboxIssueId,
      },
    },
    required: ["discordBotTokenRef", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: "discord-intelligence-scan",
      displayName: "Discord Intelligence Scan",
      description:
        "Periodically scan configured Discord channels for community signals.",
      schedule: "0 */6 * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Escalation Timeout Check",
      description:
        "Periodically check for escalations that have exceeded the configured timeout.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "check-watches",
      displayName: "Proactive Watch Check",
      description:
        "Periodically evaluate registered watch conditions and post proactive suggestions.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "check-budget-thresholds",
      displayName: "Budget Threshold Check",
      description:
        "Periodically check agent budgets and alert when crossing the 80% usage threshold.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "discord-daily-digest",
      displayName: "Discord Daily Digest",
      description:
        "Hourly job that checks if the current UTC hour matches configured digest times and sends a summary.",
      schedule: "0 * * * *",
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
    {
      name: "escalate_to_human",
      displayName: "Escalate to Human",
      description:
        "Escalate a conversation to a human operator via Discord with interactive buttons.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", description: "Company ID for the escalation" },
          agentName: { type: "string", description: "Name of the agent requesting escalation" },
          reason: { type: "string", description: "Why the agent is escalating" },
          confidenceScore: { type: "number", description: "Confidence score (0-1)" },
          agentReasoning: { type: "string", description: "Internal reasoning" },
          conversationHistory: {
            type: "array",
            items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
            description: "Last N messages (max 5 shown)",
          },
          suggestedReply: { type: "string", description: "Optional suggested reply" },
        },
        required: ["companyId", "agentName", "reason"],
      },
    },
    // handoff_to_agent, discuss_with_agent, register_custom_command, and
    // register_watch are removed (plan item 6): the v1 runaway came from
    // agents waking agents, so no tool registration lets an agent hand off
    // to, discuss with, or spawn work for another agent, or register a new
    // custom command or watch. See src/worker.ts for what stays behind them.
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.discordInteractions,
      displayName: "Discord Interactions",
      description: "Receives Discord slash command and button interaction payloads.",
    },
  ],
};

export default manifest;
