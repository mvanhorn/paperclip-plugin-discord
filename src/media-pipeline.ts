import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postEmbed } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Phase 3: Media Pipeline
//   - Intake detection (audio, video, image attachments)
//   - Whisper transcription for audio/video
//   - Brief Agent routing for summarization
// ---------------------------------------------------------------------------

export interface MediaAttachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size: number;
}

export type MediaType = "audio" | "video" | "image" | "unknown";

const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/aac",
  "audio/m4a",
]);

const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
]);

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function classifyMedia(attachment: MediaAttachment): MediaType {
  const ct = attachment.content_type?.toLowerCase() ?? "";
  if (AUDIO_TYPES.has(ct)) return "audio";
  if (VIDEO_TYPES.has(ct)) return "video";
  if (IMAGE_TYPES.has(ct)) return "image";

  const ext = attachment.filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";

  return "unknown";
}

export function detectMedia(
  attachments: MediaAttachment[],
): Array<{ attachment: MediaAttachment; mediaType: MediaType }> {
  const results: Array<{ attachment: MediaAttachment; mediaType: MediaType }> = [];
  for (const att of attachments) {
    const mediaType = classifyMedia(att);
    if (mediaType !== "unknown") {
      results.push({ attachment: att, mediaType });
    }
  }
  return results;
}

export async function transcribeAudio(
  ctx: PluginContext,
  audioUrl: string,
  companyId: string,
): Promise<string | null> {
  try {
    const result = await ctx.agents.invoke("whisper-transcription", companyId, {
      prompt: `Transcribe the audio file at: ${audioUrl}`,
      reason: "Discord media pipeline transcription",
    });
    return (result as { runId: string }).runId ? "Transcription started — results will appear when ready." : null;
  } catch (err) {
    ctx.logger.warn("Whisper transcription invoke failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function routeToBriefAgent(
  ctx: PluginContext,
  companyId: string,
  content: string,
  sourceChannelId: string,
  sourceMessageId: string,
): Promise<string | null> {
  try {
    const result = await ctx.agents.invoke("brief-agent", companyId, {
      prompt: `Summarize the following content from Discord (channel: ${sourceChannelId}, message: ${sourceMessageId}):\n\n${content}`,
      reason: "Discord media pipeline brief",
    });
    return (result as { runId: string }).runId ?? null;
  } catch (err) {
    ctx.logger.warn("Brief agent invoke failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function processMediaMessage(
  ctx: PluginContext,
  token: string,
  channelId: string,
  messageId: string,
  attachments: MediaAttachment[],
  companyId: string,
): Promise<void> {
  const detected = detectMedia(attachments);
  if (detected.length === 0) return;

  for (const { attachment, mediaType } of detected) {
    ctx.logger.info("Media detected in Discord message", {
      channelId,
      messageId,
      filename: attachment.filename,
      mediaType,
    });

    if (mediaType === "audio" || mediaType === "video") {
      await postEmbed(ctx, token, channelId, {
        embeds: [{
          title: `Processing ${mediaType}: ${attachment.filename}`,
          description: "Sending to transcription pipeline...",
          color: COLORS.BLUE,
          footer: { text: "Paperclip Media Pipeline" },
          timestamp: new Date().toISOString(),
        }],
      });

      const transcriptResult = await transcribeAudio(ctx, attachment.url, companyId);
      if (transcriptResult) {
        await routeToBriefAgent(ctx, companyId, transcriptResult, channelId, messageId);
      }
    }

    if (mediaType === "image") {
      await postEmbed(ctx, token, channelId, {
        embeds: [{
          title: `Image detected: ${attachment.filename}`,
          description: "Routing to Brief Agent for analysis...",
          color: COLORS.BLUE,
          footer: { text: "Paperclip Media Pipeline" },
          timestamp: new Date().toISOString(),
        }],
      });

      await routeToBriefAgent(
        ctx,
        companyId,
        `Image attachment: ${attachment.url} (${attachment.filename})`,
        channelId,
        messageId,
      );
    }

    await ctx.metrics.write(METRIC_NAMES.mediaProcessed, 1);
  }
}
