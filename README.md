# paperclip-plugin-discord

Bidirectional Discord integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Discord, receive slash commands, and gather community intelligence.

## Features

**Notifications** - Rich embeds posted to Discord when agents create issues, complete tasks, request approvals, or hit errors. Approval embeds include interactive Approve/Reject buttons.

**Slash Commands** - `/clip status`, `/clip approve`, `/clip budget` - manage your autonomous company from Discord.

**Community Intelligence** - Periodic scan of Discord channels with role-weighted signal extraction. Agents can query community feature requests, pain points, and maintainer directives via a registered `discord_signals` tool.

## Install

```bash
# From Paperclip
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

| Field | Required | Description |
|-------|----------|-------------|
| `discordBotTokenRef` | Yes | Secret reference to your Discord bot token |
| `defaultChannelId` | Yes | Channel ID for notifications |
| `defaultGuildId` | No | Server ID (required for slash commands and intelligence) |
| `notifyOnIssueCreated` | No | Post when issues are created (default: true) |
| `notifyOnIssueDone` | No | Post when issues complete (default: true) |
| `notifyOnApprovalCreated` | No | Post when approvals are needed (default: true) |
| `notifyOnAgentError` | No | Post when agents error (default: true) |
| `enableIntelligence` | No | Enable community signal scanning (default: false) |
| `intelligenceChannelIds` | No | Channel IDs to scan for signals |

## Credits

Notification event handler patterns adapted from PR [#398](https://github.com/paperclipai/paperclip/pull/398) by [@StartupBros](https://github.com/StartupBros). Intelligence architecture informed by the [OSC Discord](https://github.com/mvanhorn/open-source-contributor) role-weighted signal extraction approach.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
