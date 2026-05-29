/**
 * Deepgram streaming STT adapter.
 *
 * One WebSocket per utterance. Send raw 16-bit PCM as binary frames,
 * then send `{"type":"Finalize"}` as a text frame to flush. Read JSON
 * messages until one carries `is_final: true` with the final transcript.
 *
 * API reference: https://developers.deepgram.com/docs/streaming
 */

import { WebSocket } from "ws";

import type { STTAdapter } from "./types.js";

interface DeepgramConfig {
  apiKey: string;
  /** Override the WS base URL; useful for tests. Default: wss://api.deepgram.com */
  baseUrl?: string;
  /** Deepgram model. Default: nova-2 */
  model?: string;
}

export class DeepgramSTTAdapter implements STTAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(cfg: DeepgramConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? "wss://api.deepgram.com";
    this.model = cfg.model ?? "nova-2";
  }

  async transcribeUtterance(pcm: Buffer): Promise<string> {
    const url =
      `${this.baseUrl}/v1/listen` +
      `?encoding=linear16&sample_rate=48000&channels=1` +
      `&model=${encodeURIComponent(this.model)}&punctuate=true&interim_results=false`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      let finalTranscript: string | null = null;

      const cleanup = () => {
        try {
          ws.close();
        } catch {
          // noop
        }
      };

      ws.on("open", () => {
        ws.send(pcm, { binary: true });
        ws.send(JSON.stringify({ type: "Finalize" }));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // Deepgram doesn't send binary back
        try {
          const msg = JSON.parse(data.toString());
          if (
            msg.is_final === true &&
            msg.channel?.alternatives?.[0]?.transcript !== undefined
          ) {
            finalTranscript = String(msg.channel.alternatives[0].transcript);
            cleanup();
          }
        } catch {
          // ignore non-JSON or malformed; rely on close/error path
        }
      });

      ws.on("close", () => {
        if (finalTranscript !== null) {
          resolve(finalTranscript);
        } else {
          reject(new Error("Deepgram WS closed with no final transcript"));
        }
      });

      ws.on("error", (err) => {
        reject(err);
      });
    });
  }
}
