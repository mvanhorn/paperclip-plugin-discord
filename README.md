# paperclip-plugin-discord

Bidirectional Discord integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Discord, receive slash commands, approve requests with interactive buttons, and gather community intelligence from your server.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

**Notifications (rich embeds with color coding)**
- **Issue created** - Blue embed with title, description, status, priority, assignee, project fields, and a "View Issue" link button
- **Issue done** - Green embed with completion confirmation
- **Approval requested** - Yellow embed with interactive **Approve**, **Reject**, and **View** buttons. Click to act without leaving Discord.
- **Agent error** - Red embed with error message (truncated to 1024 chars)
- **Agent run started/finished** - Blue/green lifecycle embeds

**Interactive approvals**
- Approve/reject buttons on every approval notification
- Works via Discord Gateway (WebSocket) so buttons work in local deployments without a public URL
- Clicking a button calls the Paperclip API and updates the Discord message inline
- Identifies which Discord user acted (logged as `discord:{username}`)

**Per-type channel routing**
- `approvalsChannelId` - Dedicated channel for approval notifications
- `errorsChannelId` - Dedicated channel for agent errors
- `bdPipelineChannelId` - Dedicated channel for agent run lifecycle
- Falls back to `defaultChannelId` when per-type channels aren't configured

**Slash commands**
- `/clip status` - Show active agents and recent completions
- `/clip approve <id>` - Approve a pending approval
- `/clip budget <agent>` - Check an agent's remaining budget

**Community intelligence**
- Role-weighted signal extraction from Discord channels (every 6 hours)
- Classifies messages into feature wishes, pain points, maintainer directives, and sentiment
- Author roles weighted: admin/mod (5x), contributor (3x), member (1x)
- Historical backfill on first install (configurable, default 90 days)
- Agents can query signals via the `discord_signals` tool
- On-demand re-backfill via the `trigger-backfill` action

## Install

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/paperclip-plugin-discord","isLocalPath":true}'
```

## Setup

1. Create a Discord application at https://discord.com/developers/applications
2. Add a bot to the application and copy the bot token
3. Enable the MESSAGE CONTENT privileged intent (for intelligence scanning)
4. Invite the bot to your server with `applications.commands` and `bot` scopes
5. Store the bot token in your Paperclip secret provider
6. Configure the plugin with your token reference, guild ID, and channel ID

## Configuration

| Setting | Required | Description |
|---------|----------|-------------|
| `discordBotTokenRef` | Yes | Secret reference to your Discord bot token |
| `defaultChannelId` | Yes | Default channel for notifications |
| `defaultGuildId` | No | Server ID (required for slash commands and intelligence) |
| `approvalsChannelId` | No | Dedicated channel for approvals |
| `errorsChannelId` | No | Dedicated channel for agent errors |
| `bdPipelineChannelId` | No | Dedicated channel for agent run lifecycle |
| `notifyOnIssueCreated` | No | Post when issues are created (default: true) |
| `notifyOnIssueDone` | No | Post when issues complete (default: true) |
| `notifyOnApprovalCreated` | No | Post when approvals are needed (default: true) |
| `notifyOnAgentError` | No | Post when agents error (default: true) |
| `enableIntelligence` | No | Enable community signal scanning (default: false) |
| `intelligenceChannelIds` | No | Channel IDs to scan for signals |
| `backfillDays` | No | Days of history to scan on first install (default: 90, max: 365) |

## Credits

[@leeknowsai](https://github.com/leeknowsai) - Worker bootstrap and packaging fix ([#1](https://github.com/mvanhorn/paperclip-plugin-discord/pull/1)), rich notification embeds, approval button UX, and per-type channel routing ([#4](https://github.com/mvanhorn/paperclip-plugin-discord/pull/4)). Most of the notification formatting and interactive approval flow is their work.

Notification event handler patterns adapted from PR [#398](https://github.com/paperclipai/paperclip/pull/398) by [@StartupBros](https://github.com/StartupBros).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

18 unit tests covering formatters and intelligence signal extraction.

## License

MIT
