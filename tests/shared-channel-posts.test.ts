import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Outbound items 4 and 5 from the spec's Message flow.
//
// 4. An issue assigned to a lead (the agentId of an agentBots entry, not an
//    alsoForAgentIds member) reaches `done`: the lead's bot posts one line in
//    the accomplishments channel.
// 5. A goal reaches `achieved`, or a project reaches `completed`: the bot of
//    the goal's ownerAgentId or the project's leadAgentId posts one line in
//    the milestones channel; with no match, the default bot posts.
//
// Both are opt-in by channel id, post only on a status change (never again on
// a later update to an item already there), and never mention anyone.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any, onMessage: any, options: any) => ({
    token,
    onInteraction,
    onMessage,
    options,
    close: () => {},
  })),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const MAIN_SECRET_ID = "33333333-3333-3333-3333-333333333333";
const CODA_SECRET_ID = "44444444-4444-4444-4444-444444444444";
const EMERY_SECRET_ID = "55555555-5555-5555-5555-555555555555";
const HANNA_ID = "999999999999999999";
const ACCOMPLISHMENTS = "1473919281581396181";
const MILESTONES = "1473935388040233136";

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

let httpFetchMock: ReturnType<typeof vi.fn>;

type Post = { channelId: string; token: string; body: any };

function posts(): Post[] {
  return httpFetchMock.mock.calls
    .filter(([url]: any[]) => String(url).includes("/messages"))
    .map(([url, init]: any[]) => ({
      channelId: String(url).match(/\/channels\/([^/]+)\/messages/)?.[1] ?? "",
      token: String(init?.headers?.Authorization ?? "").replace(/^Bot /, ""),
      body: JSON.parse(String(init?.body ?? "{}")),
    }));
}

function postsTo(channelId: string): Post[] {
  return posts().filter((p) => p.channelId === channelId);
}

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();
  const secretTokens: Record<string, string> = {
    [MAIN_SECRET_ID]: "main-bot-token",
    [CODA_SECRET_ID]: "coda-bot-token",
    [EMERY_SECRET_ID]: "emery-bot-token",
  };
  const stateKey = (key: any) => `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;

  const ctx = {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? {} : (() => { throw new Error("company context is required"); })())) },
    secrets: {
      resolve: vi.fn(async (ref: any) => {
        const id = ref?.secretId;
        if (id && secretTokens[id]) return secretTokens[id];
        throw new Error(`no token for ${id}`);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(stateKey(key)) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(stateKey(key), value);
      }),
      delete: vi.fn(async (key: any) => {
        stateStore.delete(stateKey(key));
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: { list: vi.fn(async () => [{ id: COMPANY_A, name: "A" }]) },
    agents: { list: vi.fn(async () => []) },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      listComments: vi.fn(async () => []),
    },
    goals: { get: vi.fn(async () => null) },
    projects: { get: vi.fn(async () => null) },
    http: { fetch: httpFetchMock },
  } as any;

  async function fire(eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
    for (const handler of eventHandlers.get(eventType) ?? []) {
      await handler({
        eventId: `evt-${Math.random().toString(36).slice(2)}`,
        eventType,
        companyId: COMPANY_A,
        entityId,
        entityType,
        occurredAt: "2026-09-26T00:00:00.000Z",
        payload,
      });
    }
  }

  return {
    ctx,
    stateStore,
    async deliver(config: Record<string, unknown> = {}) {
      await definition().onConfigChanged(baseConfig(config), { companyId: COMPANY_A });
    },
    issueUpdated: (payload: Record<string, unknown>, entityId = "issue-1") => fire("issue.updated", "issue", entityId, payload),
    goalUpdated: (payload: Record<string, unknown>, entityId = "goal-1") => fire("goal.updated", "goal", entityId, payload),
    projectUpdated: (payload: Record<string, unknown>, entityId = "project-1") => fire("project.updated", "project", entityId, payload),
  };
}

const AGENT_BOTS = [
  {
    agentId: "agent-coda",
    botTokenRef: { type: "secret_ref", secretId: CODA_SECRET_ID },
    channelId: "chan-coda",
    alsoForAgentIds: ["agent-clay"],
  },
  {
    agentId: "agent-emery",
    botTokenRef: { type: "secret_ref", secretId: EMERY_SECRET_ID },
    channelId: "chan-emery",
  },
];

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: MAIN_SECRET_ID, version: "latest" },
    defaultChannelId: "chan-default",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    notifyOnIssueDone: true,
    paperclipBaseUrl: "https://paperclip.test",
    agentBots: AGENT_BOTS,
    accomplishmentsChannelId: ACCOMPLISHMENTS,
    milestonesChannelId: MILESTONES,
    ...overrides,
  };
}

function doneIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "SAG-12",
    title: "Ship the milestone channel",
    status: "done",
    assigneeAgentId: "agent-coda",
    assigneeUserId: null,
    completedAt: "2026-09-26T02:00:00.000Z",
    updatedAt: "2026-09-26T02:00:00.000Z",
    ...overrides,
  };
}

function discordResponse(ok: boolean, status: number, text = "") {
  return {
    ok,
    status,
    headers: new Headers(),
    json: async () => ({ id: "posted-msg-1" }),
    text: async () => text,
  };
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  vi.clearAllMocks();
  httpFetchMock = vi.fn(async () => discordResponse(true, 200)) as any;
});

// ---------------------------------------------------------------------------
// Item 4: accomplishments
// ---------------------------------------------------------------------------

describe("accomplishments — a lead's issue reaches done", () => {
  it("posts one line in the accomplishments channel through the lead's bot", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    await host.issueUpdated({ status: "done", _previous: { status: "in_progress" } });

    const accomplishments = postsTo(ACCOMPLISHMENTS);
    expect(accomplishments).toHaveLength(1);
    expect(accomplishments[0].token).toBe("coda-bot-token");
    const content = String(accomplishments[0].body.content);
    expect(content).toContain("SAG-12");
    expect(content).toContain("Ship the milestone channel");
    expect(content).toContain("https://paperclip.test/issues/SAG-12");
    expect(content).not.toContain("\n");
  });

  it("keeps the existing done post in the default channel unchanged", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    await host.issueUpdated({ status: "done" });

    expect(postsTo("chan-default")).toHaveLength(1);
    expect(postsTo("chan-default")[0].token).toBe("main-bot-token");
    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(1);
  });

  it("posts even when the thread's done notification is turned off", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ notifyOnIssueDone: false });
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    await host.issueUpdated({ status: "done" });

    expect(posts().map((p) => p.channelId)).toEqual([ACCOMPLISHMENTS]);
  });

  it("collapses a multi-line title to one line", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue({ title: "First line\nsecond line" }));

    await host.issueUpdated({ status: "done" });

    const content = String(postsTo(ACCOMPLISHMENTS)[0].body.content);
    expect(content).toContain("First line second line");
    expect(content).not.toContain("\n");
  });
});

describe("accomplishments — a worker's issue reaches done", () => {
  it("posts nothing in the accomplishments channel for an alsoForAgentIds member", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue({ assigneeAgentId: "agent-clay" }));

    await host.issueUpdated({ status: "done" });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(0);
    // The one-line done post in the issue's channel stays as it is.
    expect(postsTo("chan-default")).toHaveLength(1);
  });

  it("posts nothing for an agent with no agentBots entry", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue({ assigneeAgentId: "agent-unmapped" }));

    await host.issueUpdated({ status: "done" });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(0);
  });

  it("posts nothing for a status other than done", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue({ status: "in_progress", completedAt: null }));

    await host.issueUpdated({ status: "in_progress" });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Settings are optional
// ---------------------------------------------------------------------------

describe("shared channel posts — a setting is missing", () => {
  it("posts no accomplishment when accomplishmentsChannelId is unset, and the done post is unchanged", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ accomplishmentsChannelId: undefined });
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    await host.issueUpdated({ status: "done" });

    expect(posts().map((p) => p.channelId)).toEqual(["chan-default"]);
  });

  it("posts no milestone when milestonesChannelId is unset, and never reads the goal or project", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ milestonesChannelId: "" });
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-coda" });
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Garden", status: "completed", leadAgentId: "agent-coda" });

    await host.goalUpdated({ status: "achieved" });
    await host.projectUpdated({ changedKeys: ["status"] });

    expect(posts()).toHaveLength(0);
    expect(host.ctx.goals.get).not.toHaveBeenCalled();
    expect(host.ctx.projects.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Item 5: milestones
// ---------------------------------------------------------------------------

describe("milestones — a goal is achieved", () => {
  it("posts through the owner's bot when ownerAgentId matches an agentBots entry", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "First client live", status: "achieved", ownerAgentId: "agent-emery" });

    await host.goalUpdated({ status: "achieved" });

    const milestones = postsTo(MILESTONES);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].token).toBe("emery-bot-token");
    expect(String(milestones[0].body.content)).toContain("First client live");
    expect(host.ctx.goals.get).toHaveBeenCalledWith("goal-1", COMPANY_A);
  });

  it("posts through the lead's bot when the owner is listed under alsoForAgentIds", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Clay's goal", status: "achieved", ownerAgentId: "agent-clay" });

    await host.goalUpdated({ status: "achieved" });

    expect(postsTo(MILESTONES)[0].token).toBe("coda-bot-token");
  });

  it("posts through the default bot when no entry matches the owner", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Company goal", status: "achieved", ownerAgentId: null });

    await host.goalUpdated({ status: "achieved" });

    const milestones = postsTo(MILESTONES);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].token).toBe("main-bot-token");
  });

  it("does nothing when the update did not touch status", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Renamed", status: "achieved", ownerAgentId: "agent-emery" });

    await host.goalUpdated({ title: "Renamed" });

    expect(posts()).toHaveLength(0);
    expect(host.ctx.goals.get).not.toHaveBeenCalled();
  });

  it("does nothing when the goal read shows a status other than achieved", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    // The event said achieved, but a later update already moved it on.
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Moved on", status: "active", ownerAgentId: "agent-emery" });

    await host.goalUpdated({ status: "achieved" });

    expect(posts()).toHaveLength(0);
  });

  it("logs a warning and posts nothing when the goal cannot be read", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockRejectedValue(new Error("missing capability goals.read"));

    await host.goalUpdated({ status: "achieved" });

    expect(posts()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("milestone"),
      expect.objectContaining({ entityId: "goal-1", error: "missing capability goals.read" }),
    );
  });
});

describe("milestones — a project is completed", () => {
  it("posts through the lead's bot when changedKeys includes status and the project is completed", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Garden v2", status: "completed", leadAgentId: "agent-coda" });

    await host.projectUpdated({ changedKeys: ["description", "status"] });

    const milestones = postsTo(MILESTONES);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].token).toBe("coda-bot-token");
    expect(String(milestones[0].body.content)).toContain("Garden v2");
    expect(host.ctx.projects.get).toHaveBeenCalledWith("project-1", COMPANY_A);
  });

  it("posts through the default bot when no entry matches the lead", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Orphan", status: "completed", leadAgentId: "agent-unmapped" });

    await host.projectUpdated({ changedKeys: ["status"] });

    expect(postsTo(MILESTONES)[0].token).toBe("main-bot-token");
  });

  it("does nothing when changedKeys does not include status", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Garden v2", status: "completed", leadAgentId: "agent-coda" });

    await host.projectUpdated({ changedKeys: ["description"] });

    expect(posts()).toHaveLength(0);
    expect(host.ctx.projects.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A repeat update to an item already there posts nothing
// ---------------------------------------------------------------------------

describe("shared channel posts — a repeat update to an item already there", () => {
  it("posts one accomplishment for an issue updated again while still done", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    await host.issueUpdated({ status: "done", _previous: { status: "in_progress" } });
    await host.issueUpdated({ priority: "high" });
    await host.issueUpdated({ status: "done" });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(1);
  });

  it("posts nothing when a PATCH re-sends done and only resets completedAt", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue());
    await host.issueUpdated({ status: "done", _previous: { status: "in_progress" } });

    // Paperclip's applyStatusSideEffects stamps a new completedAt on every
    // PATCH that carries status "done", even when the issue is already done.
    // The receipt's _previous then names completedAt but not status.
    host.ctx.issues.get.mockResolvedValue(doneIssue({ completedAt: "2026-09-26T05:00:00.000Z" }));
    await host.issueUpdated({ status: "done", _previous: { completedAt: "2026-09-26T02:00:00.000Z" } });
    await host.issueUpdated({ status: "done", _previous: { status: "done" } });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(1);
  });

  it("posts again when a reopened issue reaches done a second time", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.issues.get.mockResolvedValue(doneIssue());
    await host.issueUpdated({ status: "done" });

    host.ctx.issues.get.mockResolvedValue(doneIssue({ completedAt: "2026-09-27T09:00:00.000Z" }));
    await host.issueUpdated({ status: "done", _previous: { status: "in_progress" } });

    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(2);
  });

  it("posts one milestone for a goal patched to achieved twice", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-emery" });

    await host.goalUpdated({ status: "achieved" });
    await host.goalUpdated({ status: "achieved", description: "edited" });
    await host.goalUpdated({ title: "Launch!" });

    expect(postsTo(MILESTONES)).toHaveLength(1);
  });

  it("posts again when a goal leaves achieved and returns to it", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-emery" });
    await host.goalUpdated({ status: "achieved" });

    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "active", ownerAgentId: "agent-emery" });
    await host.goalUpdated({ status: "active" });

    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-emery" });
    await host.goalUpdated({ status: "achieved" });

    expect(postsTo(MILESTONES)).toHaveLength(2);
  });

  it("posts one milestone for a project whose status is re-sent as completed", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Garden v2", status: "completed", leadAgentId: "agent-coda" });

    await host.projectUpdated({ changedKeys: ["status"] });
    await host.projectUpdated({ changedKeys: ["status", "targetDate"] });

    expect(postsTo(MILESTONES)).toHaveLength(1);
  });

  it("releases the claim when a milestone post fails, so a later status update can post", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-emery" });

    httpFetchMock.mockResolvedValueOnce(discordResponse(false, 403, "Missing Access"));
    await host.goalUpdated({ status: "achieved" });
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("milestone"),
      expect.objectContaining({ entityId: "goal-1" }),
    );

    await host.goalUpdated({ status: "achieved" });
    // One failed attempt, one delivered post.
    expect(postsTo(MILESTONES)).toHaveLength(2);
    await host.goalUpdated({ status: "achieved" });
    expect(postsTo(MILESTONES)).toHaveLength(2);
  });

  it("releases the claim when an accomplishment post fails", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ notifyOnIssueDone: false });
    host.ctx.issues.get.mockResolvedValue(doneIssue());

    httpFetchMock.mockResolvedValueOnce(discordResponse(false, 403, "Missing Access"));
    await host.issueUpdated({ status: "done" });
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("accomplishment"),
      expect.objectContaining({ issueId: "issue-1" }),
    );

    await host.issueUpdated({ status: "done" });
    expect(postsTo(ACCOMPLISHMENTS)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Failures are logged, never silent
// ---------------------------------------------------------------------------

describe("shared channel posts — failures are logged", () => {
  it("warns when the done issue cannot be read, instead of treating it as a non-lead", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ notifyOnIssueDone: false });
    host.ctx.issues.get.mockRejectedValue(new Error("host unavailable"));

    await host.issueUpdated({ status: "done" });

    expect(posts()).toHaveLength(0);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the done issue's assignee"),
      expect.objectContaining({ issueId: "issue-1" }),
    );
  });

  it("logs an error when a failed post's claim cannot be released", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Launch", status: "achieved", ownerAgentId: "agent-emery" });
    httpFetchMock.mockResolvedValueOnce(discordResponse(false, 403, "Missing Access"));
    host.ctx.state.delete.mockRejectedValueOnce(new Error("state store down"));

    await host.goalUpdated({ status: "achieved" });

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("milestone: failed to post"),
      expect.objectContaining({ entityId: "goal-1" }),
    );
    expect(host.ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("could not release the dedup claim"),
      expect.objectContaining({ stateKey: "milestone_posted_goal_goal-1", error: "state store down" }),
    );
  });

  it("warns at configuration when accomplishmentsChannelId is set but agentBots is empty", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ agentBots: [] });

    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("agentBots is empty"),
      expect.objectContaining({ companyId: COMPANY_A }),
    );
  });
});

// ---------------------------------------------------------------------------
// The mention rule: neither post mentions Hanna, and Discord sends no push
// ---------------------------------------------------------------------------

describe("shared channel posts — the mention rule", () => {
  it("neither post mentions Hanna, and both suppress every mention", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver({ hannaDiscordUserId: HANNA_ID });
    host.ctx.issues.get.mockResolvedValue(doneIssue({ title: `Ping <@${HANNA_ID}> and @everyone` }));
    host.ctx.goals.get.mockResolvedValue({ id: "goal-1", title: "Goal @here", status: "achieved", ownerAgentId: "agent-emery" });
    host.ctx.projects.get.mockResolvedValue({ id: "project-1", name: "Project <@&123>", status: "completed", leadAgentId: "agent-coda" });

    await host.issueUpdated({ status: "done" });
    await host.goalUpdated({ status: "achieved" });
    await host.projectUpdated({ changedKeys: ["status"] });

    const shared = [...postsTo(ACCOMPLISHMENTS), ...postsTo(MILESTONES)];
    expect(shared).toHaveLength(3);
    for (const post of shared) {
      // allowed_mentions with an empty parse list: Discord resolves no user,
      // role, or @everyone mention in the content, so it sends no push.
      expect(post.body.allowed_mentions).toEqual({ parse: [] });
      // The plugin never adds a mention of its own.
      expect(String(post.body.content)).not.toMatch(/^<@/);
    }
  });
});
