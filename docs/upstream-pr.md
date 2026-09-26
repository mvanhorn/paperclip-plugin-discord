# Upstream pull request: agent bots, an inbound allowlist, local Whisper, and shared channel posts

Target: `mvanhorn/paperclip-plugin-discord`, branch `main`.

## Summary

This pull request adds four opt-in features. With none of the new
configuration set, the plugin behaves as it does today.

1. An agent bot map. Each Paperclip agent can post as its own Discord bot.
2. An inbound author allowlist. Only the listed Discord users reach
   Paperclip.
3. Local speech-to-text with whisper.cpp, beside the existing Deepgram
   engine.
4. Shared channel posts. An agent's bot posts one line when a lead's issue
   is done, when a goal is achieved, or when a project is completed.

## 1. Agent bot map

A new configuration field, `agentBots`, is a list of entries. Each entry holds an
`agentId`, a `botTokenRef` (a company secret), and an optional `channelId`.

- The worker opens one Gateway client for each entry, in the same process.
  Discord allows several bot tokens in one process.
- A notification about an issue posts through the client of the issue's
  assignee.
- With no matching entry, the notification posts through the existing
  `discordBotTokenRef` bot.
- If an entry is removed, or if the plugin stops, the worker closes that
  client.

With `agentBots` empty, every post uses the existing bot, as today.

## 2. Inbound author allowlist

A new configuration field names the Discord user IDs that can reach
Paperclip. The check
covers every inbound path: a typed reply, a button click, a slash command, a
voice message, and a live voice channel.

- A message from any other author is dropped, and the drop is logged with the
  author ID and the channel ID, never the content.
- In a live voice channel, the check runs before the plugin subscribes to a
  speaker's audio. A speaker who is not listed is never transcribed.

If the field is unset, the plugin accepts every author, as today. A
deployment that sets the list gets a closed inbound path.

## 3. Local Whisper speech-to-text

A new engine transcribes audio on the host with `whisper-cli` from
whisper.cpp, after `ffmpeg` converts the audio to 16 kHz mono WAV. No audio
leaves the machine.

- The engine implements the existing `STTAdapter` interface, so the voice
  client does not change.
- It starts each child process with an argument array, never a shell
  string. A timeout stops a child that runs too long, and the temporary
  directory is removed after every call.
- Every `ffmpeg` call passes `-protocol_whitelist file`. If the file
  extension is known, the call also forces the input format.
- One transcription runs at a time. Extra utterances are dropped and logged.
- A non-zero exit or an empty transcript is an error, never an empty
  string.

New configuration fields: `whisperBinaryPath`, `ffmpegPath`, `whisperModelPath`, and
`whisperLanguage`. A new configuration field selects the engine. Deepgram stays the
default, so a deployment that sets nothing keeps its current behavior.

Measured on an Apple M3 Pro with 18 GB of memory, with the
`ggml-large-v3-turbo-q8_0` model, for a 15.96-second voice clip, end to end:
2.4 to 3.0 seconds on the first run, and 1.5 to 1.8 seconds on later runs.

## 4. Shared channel posts

Two new configuration fields name two channels. Each field is optional. If
a field is unset, the plugin posts nothing to that channel and reads
nothing extra.

- `accomplishmentsChannelId`. If an issue reaches `done` and its assignee
  is the `agentId` of an `agentBots` entry, that entry's bot posts one line
  here. An agent listed only in `alsoForAgentIds` does not post here. The
  existing done notification does not change.
- `milestonesChannelId`. If a goal reaches `achieved`, or a project reaches
  `completed`, one line posts here. The bot is the entry that matches the
  goal's `ownerAgentId` or the project's `leadAgentId`, on `agentId` or
  `alsoForAgentIds`. With no match, the `discordBotTokenRef` bot posts.

Each post sets `allowed_mentions` to `{ "parse": [] }`, so Discord sends no
push, even if a title contains a mention.

The plugin posts only when the status changes. A later update to an item
that is already done, achieved, or completed posts nothing.

- The `goal.updated` and `project.updated` events do not carry the previous
  status. The `goal.updated` payload is the update body, and the
  `project.updated` payload holds only `changedKeys`. The plugin skips an
  update that does not name `status`. For one that does, it reads the goal
  or project, and it keeps a marker per item in plugin state. The marker
  clears when the status moves away, so a later return posts again.
- For an issue, the plugin reads `_previous` when the event carries it. A
  `_previous` without `status` means the status did not change. Without
  `_previous`, the issue's `completedAt` is the marker, as for the existing
  done notification.

The manifest adds the `goals.read` capability for the goal read.

## Tests

- Unit tests cover the bot map, the allowlist on each inbound path, the
  Whisper engine with a mocked child process, and the shared channel posts:
  the lead and worker cases, a missing setting, the bot choice for a goal
  and a project, a repeat update, and the mention rule.
- If `WHISPER_INTEGRATION=1` is set, one integration test runs the real
  binaries against a recorded clip.
