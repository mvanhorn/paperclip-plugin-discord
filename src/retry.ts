export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

interface RetryableError {
  status?: number;
  headers?: { get(name: string): string | null };
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

function isRetryable(error: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (error && typeof error === "object" && "status" in error) {
    const e = error as RetryableError;
    if (e.status && RETRYABLE_STATUS_CODES.has(e.status)) {
      let retryAfterMs: number | undefined;
      if (e.status === 429 && e.headers) {
        const retryAfter = e.headers.get("Retry-After");
        if (retryAfter) {
          const seconds = parseFloat(retryAfter);
          if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
        }
      }
      return { retryable: true, retryAfterMs };
    }
  }
  return { retryable: false };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) break;

      const { retryable, retryAfterMs } = isRetryable(error);
      if (!retryable) throw error;

      const delay = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
