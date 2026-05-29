/**
 * POST utterance transcripts to the war-room text channel via webhook,
 * surfaced as "Michael (voice)" so existing Alfred routing picks them up
 * exactly as if Michael had typed them.
 *
 * Discord webhook payload shape: { content, username, avatar_url? }.
 * Success = 204 No Content. We retry once on 5xx; hard-fail 4xx.
 *
 * Empty / whitespace-only transcripts are skipped — nothing meaningful
 * was said and posting noise to the war-room defeats the audit-trail value.
 */

import type { TextChannelRelay } from "./types.js";

interface RelayConfig {
  webhookUrl: string;
  /** Display username for the webhook posts. Default: "Michael (voice)" */
  username?: string;
}

export class WebhookTextChannelRelay implements TextChannelRelay {
  private readonly webhookUrl: string;
  private readonly username: string;

  constructor(cfg: RelayConfig) {
    this.webhookUrl = cfg.webhookUrl;
    this.username = cfg.username ?? "Michael (voice)";
  }

  async postTranscript(
    text: string,
    _metadata: { durationSec: number },
  ): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Skip empty/whitespace — nothing meaningful was said.
      return;
    }

    const body = JSON.stringify({
      content: trimmed,
      username: this.username,
    });

    // First attempt
    let resp = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    // Retry once on 5xx
    if (resp.status >= 500 && resp.status < 600) {
      resp = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "<no body>");
      throw new Error(
        `webhook POST failed: ${resp.status} ${resp.statusText} — ${errBody}`,
      );
    }
  }
}
