import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Deciding a delivery from Discord's approvals channel.
//
// A delivery waiting on Hanna is an issue at `in_review`, assigned to
// `local-board`, with an `approval` execution stage whose current participant
// is `local-board`. Paperclip has no decision route: the UI resolves it with
// `PATCH /api/issues/:id`, and the execution-policy service reads the status
// and the comment off that patch.
//   - accept          → { status: "done",        comment: <fixed text> }
//   - request changes → { status: "in_progress", comment: <Hanna's reason> }
// Both comments are required by the server. See the citations in
// `src/commands.ts` beside the calls themselves.
// ---------------------------------------------------------------------------

const mockPaperclipFetch = vi.fn();
vi.mock("../src/paperclip-fetch.js", () => ({
  paperclipFetch: (...args: unknown[]) => mockPaperclipFetch(...args),
}));

// The real `withRetry`, with every options object it is handed recorded. The
// decision path has to fit inside Discord's three-second acknowledgement
// window, which is a property of the options, not of the happy path.
const { retryOptions } = vi.hoisted(() => ({ retryOptions: [] as unknown[] }));
vi.mock("../src/retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/retry.js")>();
  return {
    ...actual,
    withRetry: (fn: () => Promise<unknown>, opts?: unknown) => {
      retryOptions.push(opts);
      return actual.withRetry(fn, opts as never);
    },
  };
});

const ISSUE_ID = "77777777-7777-7777-7777-777777777777";
const BASE = "http://localhost:3100";

const cmdCtx: CommandContext = {
  baseUrl: BASE,
  companyId: "company-1",
  token: "test-token",
  paperclipBoardApiKey: "board-key",
  defaultChannelId: "ch-1",
};

function makeCtx() {
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    issues: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(null) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    companies: { list: vi.fn().mockResolvedValue([]) },
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function okResponse(json: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => json, text: async () => "" };
}

/** The issue read the handlers make before either PATCH. */
function waitingIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    identifier: "SAG-42",
    title: "Ship the thing",
    status: "in_review",
    assigneeUserId: "local-board",
    ...overrides,
  };
}

function buttonInteraction(customId: string) {
  return {
    type: 3,
    data: { name: "", custom_id: customId, component_type: 2 },
    member: { user: { username: "hanna" } },
  } as any;
}

function modalInteraction(customId: string, reason: string) {
  return {
    type: 5,
    data: {
      custom_id: customId,
      components: [
        { type: 1, components: [{ type: 4, custom_id: "reason", value: reason }] },
      ],
    },
    member: { user: { username: "hanna" } },
  } as any;
}

function patchCalls() {
  return mockPaperclipFetch.mock.calls.filter(([, init]: any[]) => init?.method === "PATCH");
}

beforeEach(() => {
  mockPaperclipFetch.mockReset();
  retryOptions.length = 0;
});

describe("delivery accept", () => {
  it("reads the issue, then PATCHes status done with the fixed acceptance comment", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "done" }));

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_accept_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    expect(mockPaperclipFetch).toHaveBeenCalledTimes(2);

    const [readUrl, readInit, readKey] = mockPaperclipFetch.mock.calls[0];
    expect(readUrl).toBe(`${BASE}/api/issues/${ISSUE_ID}`);
    expect(readInit.method).toBe("GET");
    expect(readKey).toBe("board-key");

    const [patchUrl, patchInit, patchKey] = patchCalls()[0];
    expect(patchUrl).toBe(`${BASE}/api/issues/${ISSUE_ID}`);
    expect(patchInit.method).toBe("PATCH");
    expect(patchKey).toBe("board-key");
    expect(JSON.parse(patchInit.body)).toEqual({
      status: "done",
      comment: "Accepted by Hanna from Discord.",
    });

    expect(result.type).toBe(7);
    expect(result.data.components).toEqual([]);
    expect(JSON.stringify(result.data.embeds)).toContain("Accepted by Hanna");
  });

  it("leaves the buttons in place when the PATCH fails, and keeps the detail out of the channel", async () => {
    // A type 7 response edits the message everyone in the approvals channel
    // sees, and a PaperclipFetchError carries the request URL plus 200
    // characters of the Paperclip response body. The channel gets a short,
    // non-specific line; the detail belongs to the log, which already has it.
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockRejectedValueOnce(
        new Error("paperclipFetch PATCH http://localhost:3100/api/issues/x → 500 boom"),
      );

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_accept_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    expect(result.type).toBe(7);
    expect(result.data.components).toBeUndefined();
    const rendered = JSON.stringify(result.data.embeds);
    expect(rendered).toContain("Could not record the decision");
    expect(rendered).not.toContain("boom");
    expect(rendered).not.toContain("localhost:3100");

    const [, logged] = ctx.logger.error.mock.calls.at(-1) as any[];
    expect(logged.error).toContain("boom");
    expect(ctx.metrics.write).not.toHaveBeenCalled();
  });

  it("leaves the buttons in place when the issue read fails, and redacts the same way", async () => {
    mockPaperclipFetch.mockRejectedValueOnce(
      new Error("paperclipFetch GET http://localhost:3100/api/issues/x → 503 unavailable"),
    );

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_accept_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    expect(patchCalls()).toHaveLength(0);
    expect(result.type).toBe(7);
    expect(result.data.components).toBeUndefined();
    const rendered = JSON.stringify(result.data.embeds);
    expect(rendered).toContain("Could not read the issue");
    expect(rendered).not.toContain("unavailable");
    expect(rendered).not.toContain("localhost:3100");

    const [, logged] = ctx.logger.error.mock.calls.at(-1) as any[];
    expect(logged.error).toContain("unavailable");
  });

  it("keeps the board API key out of the log line as well", async () => {
    mockPaperclipFetch.mockRejectedValueOnce(new Error("GET failed with key board-key"));

    const ctx = makeCtx();
    await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), cmdCtx);

    const [, logged] = ctx.logger.error.mock.calls.at(-1) as any[];
    expect(logged.error).not.toContain("board-key");
    expect(logged.error).toContain("[redacted]");
  });
});

describe("delivery request changes", () => {
  it("opens a modal naming the issue, and sends no PATCH yet", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_changes_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(9);
    expect(result.data.custom_id).toBe(`delivery_changes_modal_${ISSUE_ID}`);
    const row = result.data.components[0];
    expect(row.type).toBe(1);
    expect(row.components[0]).toMatchObject({ type: 4, style: 2, required: true, custom_id: "reason" });
  });

  it("PATCHes status in_progress with Hanna's reason on submit", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "in_progress" }));

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "The copy is wrong on step 2."),
      cmdCtx,
    )) as any;

    const [patchUrl, patchInit] = patchCalls()[0];
    expect(patchUrl).toBe(`${BASE}/api/issues/${ISSUE_ID}`);
    expect(JSON.parse(patchInit.body)).toEqual({
      status: "in_progress",
      comment: "The copy is wrong on step 2.",
    });

    expect(result.type).toBe(7);
    expect(result.data.components).toEqual([]);
    const rendered = JSON.stringify(result.data.embeds);
    expect(rendered).toContain("Changes requested by Hanna");
    expect(rendered).toContain("The copy is wrong on step 2.");
  });

  it("leaves the buttons in place when the submit PATCH fails", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockRejectedValueOnce(new Error("paperclipFetch PATCH → 422 needs a comment"));

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "Redo the header."),
      cmdCtx,
    )) as any;

    expect(result.type).toBe(7);
    expect(result.data.components).toBeUndefined();
  });

  it("refuses an empty reason without calling the API", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "   "),
      cmdCtx,
    )) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
  });
});

describe("delivery staleness and idempotence", () => {
  it("sends no PATCH when the issue has left in_review", async () => {
    mockPaperclipFetch.mockResolvedValueOnce(okResponse(waitingIssue({ status: "done" })));

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_accept_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    expect(patchCalls()).toHaveLength(0);
    expect(result.type).toBe(7);
    expect(result.data.components).toEqual([]);
    expect(JSON.stringify(result.data.embeds)).toContain("no longer waiting");
  });

  it("sends no PATCH when the issue is no longer assigned to the board", async () => {
    mockPaperclipFetch.mockResolvedValueOnce(okResponse(waitingIssue({ assigneeUserId: null })));

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "Try again."),
      cmdCtx,
    )) as any;

    expect(patchCalls()).toHaveLength(0);
    expect(result.data.components).toEqual([]);
  });

  it("a second accept press after the first succeeded sends no second PATCH", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "done" }))
      .mockResolvedValueOnce(okResponse(waitingIssue({ status: "done" })));

    const ctx = makeCtx();
    await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), cmdCtx);
    await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), cmdCtx);

    expect(patchCalls()).toHaveLength(1);
  });
});

describe("delivery decisions need a board API key", () => {
  it("refuses with an ephemeral message rather than calling the API", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), {
      ...cmdCtx,
      paperclipBoardApiKey: "",
    })) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
  });

  it("refuses a modal submit the same way", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "Do it again."),
      { ...cmdCtx, paperclipBoardApiKey: "" },
    )) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// The issue id in a `custom_id` is untrusted input.
//
// Discord hands the `custom_id` straight back, so the id it carries is under
// the sender's control. It lands in `${base}/api/issues/${id}`, a request that
// carries the board API key, and `fetch` resolves dot segments in a path — so
// `delivery_accept_../../anything` would send that key somewhere else in
// Paperclip. Nothing that fails the UUID shape reaches the network.
// ---------------------------------------------------------------------------

describe("the issue id from a custom_id", () => {
  const BAD_IDS = [
    "../../anything",
    "..%2f..%2fanything",
    "77777777-7777-7777-7777-777777777777/comments",
    "77777777-7777-7777-7777-777777777777?x=1",
    "not-a-uuid",
    "",
  ];

  for (const bad of BAD_IDS) {
    it(`refuses the accept button for ${JSON.stringify(bad)} without calling the API`, async () => {
      const ctx = makeCtx();
      const result = (await handleInteraction(
        ctx,
        buttonInteraction(`delivery_accept_${bad}`),
        cmdCtx,
      )) as any;

      expect(mockPaperclipFetch).not.toHaveBeenCalled();
      expect(result.type).toBe(4);
      expect(result.data.flags).toBe(64);
      expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it(`refuses the request-changes button for ${JSON.stringify(bad)} without opening a modal`, async () => {
      const ctx = makeCtx();
      const result = (await handleInteraction(
        ctx,
        buttonInteraction(`delivery_changes_${bad}`),
        cmdCtx,
      )) as any;

      expect(mockPaperclipFetch).not.toHaveBeenCalled();
      expect(result.type).toBe(4);
      expect(result.data.flags).toBe(64);
    });

    it(`refuses the modal submit for ${JSON.stringify(bad)} without calling the API`, async () => {
      const ctx = makeCtx();
      const result = (await handleInteraction(
        ctx,
        modalInteraction(`delivery_changes_modal_${bad}`, "Change it."),
        cmdCtx,
      )) as any;

      expect(mockPaperclipFetch).not.toHaveBeenCalled();
      expect(result.type).toBe(4);
      expect(result.data.flags).toBe(64);
    });
  }

  it("encodes the id it does accept into the URL path", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "done" }));

    const ctx = makeCtx();
    await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), cmdCtx);

    for (const [url] of mockPaperclipFetch.mock.calls) {
      expect(String(url)).toBe(`${BASE}/api/issues/${encodeURIComponent(ISSUE_ID)}`);
      expect(String(url)).not.toContain("..");
    }
  });
});

// ---------------------------------------------------------------------------
// The three-second acknowledgement window.
//
// The gateway awaits the whole handler before answering Discord, and nothing
// defers the interaction, so the GET and the PATCH both have to finish inside
// three seconds. The default retry budget — three retries at a 1,000 ms base,
// doubling — spends up to seven seconds on one call alone, so one transient
// 429 or 500 on the GET would show Hanna "This interaction failed" while the
// PATCH still landed. The budget is asserted here rather than the timing.
// ---------------------------------------------------------------------------

describe("the decision's retry budget", () => {
  /** Worst-case wall time of one withRetry budget: every backoff, summed. */
  function worstCaseMs(opts: any): number {
    const maxRetries = opts?.maxRetries ?? 3;
    const baseDelayMs = opts?.baseDelayMs ?? 1000;
    let total = 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      total += baseDelayMs * Math.pow(2, attempt);
    }
    return total;
  }

  it("passes a tight budget to both the read and the decision call", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "done" }));

    const ctx = makeCtx();
    await handleInteraction(ctx, buttonInteraction(`delivery_accept_${ISSUE_ID}`), cmdCtx);

    expect(retryOptions).toHaveLength(2);
    for (const opts of retryOptions) {
      expect(opts).toEqual({ maxRetries: 1, baseDelayMs: 200 });
    }

    const budget = retryOptions.reduce((sum, opts) => sum + worstCaseMs(opts), 0);
    expect(budget).toBeLessThan(3000);
  });

  it("gives the modal submit the same budget", async () => {
    mockPaperclipFetch
      .mockResolvedValueOnce(okResponse(waitingIssue()))
      .mockResolvedValueOnce(okResponse({ id: ISSUE_ID, status: "in_progress" }));

    const ctx = makeCtx();
    await handleInteraction(
      ctx,
      modalInteraction(`delivery_changes_modal_${ISSUE_ID}`, "Redo the header."),
      cmdCtx,
    );

    expect(retryOptions).toHaveLength(2);
    expect(retryOptions.reduce((sum: number, opts: any) => sum + worstCaseMs(opts), 0)).toBeLessThan(3000);
  });

  it("retries a 500 on the read once and then gives up, rather than four times", async () => {
    const failing = { ok: false, status: 500, headers: new Headers(), json: async () => ({}), text: async () => "" };
    mockPaperclipFetch.mockResolvedValue(failing);

    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      buttonInteraction(`delivery_accept_${ISSUE_ID}`),
      cmdCtx,
    )) as any;

    // One attempt plus one retry: two calls, not the default four.
    expect(mockPaperclipFetch).toHaveBeenCalledTimes(2);
    expect(result.type).toBe(7);
    expect(result.data.components).toBeUndefined();
  }, 10000);
});

// ---------------------------------------------------------------------------
// The unknown-modal fallback.
// ---------------------------------------------------------------------------

describe("an unrecognised modal", () => {
  it("refuses it ephemerally, logs it, and calls no API", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      modalInteraction("some_retired_form_v1", "anything"),
      cmdCtx,
    )) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
    expect(result.data.content).toContain("no longer handled");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Unknown modal submitted",
      expect.objectContaining({ customId: "some_retired_form_v1" }),
    );
  });

  it("refuses a modal submit carrying no custom_id at all", async () => {
    const ctx = makeCtx();
    const result = (await handleInteraction(
      ctx,
      { type: 5, data: { components: [] }, member: { user: { username: "hanna" } } } as any,
      cmdCtx,
    )) as any;

    expect(mockPaperclipFetch).not.toHaveBeenCalled();
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
  });
});
