import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";

const GATEWAY_VERSION = "10";
const GATEWAY_ENCODING = "json";
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RECONNECT_MS = 5000;

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface ReadyEvent {
  session_id: string;
  resume_gateway_url: string;
}

interface InteractionCreateEvent {
  id: string;
  token: string;
  type: number;
  data?: Record<string, unknown>;
  member?: { user: { username: string } };
  guild_id?: string;
  channel_id?: string;
}

type InteractionHandler = (interaction: InteractionCreateEvent) => Promise<unknown>;

export async function respondViaCallback(
  ctx: PluginContext,
  interactionId: string,
  interactionToken: string,
  responseData: unknown,
): Promise<void> {
  const url = `${DISCORD_API_BASE}/interactions/${interactionId}/${interactionToken}/callback`;
  try {
    const response = await ctx.http.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseData),
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Interaction callback failed", {
        status: response.status,
        body: text,
      });
    }
  } catch (error) {
    ctx.logger.error("Interaction callback error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function connectGateway(
  ctx: PluginContext,
  token: string,
  onInteraction: InteractionHandler,
): Promise<{ close: () => void }> {
  const gatewayUrl = await getGatewayUrl(ctx, token);
  if (!gatewayUrl) {
    ctx.logger.warn("Could not get Gateway URL, interactions will only work via webhook");
    return { close: () => {} };
  }

  let ws: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let heartbeatAckTimeout: ReturnType<typeof setTimeout> | null = null;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let closed = false;
  let consecutiveFailures = 0;
  let lastHeartbeatIntervalMs = 41250;

  function getReconnectDelay(): number {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return MAX_BACKOFF_MS;
    }
    return DEFAULT_RECONNECT_MS;
  }

  function connect(url: string, resume: boolean) {
    if (closed) return;

    const wsUrl = `${url}/?v=${GATEWAY_VERSION}&encoding=${GATEWAY_ENCODING}`;
    ctx.logger.info("Connecting to Discord Gateway", { resume, consecutiveFailures });

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ctx.logger.info("Gateway WebSocket connected");
    };

    ws.onmessage = async (event) => {
      const payload = JSON.parse(String(event.data)) as GatewayPayload;

      if (payload.s !== null) {
        sequence = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const heartbeatMs = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
          lastHeartbeatIntervalMs = heartbeatMs;
          startHeartbeat(heartbeatMs);

          if (resume && sessionId) {
            ws?.send(JSON.stringify({
              op: 6,
              d: { token: `Bot ${token}`, session_id: sessionId, seq: sequence },
            }));
          } else {
            ws?.send(JSON.stringify({
              op: 2,
              d: {
                token: `Bot ${token}`,
                intents: 1,
                properties: {
                  os: "linux",
                  browser: "paperclip-plugin-discord",
                  device: "paperclip-plugin-discord",
                },
              },
            }));
          }
          break;
        }

        case 0: {
          if (payload.t === "READY") {
            const ready = payload.d as ReadyEvent;
            sessionId = ready.session_id;
            resumeUrl = ready.resume_gateway_url;
            consecutiveFailures = 0;
            ctx.logger.info("Gateway ready", { sessionId });
          }

          if (payload.t === "RESUMED") {
            consecutiveFailures = 0;
            ctx.logger.info("Gateway resumed successfully");
          }

          if (payload.t === "INTERACTION_CREATE") {
            const interaction = payload.d as InteractionCreateEvent;
            try {
              const response = await onInteraction(interaction);
              await respondViaCallback(ctx, interaction.id, interaction.token, response);
            } catch (error) {
              ctx.logger.error("Gateway interaction handler error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          break;
        }

        case 1: {
          ws?.send(JSON.stringify({ op: 1, d: sequence }));
          break;
        }

        case 7: {
          ctx.logger.info("Gateway requested reconnect");
          cleanup();
          await ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1);
          connect(resumeUrl ?? url, true);
          break;
        }

        case 9: {
          const resumable = payload.d as boolean;
          ctx.logger.info("Invalid session", { resumable });
          cleanup();
          if (!resumable) {
            sessionId = null;
            sequence = null;
          }
          consecutiveFailures++;
          await ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1);
          const delay = 1000 + Math.random() * 4000;
          setTimeout(() => connect(url, resumable), delay);
          break;
        }

        case 11: {
          if (heartbeatAckTimeout) {
            clearTimeout(heartbeatAckTimeout);
            heartbeatAckTimeout = null;
          }
          break;
        }
      }
    };

    ws.onclose = (event) => {
      ctx.logger.info("Gateway WebSocket closed", { code: event.code, reason: event.reason });
      cleanup();
      if (!closed && event.code !== 4004) {
        consecutiveFailures++;
        ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1).catch(() => {});
        const delay = getReconnectDelay();
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          ctx.logger.error("Gateway reconnection failing repeatedly, backing off", {
            consecutiveFailures,
            delayMs: delay,
          });
        }
        setTimeout(() => connect(resumeUrl ?? url, sessionId !== null), delay);
      }
    };

    ws.onerror = (event) => {
      ctx.logger.warn("Gateway WebSocket error", {
        error: String(event),
      });
    };
  }

  function startHeartbeat(intervalMs: number) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatAckTimeout) clearTimeout(heartbeatAckTimeout);

    const sendHeartbeat = () => {
      ws?.send(JSON.stringify({ op: 1, d: sequence }));
      heartbeatAckTimeout = setTimeout(() => {
        ctx.logger.warn("Heartbeat ACK not received, forcing reconnect");
        cleanup();
        consecutiveFailures++;
        ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1).catch(() => {});
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, "Heartbeat timeout");
        }
      }, intervalMs * 2);
    };

    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      sendHeartbeat();
      heartbeatInterval = setInterval(sendHeartbeat, intervalMs);
    }, jitter);
  }

  function cleanup() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (heartbeatAckTimeout) {
      clearTimeout(heartbeatAckTimeout);
      heartbeatAckTimeout = null;
    }
  }

  connect(gatewayUrl, false);

  return {
    close: () => {
      closed = true;
      cleanup();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Plugin shutting down");
      }
    },
  };
}

async function getGatewayUrl(ctx: PluginContext, token: string): Promise<string | null> {
  try {
    const response = await ctx.http.fetch(`${DISCORD_API_BASE}/gateway/bot`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      ctx.logger.warn("Failed to get Gateway URL", { status: response.status });
      return null;
    }
    const data = (await response.json()) as { url: string };
    return data.url;
  } catch (error) {
    ctx.logger.error("Gateway URL fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
