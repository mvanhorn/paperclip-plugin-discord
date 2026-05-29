import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { DeepgramSTTAdapter } from "../src/voice/stt-deepgram.js";

let mockServer: WebSocketServer | undefined;

function makeServer(handler: (ws: WebSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    mockServer = new WebSocketServer({ port: 0 }, () => {
      const port = (mockServer!.address() as { port: number }).port;
      resolve(port);
    });
    mockServer.on("connection", handler);
  });
}

afterEach(() => {
  mockServer?.close();
  mockServer = undefined;
});

describe("DeepgramSTTAdapter", () => {
  it("sends PCM then Finalize and resolves with final transcript", async () => {
    let receivedBinary = false;
    let receivedFinalize = false;
    const port = await makeServer((ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          receivedBinary = true;
        } else {
          const msg = JSON.parse(data.toString());
          if (msg.type === "Finalize") {
            receivedFinalize = true;
            ws.send(
              JSON.stringify({
                type: "Results",
                is_final: true,
                channel: { alternatives: [{ transcript: "hello world" }] },
              }),
            );
          }
        }
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });
    const transcript = await adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4]));

    expect(receivedBinary).toBe(true);
    expect(receivedFinalize).toBe(true);
    expect(transcript).toBe("hello world");
  });

  it("rejects on WS close without a final result", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", () => {
        ws.close();
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(
      adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4])),
    ).rejects.toThrow(/no final transcript/i);
  });

  it("rejects on WS auth-failure close", async () => {
    const port = await makeServer((ws) => {
      // simulate Deepgram-style auth-failure close
      ws.close(4001, "unauthorized");
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "bad-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(
      adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4])),
    ).rejects.toThrow();
  });

  it("returns empty string when transcript is empty (silence)", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", (_data, isBinary) => {
        if (!isBinary) {
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              channel: { alternatives: [{ transcript: "" }] },
            }),
          );
        }
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });
    const transcript = await adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4]));
    expect(transcript).toBe("");
  });
});
