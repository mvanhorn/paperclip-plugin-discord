import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type DiscordChannelMessage,
  type DiscordGuildRole,
  getChannelMessages,
  getGuildRoles,
} from "./discord-api.js";
import {
  DEFAULT_ROLE_WEIGHT,
  METRIC_NAMES,
  ROLE_WEIGHTS,
} from "./constants.js";

export interface Signal {
  category: "feature_wish" | "pain_point" | "maintainer_directive" | "sentiment";
  text: string;
  author: string;
  authorWeight: number;
  channelId: string;
  timestamp: string;
  messageId: string;
}

const SIGNAL_PATTERNS: Array<{
  category: Signal["category"];
  patterns: RegExp[];
}> = [
  {
    category: "feature_wish",
    patterns: [
      /\bi wish\b/i,
      /\bwe need\b/i,
      /\bfeature request\b/i,
      /\bwould be nice\b/i,
      /\bcan we add\b/i,
      /\bshould support\b/i,
      /\bplease add\b/i,
    ],
  },
  {
    category: "pain_point",
    patterns: [
      /\bi'm stuck\b/i,
      /\bdoesn'?t work\b/i,
      /\bbug\b/i,
      /\bbroken\b/i,
      /\bcrash/i,
      /\berror\b/i,
      /\bfrustrat/i,
    ],
  },
  {
    category: "maintainer_directive",
    patterns: [
      /\bwe('re| are) (going to|planning)\b/i,
      /\broadmap\b/i,
      /\bnext release\b/i,
      /\bpriority\b/i,
      /\bwe decided\b/i,
    ],
  },
  {
    category: "sentiment",
    patterns: [
      /\blove (this|it|paperclip)\b/i,
      /\bamazing\b/i,
      /\bgreat (tool|project|work)\b/i,
      /\bdisappoint/i,
      /\bswitching (to|from)\b/i,
    ],
  },
];

function buildRoleWeightMap(
  roles: DiscordGuildRole[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const role of roles) {
    const name = role.name.toLowerCase();
    const weight = ROLE_WEIGHTS[name] ?? DEFAULT_ROLE_WEIGHT;
    map.set(role.id, weight);
  }
  return map;
}

function getAuthorWeight(
  memberRoles: string[] | undefined,
  roleWeightMap: Map<string, number>,
): number {
  if (!memberRoles || memberRoles.length === 0) return DEFAULT_ROLE_WEIGHT;
  let maxWeight = DEFAULT_ROLE_WEIGHT;
  for (const roleId of memberRoles) {
    const w = roleWeightMap.get(roleId);
    if (w && w > maxWeight) maxWeight = w;
  }
  return maxWeight;
}

function classifyMessage(content: string): Signal["category"] | null {
  for (const { category, patterns } of SIGNAL_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(content)) return category;
    }
  }
  return null;
}

export function extractSignals(
  messages: DiscordChannelMessage[],
  roleWeightMap: Map<string, number>,
  channelId: string,
): Signal[] {
  const signals: Signal[] = [];

  for (const msg of messages) {
    if (msg.author.username.endsWith("[bot]")) continue;
    if (msg.content.length < 10) continue;

    const category = classifyMessage(msg.content);
    if (!category) continue;

    const authorWeight = getAuthorWeight(msg.member?.roles, roleWeightMap);

    // Only flag maintainer_directive if the author has weight >= 3
    if (category === "maintainer_directive" && authorWeight < 3) continue;

    signals.push({
      category,
      text: msg.content.slice(0, 500),
      author: msg.author.username,
      authorWeight,
      channelId,
      timestamp: msg.timestamp,
      messageId: msg.id,
    });
  }

  return signals;
}

export async function runIntelligenceScan(
  ctx: PluginContext,
  token: string,
  guildId: string,
  channelIds: string[],
  companyId: string,
): Promise<Signal[]> {
  if (channelIds.length === 0) return [];

  const roles = await getGuildRoles(ctx, token, guildId);
  const roleWeightMap = buildRoleWeightMap(roles);

  const allSignals: Signal[] = [];

  for (const channelId of channelIds) {
    const messages = await getChannelMessages(ctx, token, channelId, 100);
    const signals = extractSignals(messages, roleWeightMap, channelId);
    allSignals.push(...signals);
  }

  // Sort by weight (highest first), then by timestamp (newest first)
  allSignals.sort((a, b) => {
    if (b.authorWeight !== a.authorWeight) return b.authorWeight - a.authorWeight;
    return b.timestamp.localeCompare(a.timestamp);
  });

  // Store in plugin state
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      stateKey: "discord_intelligence",
    },
    {
      signals: allSignals.slice(0, 50), // cap at 50 most relevant
      lastScanned: new Date().toISOString(),
      channelsScanned: channelIds.length,
    },
  );

  await ctx.metrics.write(METRIC_NAMES.signalsExtracted, allSignals.length);
  ctx.logger.info("Intelligence scan complete", {
    signals: allSignals.length,
    channels: channelIds.length,
  });

  return allSignals;
}
