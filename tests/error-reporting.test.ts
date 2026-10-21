import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  setPluginErrorSink,
  resetPluginErrorReports,
  reportPluginError,
  flushPluginErrorReports,
  type PluginErrorReport,
} from "../src/error-reporting.js";
import { readLegacyDefaultScopeState } from "../src/legacy-state.js";
import { formatPluginError } from "../src/formatters.js";
import { COLORS } from "../src/constants.js";

function makeCtx(stateGet: () => Promise<unknown>) {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: vi.fn().mockImplementation(stateGet), set: vi.fn() },
  } as unknown as PluginContext;
}

/** Verbatim shape of the SDK's `InvocationScopeDeniedError`, as it reaches the worker. */
function scopeDenied(): Error {
  const err = new Error(
    'Plugin "paperclip-plugin-discord" is not allowed to perform "state.get": ' +
      'requested company "default" but the current invocation is scoped to company ' +
      '"44806279-f8ba-4f28-a9c3-54ceeea43416"',
  );
  (err as Error & { code: number }).code = -32005;
  return err;
}

const refusing = () => Promise.reject(scopeDenied());

describe("readLegacyDefaultScopeState", () => {
  beforeEach(() => {
    setPluginErrorSink(null);
    resetPluginErrorReports();
  });

  it("returns null and reports once when the host refuses the read", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await expect(readLegacyDefaultScopeState(ctx, "escalation_pending_ids")).resolves.toBeNull();
    await flushPluginErrorReports();

    expect(sink).toHaveBeenCalledTimes(1);
    const report = sink.mock.calls[0][1] as PluginErrorReport;
    expect(report.source).toBe("legacy-state");
    expect(report.summary).toContain("escalation_pending_ids");
    expect(report.detail).toContain("is not allowed to perform");
  });

  it("reports the same stateKey only once", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await readLegacyDefaultScopeState(ctx, "escalation_pending_ids");
    await readLegacyDefaultScopeState(ctx, "escalation_pending_ids");
    await readLegacyDefaultScopeState(ctx, "escalation_pending_ids");
    await flushPluginErrorReports();

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("reports each distinct stateKey once", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await readLegacyDefaultScopeState(ctx, "sessions_thread-1");
    await readLegacyDefaultScopeState(ctx, "handoff_h-1");
    await readLegacyDefaultScopeState(ctx, "sessions_thread-1");
    await flushPluginErrorReports();

    expect(sink).toHaveBeenCalledTimes(2);
    const keys = sink.mock.calls.map((c) => (c[1] as PluginErrorReport).dedupKey);
    expect(keys).toEqual(["legacy-state:sessions_thread-1", "legacy-state:handoff_h-1"]);
  });

  it("does not propagate a failing sink", async () => {
    const sink = vi.fn().mockRejectedValue(new Error("discord is down"));
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await expect(readLegacyDefaultScopeState(ctx, "handoff_h-1")).resolves.toBeNull();
    await flushPluginErrorReports();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("retries the report after the sink reports a failed delivery", async () => {
    const sink = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    for (let i = 0; i < 3; i++) {
      await readLegacyDefaultScopeState(ctx, "handoff_h-1");
      await flushPluginErrorReports();
    }

    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("retries the report after the sink throws", async () => {
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error("discord is down"))
      .mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    for (let i = 0; i < 3; i++) {
      await readLegacyDefaultScopeState(ctx, "handoff_h-1");
      await flushPluginErrorReports();
    }

    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("swallows the refusal when no sink is registered", async () => {
    const ctx = makeCtx(refusing);
    await expect(readLegacyDefaultScopeState(ctx, "discussion_d-1")).resolves.toBeNull();
  });

  it("returns before a slow report is delivered", async () => {
    let releaseSend: (delivered: boolean) => void = () => {};
    const sink = vi
      .fn()
      .mockImplementation(() => new Promise<boolean>((resolve) => (releaseSend = resolve)));
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await expect(readLegacyDefaultScopeState(ctx, "escalation_pending_ids")).resolves.toBeNull();
    expect(sink).toHaveBeenCalledTimes(1);

    releaseSend(true);
    await flushPluginErrorReports();
  });

  it("passes a successful read through untouched", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(() => Promise.resolve({ sessions: [] }));

    await expect(readLegacyDefaultScopeState(ctx, "sessions_thread-1")).resolves.toEqual({
      sessions: [],
    });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("reportPluginError", () => {
  beforeEach(() => {
    setPluginErrorSink(null);
    resetPluginErrorReports();
  });

  it("dedups on source and summary when no dedupKey is given", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await reportPluginError(ctx, { source: "worker", summary: "gateway lost" });
    await reportPluginError(ctx, { source: "worker", summary: "gateway lost" });
    await reportPluginError(ctx, { source: "worker", summary: "token expired" });

    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("sends only one report for concurrent calls", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);

    await Promise.all([
      readLegacyDefaultScopeState(ctx, "sessions_thread-1"),
      readLegacyDefaultScopeState(ctx, "sessions_thread-1"),
      readLegacyDefaultScopeState(ctx, "sessions_thread-1"),
    ]);
    await flushPluginErrorReports();

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing send clear a mark written after an ownership reset", async () => {
    let releaseFirstSend: (delivered: boolean) => void = () => {};
    const sink = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (releaseFirstSend = resolve)))
      .mockResolvedValue(true);
    setPluginErrorSink(sink);
    const ctx = makeCtx(refusing);
    const report = { source: "worker", summary: "gateway lost" };

    const outgoing = reportPluginError(ctx, report);
    resetPluginErrorReports();
    await reportPluginError(ctx, report);
    releaseFirstSend(false);
    await outgoing;

    await reportPluginError(ctx, report);

    expect(sink).toHaveBeenCalledTimes(2);
  });
});

describe("formatPluginError", () => {
  it("builds an orange embed carrying the source in the footer", () => {
    const message = formatPluginError({
      source: "legacy-state",
      summary: "Legacy read refused",
      detail: "not authorized",
    });

    expect(message.embeds).toHaveLength(1);
    const embed = message.embeds![0];
    expect(embed.title).toBe("⚠️ Discord plugin degraded");
    expect(embed.description).toBe("Legacy read refused");
    expect(embed.color).toBe(COLORS.ORANGE);
    expect(embed.footer?.text).toBe("Paperclip • legacy-state");
    expect(embed.fields).toEqual([{ name: "Detail", value: "not authorized" }]);
  });

  it("omits the detail field when there is no detail", () => {
    const message = formatPluginError({ source: "worker", summary: "degraded" });
    expect(message.embeds![0].fields).toBeUndefined();
  });

  it("truncates an oversized detail to the Discord field limit", () => {
    const message = formatPluginError({
      source: "worker",
      summary: "degraded",
      detail: "x".repeat(2000),
    });
    expect(message.embeds![0].fields![0].value).toHaveLength(1024);
  });
});
