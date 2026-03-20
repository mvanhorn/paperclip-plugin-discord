import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postEmbed, getChannelMessages } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Phase 5: Proactive Suggestions
//   - Watch registry (agents register via register_watch tool)
//   - check-watches job evaluates patterns against recent messages
//   - Fires proactive suggestion embeds when matched
// ---------------------------------------------------------------------------

export interface WatchEntry {
  watchId: string;
  watchName: string;
  patterns: string[];
  channelIds: string[];
  responseTemplate: string;
  agentId: string;
  agentName: string;
  companyId: string;
  cooldownMinutes: number;
  registeredAt: string;
  lastTriggeredAt?: string;
}

interface WatchRegistry {
  watches: WatchEntry[];
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

async function getWatches(ctx: PluginContext, companyId: string): Promise<WatchEntry[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "proactive_watches",
  });
  if (!raw) return [];
  return (raw as WatchRegistry).watches ?? [];
}

async function saveWatches(ctx: PluginContext, companyId: string, watches: WatchEntry[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: "proactive_watches" },
    { watches } as WatchRegistry,
  );
}

// ---------------------------------------------------------------------------
// Register a watch
// ---------------------------------------------------------------------------

export async function registerWatch(
  ctx: PluginContext,
  companyId: string,
  watchName: string,
  patterns: string[],
  channelIds: string[],
  responseTemplate: string,
  cooldownMinutes: number,
  agentId: string,
  agentName: string,
): Promise<{ ok: boolean; watchId: string; error?: string }> {
  if (patterns.length === 0) {
    return { ok: false, watchId: "", error: "At least one pattern is required." };
  }

  // Validate regex patterns
  for (const p of patterns) {
    try {
      new RegExp(p, "i");
    } catch {
      return { ok: false, watchId: "", error: `Invalid regex pattern: ${p}` };
    }
  }

  const watchId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const watches = await getWatches(ctx, companyId);

  // Check for duplicate name
  const existing = watches.find((w) => w.watchName === watchName);
  if (existing) {
    existing.patterns = patterns;
    existing.channelIds = channelIds;
    existing.responseTemplate = responseTemplate;
    existing.cooldownMinutes = cooldownMinutes;
    existing.agentId = agentId;
    existing.agentName = agentName;
    existing.registeredAt = new Date().toISOString();
    await saveWatches(ctx, companyId, watches);
    ctx.logger.info("Watch updated", { watchName, watchId: existing.watchId });
    return { ok: true, watchId: existing.watchId };
  }

  watches.push({
    watchId,
    watchName,
    patterns,
    channelIds,
    responseTemplate,
    agentId,
    agentName,
    companyId,
    cooldownMinutes: cooldownMinutes > 0 ? cooldownMinutes : 60,
    registeredAt: new Date().toISOString(),
  });

  await saveWatches(ctx, companyId, watches);
  ctx.logger.info("Watch registered", { watchId, watchName, agentName });
  return { ok: true, watchId };
}

// ---------------------------------------------------------------------------
// Check watches job
// ---------------------------------------------------------------------------

export async function checkWatches(
  ctx: PluginContext,
  token: string,
  companyId: string,
  defaultChannelId: string,
): Promise<void> {
  const watches = await getWatches(ctx, companyId);
  if (watches.length === 0) return;

  const now = Date.now();

  for (const watch of watches) {
    // Check cooldown
    if (watch.lastTriggeredAt) {
      const elapsed = now - new Date(watch.lastTriggeredAt).getTime();
      if (elapsed < watch.cooldownMinutes * 60 * 1000) continue;
    }

    // Determine which channels to scan
    const channelsToScan =
      watch.channelIds.length > 0 ? watch.channelIds : [defaultChannelId];

    const compiledPatterns = watch.patterns.map((p) => new RegExp(p, "i"));

    let triggered = false;
    let matchedMessage: { channelId: string; content: string; author: string } | null = null;

    for (const channelId of channelsToScan) {
      if (triggered) break;

      const messages = await getChannelMessages(ctx, token, channelId, 50);
      for (const msg of messages) {
        // Skip bot messages
        if (msg.author.username.endsWith("[bot]")) continue;

        // Only check messages from the last scan interval
        const msgAge = now - new Date(msg.timestamp).getTime();
        if (msgAge > 20 * 60 * 1000) continue; // 20 min window

        for (const regex of compiledPatterns) {
          if (regex.test(msg.content)) {
            triggered = true;
            matchedMessage = {
              channelId,
              content: msg.content.slice(0, 300),
              author: msg.author.username,
            };
            break;
          }
        }
        if (triggered) break;
      }
    }

    if (triggered && matchedMessage) {
      watch.lastTriggeredAt = new Date().toISOString();
      await saveWatches(ctx, companyId, watches);

      const suggestion = watch.responseTemplate
        .replace("{{author}}", matchedMessage.author)
        .replace("{{content}}", matchedMessage.content)
        .replace("{{channel}}", matchedMessage.channelId);

      await postEmbed(ctx, token, matchedMessage.channelId, {
        embeds: [{
          title: `Suggestion from ${watch.agentName}`,
          description: suggestion.slice(0, 2048),
          color: COLORS.PURPLE,
          fields: [
            { name: "Watch", value: watch.watchName, inline: true },
            { name: "Triggered by", value: `${matchedMessage.author}: "${matchedMessage.content.slice(0, 100)}"` },
          ],
          footer: { text: "Paperclip Proactive Suggestion" },
          timestamp: new Date().toISOString(),
        }],
      });

      // Also invoke the agent for deeper analysis
      try {
        await ctx.agents.invoke(watch.agentId, companyId, {
          prompt: `Proactive watch "${watch.watchName}" triggered by message from ${matchedMessage.author}: "${matchedMessage.content}". Please analyze and provide detailed suggestions.`,
          reason: `Proactive watch: ${watch.watchName}`,
        });
      } catch (err) {
        ctx.logger.warn("Proactive agent invoke failed", {
          watchId: watch.watchId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await ctx.metrics.write(METRIC_NAMES.watchesTriggered, 1);
      ctx.logger.info("Watch triggered", {
        watchId: watch.watchId,
        watchName: watch.watchName,
        channelId: matchedMessage.channelId,
      });
    }
  }
}
