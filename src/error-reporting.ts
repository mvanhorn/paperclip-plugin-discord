import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface PluginErrorReport {
  source: string;
  summary: string;
  detail?: string;
  companyId?: string;
  dedupKey?: string;
}

/** Delivers a report, resolving to whether it actually reached the error channel. */
export type PluginErrorSink = (ctx: PluginContext, report: PluginErrorReport) => Promise<boolean>;

const ERROR_REPORT_DEDUP_TTL_MS = 60 * 60 * 1000;

interface SentReportMark {
  at: number;
  token: number;
}

let sink: PluginErrorSink | null = null;
let nextMarkToken = 0;
const sentReports = new Map<string, SentReportMark>();

/** Drop a mark only while it still belongs to the send that wrote it. */
function releaseMark(dedupKey: string, token: number): void {
  if (sentReports.get(dedupKey)?.token === token) sentReports.delete(dedupKey);
}

/** Install the transport that delivers degradation reports, replacing any previous one. */
export function setPluginErrorSink(next: PluginErrorSink | null): void {
  sink = next;
  sentReports.clear();
}

/** Drop the dedup window so a repeated report is delivered again. */
export function resetPluginErrorReports(): void {
  sentReports.clear();
}

/** Report a swallowed plugin failure to the error channel at most once per TTL. Never throws. */
export async function reportPluginError(
  ctx: PluginContext,
  report: PluginErrorReport,
): Promise<void> {
  const now = Date.now();
  for (const [key, mark] of sentReports) {
    if (now - mark.at > ERROR_REPORT_DEDUP_TTL_MS) sentReports.delete(key);
  }

  const target = sink;
  if (!target) return;

  const dedupKey = report.dedupKey ?? `${report.source}:${report.summary}`;
  if (sentReports.has(dedupKey)) return;
  const token = nextMarkToken++;
  sentReports.set(dedupKey, { at: now, token });

  try {
    // An undelivered report must not consume the dedup window.
    if (!(await target(ctx, report))) releaseMark(dedupKey, token);
  } catch (err) {
    releaseMark(dedupKey, token);
    ctx.logger.warn("Reporting a degraded Discord plugin path failed", {
      source: report.source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
