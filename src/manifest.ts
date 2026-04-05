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
    "issues.read",
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
      discordBotTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Discord Bot Token (secret reference)",
        description:
          "Secret UUID for your Discord Bot token. Create the secret in Settings → Secrets, then paste its UUID here.",
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
    {
      name: "handoff_to_agent",
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
    {
      name: "discuss_with_agent",
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
    {
      name: "register_custom_command",
      displayName: "Register Custom Command",
      description: "Register a custom command that Discord users can invoke via !command.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", description: "Company ID" },
          command: { type: "string", description: "Command name (without leading !)" },
          description: { type: "string", description: "Description of the command" },
          parameters: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } } },
            description: "Command parameters",
          },
        },
        required: ["companyId", "command", "description"],
      },
    },
    {
      name: "register_watch",
      displayName: "Register Watch",
      description: "Register a watch condition that fires proactive suggestions when matched.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", description: "Company ID" },
          watchName: { type: "string", description: "Watch name" },
          patterns: { type: "array", items: { type: "string" }, description: "Regex patterns to match" },
          channelIds: { type: "array", items: { type: "string" }, description: "Channel IDs to watch (empty = all)" },
          responseTemplate: { type: "string", description: "Template for the suggestion message" },
          cooldownMinutes: { type: "number", description: "Min minutes between triggers (default 60)" },
        },
        required: ["companyId", "watchName", "patterns", "responseTemplate"],
      },
    },
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
