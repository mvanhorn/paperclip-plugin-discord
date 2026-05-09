# paperclip-plugin-discord

[![npm](https://img.shields.io/npm/v/paperclip-plugin-discord)](https://www.npmjs.com/package/paperclip-plugin-discord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bidirectional Discord integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Discord, receive slash commands, approve requests with interactive buttons, gather community intelligence, run multi-agent sessions in threads, process media attachments, register custom commands, and deploy proactive agent suggestions.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

### Notifications (rich embeds with color coding)
- **Issue created** - Blue embed with title, description, status, priority, assignee, project fields, and a "View Issue" link button
- **Issue done** - Green embed with completion confirmation
- **Approval requested** - Yellow embed with interactive **Approve**, **Reject**, and **View** buttons. Click to act without leaving Discord.
- **Agent error** - Red embed with error message (truncated to 1024 chars)
- **Agent run started/finished** - Blue/green lifecycle embeds

### Interactive approvals
- Approve/reject buttons on every approval notification
- Works via Discord Gateway (WebSocket) so buttons work in local deployments without a public URL
- Clicking a button calls the Paperclip API and updates the Discord message inline
- Identifies which Discord user acted (logged as `discord:{username}`)

### Per-type channel routing
- `approvalsChannelId` - Dedicated channel for approval notifications
- `errorsChannelId` - Dedicated channel for agent errors
- `bdPipelineChannelId` - Dedicated channel for agent run lifecycle
- `escalationChannelId` - Dedicated channel for agent escalations
- Falls back to `defaultChannelId` when per-type channels aren't configured

### Slash commands
- `/clip status` - Show active agents and recent completions
- `/clip approve <id>` - Approve a pending approval
- `/clip budget <agent>` - Check an agent's remaining budget
- `/clip issues [project]` - List open issues with optional project filter
- `/clip agents` - Show all agents with status indicators
- `/clip help` - Display all available commands
- `/clip connect [company]` - Link a Discord channel to a Paperclip company
- `/clip connect-channel <project>` - Map a Discord channel to a project for notification routing
- `/clip digest <on|off|status> [mode]` - Configure daily digest (daily/bidaily/tridaily)
- `/clip commands import <json>` - Import a workflow command from JSON
- `/clip commands list` - List registered workflow commands
- `/clip commands run <name> [args]` - Execute a workflow command
- `/clip commands delete <name>` - Delete a workflow command
- `/acp spawn agent:<name> task:<description>` - Start a new agent session in a Discord thread
- `/acp status session:<id>` - Check ACP session status
- `/acp cancel session:<id>` - Cancel a running ACP session
- `/acp close session:<id>` - Close a completed ACP session and archive the thread

### Community intelligence
- Role-weighted signal extraction from Discord channels (every 6 hours)
- Classifies messages into feature wishes, pain points, maintainer directives, and sentiment
- Author roles weighted: admin/mod (5x), contributor (3x), member (1x)
- Historical backfill on first install (configurable, default 90 days)
- Agents can query signals via the `discord_signals` tool
- On-demand re-backfill via the `trigger-backfill` action

### Phase 1: HITL Escalation
- Agents that get stuck can escalate to a dedicated Discord channel with full conversation context
- Rich embed formatting (yellow for pending, green for resolved, red for timed out)
- "Use Suggested Reply" button when the agent has a best-guess response
- "Reply to Customer", "Override Agent", and "Dismiss" component buttons
- Configurable timeout (default 30 min) with automatic timeout marking
- `escalate_to_human` tool - agents can call directly with reason, confidence score, conversation history, and suggested reply
- Resolved escalations emit `escalation-resolved` events; timed-out escalations emit `escalation-timed-out` events
- Works via Gateway WebSocket like approval buttons - no public URL needed

### Phase 2: Multi-Agent Group Threads
- Spawn multiple agents in a single Discord thread (up to `maxAgentsPerThread`, default 5)
- **@mention routing** - `@agentname` in a thread message routes to that specific agent
- **Reply-to routing** - reply to a specific agent's message to route back to that session
- **Most-recently-active fallback** - if no mention or reply, routes to the agent with the most recent activity
- **Agent handoff** - one agent can hand off to another via the `handoff_to_agent` tool; requires human approval via Approve/Reject buttons
- **Discussion loops** - two agents can have a multi-turn back-and-forth via the `discuss_with_agent` tool
  - Configurable max turns (2-50) and human checkpoint intervals
  - "Continue Discussion" / "End Discussion" buttons at each checkpoint
  - Automatic stale detection (5 min inactivity)
- **Dual transport** - native Paperclip sessions with ACP (Agent Client Protocol) fallback
- **Output sequencing** - queued output with 500ms flush delay to prevent interleaving in multi-agent threads
- Per-agent join/leave/complete/fail embeds in-thread

### Phase 3: Media-to-Task Pipeline
- Detects audio, video, and image attachments in Discord messages
- Audio/video files are sent to a Whisper transcription agent, then routed to the Brief Agent for summarization
- Images are routed directly to the Brief Agent for analysis
- Supports common formats: mp3, wav, ogg, flac, mp4, webm, mov, png, jpg, gif, webp, and more
- Content-type and file-extension detection
- Configure which channels to monitor via `mediaChannelIds`
- Enable with `enableMediaPipeline: true`

### Reply routing
- Reply to any bot notification to route your message back to Paperclip
- Replies to issue notifications create issue comments automatically
- Replies to escalation notifications resolve the escalation as a human reply
- Message mappings stored per-channel/message for accurate routing
- Enable/disable with `enableInbound` config toggle (default: true)

### Daily digest
- Configurable digest summaries posted to your Discord channels
- Modes: `daily` (once), `bidaily` (twice), `tridaily` (three times per day)
- Configure via `/clip digest on <mode>` or the `digestMode` config setting
- Includes: tasks completed/created today, active agents, in-progress/review/blocked issues
- Per-company routing to mapped channels

### Workflow commands
- Define multi-step workflows as JSON and execute them via `/clip commands run`
- Seven step types: `fetch_issue`, `invoke_agent`, `http_request`, `send_message`, `create_issue`, `wait_approval`, `set_state`
- Template interpolation: `{{arg0}}`, `{{args}}`, `{{prev.result}}`, `{{step_id.result}}`
- `wait_approval` steps suspend execution and show Approve/Reject buttons
- Import workflows with `/clip commands import`, list with `/clip commands list`
- Built-in command names are protected and cannot be overridden

### Phase 4: Custom Workflow Commands
- Agents register `!command` style commands via the `register_custom_command` tool
- Discord users invoke commands by typing `!commandname <args>` in any monitored channel
- Commands are routed to the registering agent with the parsed arguments
- Command registry persisted per-company in plugin state
- Duplicate command names update the existing registration (upsert)
- Rich embed feedback: "Running" embed on invocation, "Failed" embed on error
- List all registered commands via `listCommands()`
- Enable with `enableCustomCommands: true`

### Phase 5: Proactive Agent Suggestions
- Agents register watch conditions via the `register_watch` tool
- Watches define regex patterns, target channels, a response template, and a cooldown period
- The `check-watches` job runs on a configurable interval (default 15 min) and scans recent messages (20 min window)
- When a pattern matches, the plugin posts a suggestion embed and invokes the agent for deeper analysis
- Response templates support `{{author}}`, `{{content}}`, and `{{channel}}` interpolation
- Per-watch cooldown prevents duplicate triggers (default 60 min)
- Bot messages are excluded from pattern matching
- Enable with `enableProactiveSuggestions: true`

### Gateway WebSocket
- Persistent WebSocket connection to Discord Gateway for real-time interaction handling
- Automatic heartbeat with jitter
- Session resume on reconnect
- Exponential backoff with max 5 consecutive failures before long backoff (60s)
- Handles op 7 (reconnect), op 9 (invalid session), heartbeat ACK timeouts

## Install

```bash
npm install paperclip-plugin-discord
```

Or register with your Paperclip instance directly:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-discord"}'
```

## Setup

1. Create a Discord application at https://discord.com/developers/applications
2. Add a bot to the application and copy the bot token
3. Enable the MESSAGE CONTENT privileged intent (for intelligence scanning)
4. Invite the bot to your server with `applications.commands` and `bot` scopes
5. In Paperclip, create a **company secret** holding your bot token, by either:

   - **UI:** Open any agent's **Configuration → Environment variables**, enter a name (e.g. `discord-bot-token`) and the bot token as the value, then click **Create / Seal**. The secret is created at the **company level** (not bound to that agent — despite the agent-context UI) and the returned UUID can be used from any plugin in the company.
   - **REST API:** `POST /api/companies/{companyId}/secrets` with body `{"name": "discord-bot-token", "value": "<your-bot-token>", "provider": "local_encrypted"}`. The response contains the secret's UUID.

   Copy the resulting secret UUID — you'll paste it into `discordBotTokenRef` in the next step.
6. Configure the plugin with the secret UUID in `discordBotTokenRef`, your guild ID, and channel ID

## Configuration

| Setting | Required | Description |
|---------|----------|-------------|
| `discordBotTokenRef` | Yes | Secret reference to your Discord bot token |
| `defaultChannelId` | Yes | Default channel for notifications |
| `defaultGuildId` | No | Server ID (required for slash commands and intelligence) |
| `approvalsChannelId` | No | Dedicated channel for approvals |
| `errorsChannelId` | No | Dedicated channel for agent errors |
| `bdPipelineChannelId` | No | Dedicated channel for agent run lifecycle |
| `escalationChannelId` | No | Dedicated channel for agent escalations |
| `notifyOnIssueCreated` | No | Post when issues are created (default: true) |
| `notifyOnIssueDone` | No | Post when issues complete (default: true) |
| `notifyOnApprovalCreated` | No | Post when approvals are needed (default: true) |
| `notifyOnAgentError` | No | Post when agents error (default: true) |
| `enableEscalations` | No | Enable escalation features (default: true) |
| `escalationTimeoutMinutes` | No | Timeout before marking escalation timed out (default: 30, min: 5, max: 1440) |
| `enableIntelligence` | No | Enable community signal scanning (default: false) |
| `intelligenceChannelIds` | No | Channel IDs to scan for signals |
| `backfillDays` | No | Days of history to scan on first install (default: 90, max: 365) |
| `intelligenceRetentionDays` | No | Days to retain intelligence signals (default: 30, max: 365) |
| `maxAgentsPerThread` | No | Max concurrent agents per Discord thread (default: 5, max: 10) |
| `enableCommands` | No | Enable slash command handling (default: true) |
| `enableInbound` | No | Enable reply routing to Paperclip (default: true) |
| `topicRouting` | No | Route notifications by project-to-channel mappings (default: false) |
| `digestMode` | No | Digest frequency: off, daily, bidaily, tridaily (default: off) |
| `dailyDigestTime` | No | UTC time for daily digest, HH:MM (default: 09:00) |
| `bidailySecondTime` | No | Second digest time for bidaily mode (default: 17:00) |
| `tridailyTimes` | No | Comma-separated HH:MM times for tridaily (default: 07:00,13:00,19:00) |
| `enableMediaPipeline` | No | Detect and process media attachments (default: false) |
| `mediaChannelIds` | No | Channel IDs to monitor for media (empty = all) |
| `enableCustomCommands` | No | Allow agents to register !commands (default: false) |
| `enableProactiveSuggestions` | No | Allow agents to register watch conditions (default: false) |
| `proactiveScanIntervalMinutes` | No | How often to check watches (default: 15, min: 5, max: 60) |
| `paperclipBaseUrl` | No | Base URL for Paperclip API calls (default: http://localhost:3100) |

## Agent tools

| Tool | Phase | Description |
|------|-------|-------------|
| `escalate_to_human` | 1 | Escalate a conversation to a human via Discord |
| `discord_signals` | - | Query community intelligence signals |
| `handoff_to_agent` | 2 | Hand off a thread to another agent (requires human approval) |
| `discuss_with_agent` | 2 | Start a multi-turn agent-to-agent discussion |
| `register_custom_command` | 4 | Register a !command for Discord users |
| `register_watch` | 5 | Register a watch condition for proactive suggestions |

## Credits

[@MatB57](https://github.com/MatB57) - Escalation channel concept, "Chat OS" vision for turning chat plugins into bidirectional agent command centers, and the HITL suggested-reply flow.

[@leeknowsai](https://github.com/leeknowsai) - Worker bootstrap and packaging fix ([#1](https://github.com/mvanhorn/paperclip-plugin-discord/pull/1)), rich notification embeds, approval button UX, and per-type channel routing ([#4](https://github.com/mvanhorn/paperclip-plugin-discord/pull/4)). Most of the notification formatting and interactive approval flow is their work.

Notification event handler patterns adapted from PR [#398](https://github.com/paperclipai/paperclip/pull/398) by [@StartupBros](https://github.com/StartupBros).

## Changelog

### v0.3.0 - Telegram Feature Parity

Brings the Discord plugin to full parity with the Telegram plugin across 14 feature gaps.

**New slash commands:** `/clip issues`, `/clip agents`, `/clip help`, `/clip connect`, `/clip connect-channel`, `/clip digest`, `/clip commands import/list/run/delete`

**Reply routing:** Replying to bot notifications now routes messages back to Paperclip as issue comments or escalation responses. Controlled by the `enableInbound` toggle.

**Daily digest:** Configurable summary digests (daily/bidaily/tridaily) with tasks completed, active agents, and blocked issues. Configure via `/clip digest on <mode>` or the `digestMode` config.

**Workflow engine:** Define multi-step workflows with 7 step types (`fetch_issue`, `invoke_agent`, `http_request`, `send_message`, `create_issue`, `wait_approval`, `set_state`). Supports template interpolation and approval-gated execution.

**Config toggles:** `enableCommands`, `enableInbound`, `topicRouting`, digest scheduling options.

## Migration

### v0.2.1

The `discordBotTokenRef` field now requires a Paperclip secret reference (a UUID), not the raw token value. If you previously entered a raw bot token in the field, follow these steps to migrate:

1. Create a company secret holding your bot token using one of the paths in the [Setup](#setup) section above (UI or REST API).
2. Copy the returned secret UUID.
3. Open **Plugin Settings for Discord Bot** and paste the UUID into "Discord Bot Token".
4. Save and restart the plugin.

The plugin will fail to activate if a raw token (non-UUID) is entered in the field.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

323 tests covering formatters, commands, intelligence, session registry, media pipeline, custom commands, proactive suggestions, retry logic, workflow engine, and Telegram-parity features.

## Contributing

Issues and PRs welcome at [github.com/mvanhorn/paperclip-plugin-discord](https://github.com/mvanhorn/paperclip-plugin-discord).

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

## License

MIT
