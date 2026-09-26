# paperclip-plugin-discord

[![npm](https://img.shields.io/npm/v/paperclip-plugin-discord)](https://www.npmjs.com/package/paperclip-plugin-discord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bidirectional Discord integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Discord, receive slash commands, approve requests with interactive buttons, gather community intelligence, run multi-agent sessions in threads, process media attachments, register custom commands, and deploy proactive agent suggestions.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## This fork

This is Sage Advice's private fork, at `sageadvicellc/paperclip-plugin-discord`. It
adds one Discord bot per agent, restricts every inbound path to one person, and
adds local voice transcription. It removes the features that let agents wake
other agents.

**One bot per lead agent, and a lead's bot also speaks for its workers.**
`agentBots` maps a lead agent's ID to its own bot token and channel. A
notification about an issue posts through the assignee's bot: its own lead
entry, or the lead entry that names it under `alsoForAgentIds`. With no match
anywhere, it falls back to the plugin's own `discordBotTokenRef` bot.
`alsoForAgentIds` is a plain list of worker agent IDs, set by hand — nothing
here looks up a reporting line at run time. Hanna set the four leads on
2026-09-26:

```json
{
  "agentBots": [
    {
      "agentId": "665fc38d-3f2d-4a2e-9890-8ba8861e41be",
      "botTokenRef": "<secret uuid>",
      "channelId": "1553316428529274983"
    },
    {
      "agentId": "00f3e5a2-7520-467e-9017-a27647e6261f",
      "botTokenRef": "<secret uuid>",
      "channelId": "1553316430898929725",
      "alsoForAgentIds": [
        "93a6bde1-ac1f-4b40-be3c-876410237f9e",
        "88fe44b2-64fd-426d-a223-b489deb21ea9"
      ]
    },
    {
      "agentId": "8f5f5d83-d9bc-494d-a9fd-21b45e444082",
      "botTokenRef": "<secret uuid>",
      "channelId": "1553316432522121276",
      "alsoForAgentIds": [
        "6d280c11-c807-4d64-b29c-44ce51c27faa",
        "6d3d4ae8-a057-4916-84e7-efca5a561072",
        "1d51740d-14c0-4c5a-ac89-87b7935b5cf5"
      ]
    },
    {
      "agentId": "88655af5-1d83-4593-9f92-8b1a6d9f5c22",
      "botTokenRef": "<secret uuid>",
      "channelId": "1553320206552666112",
      "alsoForAgentIds": ["8d17cab4-247c-4fd6-b6cf-2168ecf45888"]
    }
  ]
}
```

The four entries above: Emery (no workers listed); Aspen, also for Atlas and
Atom; Coda, also for Clay, Quinn, and Rowan; Darcey, also for Virginia.

Two entries resolving to the same bot token share one Gateway connection
(logged, not a second connection). An agent ID named in more than one entry —
as a lead or under `alsoForAgentIds`, anywhere in the list — is a config
error: the first entry to name it wins, and the rest are logged and dropped.

**One person can talk to the bots, and this fails closed.** `hannaDiscordUserId`
is a Discord user ID. Every inbound path — typed replies, button clicks, slash
commands, voice — drops any author who does not match it. Left unset, every
author is dropped, on every path: this is required, not opt-in, and the plugin
reports itself degraded (`discord-inbound-disabled`) and logs it once per
configuration delivery until it is set.

**A reply wakes the assignee, and an issue in review or blocked wakes Hanna.**
A typed reply becomes a Paperclip board comment, and the board comment itself
wakes the assignee — Paperclip wakes the assignee on any non-self comment
while the issue is open, no mention needed. Separately, when an issue moves to
`in_review` or `blocked` and is assigned to `local-board`, the assignee's bot
posts the ask and mentions
Hanna — this is the only event that ever mentions her.

**`/ask` always goes to Emery.** It creates a `todo` issue assigned to Emery,
recording the named agent on the issue, rather than creating an issue for that
agent directly.

**Removed:** `discuss_with_agent`, `handoff_to_agent` (agent-to-agent tools),
`register_custom_command`, `register_watch`, the workflow engine's
`create_issue` and `invoke_agent` steps, and `/acp spawn`. These let one agent
start or hand off work to another with no human in the loop, which is what
caused a runaway in an earlier version of the fleet. None of their tool
registrations exist in this fork, so no agent can call them.

**Voice input, local only.** Speech-to-text runs on the host machine with
Whisper (whisper.cpp), not a cloud service. See
[Voice transcription setup](#voice-transcription-setup) for the prerequisites
and [Where a spoken utterance goes](#where-a-spoken-utterance-goes) for the
routing rules, both rewritten for this fork.

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
- `/acp status session:<id>` - Check ACP session status
- `/acp cancel session:<id>` - Cancel a running ACP session
- `/acp close session:<id>` - Close a completed ACP session and archive the thread
- `/ask agent:<name> text:<what you want done>` - **This fork.** Creates a `todo` issue assigned to Emery, recording `agent` on the issue. Never creates an issue for the named agent directly — the v2 lifecycle expects new work to enter through Emery, who scopes it.

**Removed in this fork:** `/acp spawn agent:<name> task:<description>`, which started a new agent session directly, with no human in the loop.

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

### Voice transcription (optional, opt-in)
- The bot joins one voice channel and transcribes what is said there (inbound only — it never speaks)
- Each utterance goes to Paperclip through the same inbound ingress a typed reply uses — routed to the issue of the thread Hanna last replied in, or to a standing voice-inbox issue — and is also posted into a text channel by webhook so the room can see what was heard
- The webhook post is **display only** — nothing reads it back, so a transcript cannot loop and no webhook is ever a trusted input source
- Speech-to-text runs locally with Whisper (whisper.cpp); no audio leaves the machine, and the plugin never reads a Deepgram (or any other cloud STT) API key
- End-of-utterance is 800 ms of silence
- Off unless three environment variables are set (the fourth, an API key, is gone — Whisper needs no key), and it rides the plugin's existing gateway connection — no second Discord connection
- Joins on the gateway's own READY/RESUMED boundary, and rejoins there after a reconnect
- Requires [optional dependencies](#voice-transcription-setup) that are **not** installed by default

### Voice messages (optional, opt-in)
- Hanna can record a voice message in Discord and send it as a reply in an issue's thread
- The plugin downloads the attachment (bounded to 25 MB), transcribes it with the same local Whisper transcriber, and posts a comment carrying the transcript and a link to the audio
- The comment reaches Paperclip through the same ingress a typed reply uses
- The `hannaDiscordUserId` allowlist applies before anything is downloaded; a non-audio attachment is ignored, and the message's own typed text (if any) is used instead
- Only an attachment whose content type starts with `audio/`, or one Discord itself flags as a voice message, qualifies

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

> **Note — `paperclipai` master, post [#5429](https://github.com/paperclipai/paperclip/pull/5429) (2026-05-09):**
> The new Secrets Manager ships with a temporary kill switch on plugin secret-ref UUIDs while a company-scoped `plugin_config` follow-up lands. If you're running paperclipai master, plugin activation will fail with `Plugin secret references are disabled until company-scoped plugin config lands`, and `POST /api/plugins/:id/config` returns HTTP 422 for configs containing secret-ref UUIDs (e.g. `discordBotTokenRef`). This is intentional fail-closed mitigation (PAP-2394 — see the [upstream plan doc](https://github.com/paperclipai/paperclip/blob/master/doc/plans/2026-04-26-plugin-secret-ref-company-scope.md)). Until the follow-up lands, pin to the last paperclipai release before #5429. This callout will be removed once secret-ref resolution is restored.

## Troubleshooting: confirm your Paperclip host

Before filing a bug, confirm which Paperclip host this plugin is actually talking to. Run `paperclipai plugin target` ([#8575](https://github.com/paperclipai/paperclip/pull/8575)) — it prints the resolved API URL plus the server's status, version, deploymentMode, and deploymentExposure *before* anything is installed. A server version older than this plugin expects is the most common cause of activation failures and secret-resolution errors (e.g. `discordBotTokenRef` not resolving) that look like plugin bugs but aren't. If the URL or version is wrong, point Paperclip at the right host — or update the server — before opening an issue.

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
| `enableProactiveSuggestions` | No | Allow agents to register watch conditions (default: false) — **removed in this fork**, no tool exists to set one |
| `proactiveScanIntervalMinutes` | No | How often to check watches (default: 15, min: 5, max: 60) |
| `paperclipBaseUrl` | No | Base URL for Paperclip API calls (default: http://localhost:3100) |
| `agentBots` | No | This fork. One Discord bot per lead agent: `{ agentId, botTokenRef, channelId, alsoForAgentIds? }[]`. An outbound notification posts through the assignee's bot — its own lead entry, or the lead entry naming it under `alsoForAgentIds` — falling back to `discordBotTokenRef` for anyone not listed. Empty by default (upstream's single-bot behavior). See the config example above |
| `hannaDiscordUserId` | **Yes, for inbound** | This fork. A Discord user ID. Every inbound path drops any author who does not match it. Unset drops EVERY author (fails closed), reports plugin health degraded, and logs it once per configuration delivery — it does not fall back to upstream's unrestricted behavior |
| `whisperBinaryPath` | No | This fork. Path to the whisper.cpp `whisper-cli` binary (default: `/opt/homebrew/bin/whisper-cli`) |
| `ffmpegPath` | No | This fork. Path to `ffmpeg`, used to resample audio to the WAV whisper-cli expects (default: `/opt/homebrew/bin/ffmpeg`) |
| `whisperModelPath` | No | This fork. Path to the ggml Whisper model file (default: `~/.cache/whisper/ggml-large-v3-turbo-q8_0.bin`); `~` expands to the current user's home |
| `whisperLanguage` | No | This fork. Language code passed to whisper-cli (default: `en`) |
| `voiceInboxIssueId` | No | This fork. The standing Paperclip issue a live-voice utterance routes to when there is no thread Hanna last replied in. Leave empty and the plugin creates one, titled "Hanna voice inbox", assigned to Emery, and remembers its ID |

### Voice transcription setup

Voice is opt-in and adds no weight to a normal install. Its dependencies are declared as **optional peer dependencies**, so `npm install paperclip-plugin-discord` does not pull them in and nothing about the text path changes.

To enable it, install the voice dependencies alongside the plugin:

```bash
npm install @discordjs/voice prism-media opusscript@0.0.8 libsodium-wrappers ws
```

> `opusscript` is pinned to `0.0.8` on purpose: `prism-media@1.3.5` declares it as `peerOptional opusscript@^0.0.8`, so installing a newer `opusscript` fails with `ERESOLVE`.

`prism-media` ships no Opus codec of its own — it needs one of `opusscript`, `@discordjs/opus`, `node-opus` or `ffmpeg-static` to decode incoming audio. `opusscript` is pure JavaScript and needs no native build, so it is the recommended default; `@discordjs/opus` is faster but compiles a native module. Without an engine the plugin refuses to start voice and logs the install command, rather than joining the channel and silently transcribing nothing.

#### Whisper prerequisites (this fork)

Speech-to-text runs locally. Install these on the machine the plugin worker runs on — not as npm packages:

1. **whisper.cpp**, via Homebrew: `brew install whisper-cpp`. This installs the `whisper-cli` binary.
2. **ffmpeg**, via Homebrew: `brew install ffmpeg`. The plugin uses it to resample audio to the 16 kHz mono WAV `whisper-cli` reads.
3. **The model file**, downloaded once, by hand. This fork was built and measured against the quantized large-v3-turbo model, `ggml-large-v3-turbo-q8_0.bin`, from the [ggerganov/whisper.cpp models on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp). Save it wherever you like and point `whisperModelPath` at it — the default expects `~/.cache/whisper/ggml-large-v3-turbo-q8_0.bin`.

None of this needs an API key, an account, or a network call at transcription time. If `whisper-cli`, `ffmpeg`, or the model file cannot be found at the configured paths, transcription fails for that one utterance or voice message — logged, not silent — and text routing is unaffected.

Then set these environment variables on the plugin worker:

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_VOICE_GUILD_ID` | Yes | Guild (server) ID containing the voice channel |
| `DISCORD_VOICE_CHANNEL_ID` | Yes | Voice channel the bot joins on startup |
| `DISCORD_VOICE_WEBHOOK_URL` | Yes | Webhook URL of the text channel transcripts are posted to |
| `DISCORD_VOICE_USERNAME` | No | Webhook display name for transcripts (default: `Voice`) |

If any of the three required variables is missing, the live `#talk` voice channel initializes nothing and the plugin runs exactly as before. Voice messages (a reply with an audio attachment) do not depend on these three variables at all — see [Voice messages](#voice-messages-optional-opt-in) — and work whenever the whisper binary, ffmpeg, and model are reachable at their configured paths. Voice startup and shutdown are both wrapped: a voice failure is logged, reported through plugin health, and never crashes the plugin or interrupts text routing.

Whisper's own paths — `whisperBinaryPath`, `ffmpegPath`, `whisperModelPath`, `whisperLanguage` — are plugin config, not environment variables. See the [Configuration](#configuration) table above for their defaults.

### Where a spoken utterance goes

A voice utterance is not a reply to anything, so it has no message to inherit a
destination from. Two destinations are tried, in order:

1. **The issue of the thread Hanna last replied in.** A typed reply, or a
   voice message (see above), records which issue it commented on. The next
   spoken utterance in `#talk` goes there. A live utterance never counts as a
   reply itself, so it can never become its own target.
2. **The standing voice inbox**, when there is no such thread yet.
   `voiceInboxIssueId` names it directly when set. Left empty, the plugin
   creates one issue, titled "Hanna voice inbox", assigned to the agent named
   Emery — the same way `/ask` assigns new work — the first time it is
   needed, and remembers its ID in plugin state so it is never created twice.

Either way the utterance is commented on the resolved issue under the company
that owns this install, through the same ingress and the same API call a typed
reply uses, authored `discord:voice:<userId>`.

With neither available — no reply has happened yet, and the inbox could not be
created (Emery could not be found, say) — voice runs **display-only**: it
still transcribes and still posts to the text channel, but sends nothing to
Paperclip, and plugin health says so. The same is true for an utterance whose
destination Paperclip rejects (the issue was deleted, say): the transcript
still shows, health reports it, and nothing else in the plugin is affected.

This replaces upstream's channel-level pointer, which followed whichever
notification the plugin posted into a channel most recently — a room's actual
conversation, not the plugin's own most recent post, decides the destination
now.

The last-replied-thread pointer, and the voice inbox's cached ID, are only
ever read for the company that currently owns the install. Ownership can move
between installs, and state left behind by a previous owner is never read
across that boundary. The same rule covers slow work: an utterance still being
transcribed when ownership moves is dropped rather than filed under whoever
owns the install by the time it finishes.

To find the pointer, the plugin has to know which channel the webhook posts
into, which a webhook URL does not carry — so it asks Discord for the webhook
object once. At most one such lookup is in flight at a time and every concurrent
utterance shares its result; a resolved channel is cached, and a failed lookup is
retried after a five-minute cooldown. While it is unresolved, utterances use the
default issue.

Plugin health tracks two independent things about voice: whether it can
**connect**, and whether what it hears can be **routed**. Neither is evidence
about the other, so reconnecting does not clear a routing problem and saving the
configuration does not either — only an utterance actually reaching Paperclip
does.

The webhook transcript is never the transport. The inbound router refuses bot
authors and refuses anything that is not a reply to a message this plugin
posted, and voice does not ask it to make an exception: it calls the ingress
directly. Nothing this plugin writes to Discord can be read back in as input.

Notes:

- The bot joins **self-muted and un-deafened** — Phase 1 listens, it does not speak.
- Enabling voice adds the `GUILD_VOICE_STATES` intent to the gateway IDENTIFY. Intents are fixed when the socket identifies, so turning voice on or off reconnects the gateway.
- Voice joins when the gateway reaches READY or RESUMED, never before: a voice-state update sent to a socket that has not identified is not deliverable, and a join that could not be sent is not retried by `@discordjs/voice`.
- Transcripts are posted with `allowed_mentions: { parse: [] }`. Speech recognition will happily render "at everyone" as `@everyone`, so no transcript can ever ping anyone — the text is preserved verbatim, but Discord resolves no mentions in it.
- Audio is transcribed locally, on the machine the plugin worker runs on. No audio leaves the machine. Tell the people in the channel that the room is transcribed either way.

Not in this phase: text-to-speech output, per-agent voices, cost guards.

## Agent tools

| Tool | Phase | Description |
|------|-------|-------------|
| `escalate_to_human` | 1 | Escalate a conversation to a human via Discord |
| `discord_signals` | - | Query community intelligence signals |

Upstream also registers `handoff_to_agent` (2, hand off to another agent),
`discuss_with_agent` (2, multi-turn agent-to-agent discussion),
`register_custom_command` (4, register a `!command`), and `register_watch` (5,
register a proactive-suggestion watch). **None of these four are registered in
this fork.** They let one agent start or hand off work to another with no
human in the loop; no agent running under this fork can call them, because the
registrations do not exist.

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

737 tests (one skipped unless `WHISPER_INTEGRATION=1`) covering formatters, commands, intelligence, session registry, media pipeline, custom commands, proactive suggestions, retry logic, workflow engine, Telegram-parity features, and this fork's agent bot map (including alsoForAgentIds), author allowlist, wake-on-reply, local Whisper transcription, voice messages, and voice-inbox routing.

## Contributing

Issues and PRs welcome at [github.com/mvanhorn/paperclip-plugin-discord](https://github.com/mvanhorn/paperclip-plugin-discord).

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

## License

MIT
