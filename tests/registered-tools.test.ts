import { describe, it, expect, vi } from "vitest";
import manifest from "../src/manifest.js";

// ---------------------------------------------------------------------------
// The full list of registered tools (plan item 6).
//
// discuss_with_agent, handoff_to_agent, register_custom_command, and
// register_watch are removed: the v1 runaway came from agents waking agents,
// so nothing an agent can call may hand off to, discuss with, or register new
// work for another agent. This test names the exact tool set left — not just
// "the four are gone" — so a tool added later has to be named here too.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import { _resetRuntimeForTests } from "../src/worker.js";

function getDefinition(): any {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function buildPluginContext() {
  const registeredTools: string[] = [];
  const ctx = {
    config: { get: vi.fn().mockResolvedValue({}) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: {
      register: vi.fn().mockImplementation((name: string) => {
        registeredTools.push(name);
      }),
    },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn() },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: { fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) },
  } as any;

  return { ctx, registeredTools };
}

const EXPECTED_TOOLS = ["escalate_to_human", "discord_signals"];

const REMOVED_TOOLS = [
  "discuss_with_agent",
  "handoff_to_agent",
  "register_custom_command",
  "register_watch",
];

describe("registered tools (plan item 6)", () => {
  it("registers exactly the surviving tool set, and nothing removed", async () => {
    _resetRuntimeForTests();
    const { ctx, registeredTools } = buildPluginContext();

    await getDefinition().setup(ctx);

    expect(registeredTools.sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const removed of REMOVED_TOOLS) {
      expect(registeredTools).not.toContain(removed);
    }
  });

  it("keeps the manifest's tool list in sync with what setup() actually registers", async () => {
    _resetRuntimeForTests();
    const { ctx, registeredTools } = buildPluginContext();

    await getDefinition().setup(ctx);

    const manifestToolNames = (manifest.tools ?? []).map((t) => t.name);
    expect(manifestToolNames.sort()).toEqual([...registeredTools].sort());
  });
});
