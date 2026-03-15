import { describe, it, expect } from "vitest";
import { extractSignals, type Signal } from "../src/intelligence.js";
import type { DiscordChannelMessage } from "../src/discord-api.js";

function makeMessage(
  overrides: Partial<DiscordChannelMessage> = {},
): DiscordChannelMessage {
  return {
    id: "msg-1",
    content: "Hello world, this is a test message",
    author: { id: "user-1", username: "testuser" },
    timestamp: "2026-03-15T12:00:00Z",
    member: { roles: [] },
    ...overrides,
  };
}

const ROLE_WEIGHT_MAP = new Map([
  ["role-admin", 5],
  ["role-contrib", 3],
  ["role-member", 1],
]);

describe("extractSignals", () => {
  it("detects feature wishes", () => {
    const messages = [
      makeMessage({ content: "I wish we had better logging for agent runs" }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.category).toBe("feature_wish");
  });

  it("detects pain points", () => {
    const messages = [
      makeMessage({ content: "The dashboard doesn't work on mobile, it's broken" }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.category).toBe("pain_point");
  });

  it("only flags maintainer_directive when author has weight >= 3", () => {
    const messages = [
      makeMessage({
        content: "We're planning to release the new budget system next week",
        member: { roles: ["role-member"] },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0); // weight 1, needs >= 3

    const adminMessages = [
      makeMessage({
        content: "We're planning to release the new budget system next week",
        member: { roles: ["role-admin"] },
      }),
    ];
    const adminSignals = extractSignals(adminMessages, ROLE_WEIGHT_MAP, "ch-1");
    expect(adminSignals).toHaveLength(1);
    expect(adminSignals[0]?.category).toBe("maintainer_directive");
  });

  it("skips bot messages", () => {
    const messages = [
      makeMessage({
        content: "I wish we had better support",
        author: { id: "bot-1", username: "github[bot]" },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0);
  });

  it("skips very short messages", () => {
    const messages = [makeMessage({ content: "bug" })];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0);
  });

  it("assigns correct author weight from roles", () => {
    const messages = [
      makeMessage({
        content: "I wish we had a Discord integration for notifications",
        member: { roles: ["role-contrib"] },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals[0]?.authorWeight).toBe(3);
  });

  it("truncates long message text to 500 chars", () => {
    const longContent = "I wish we had " + "x".repeat(600);
    const messages = [makeMessage({ content: longContent })];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals[0]?.text.length).toBeLessThanOrEqual(500);
  });
});
