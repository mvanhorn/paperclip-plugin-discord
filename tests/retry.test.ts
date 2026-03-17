import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status", async () => {
    const error = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 status", async () => {
    const error = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 502 status", async () => {
    const error = Object.assign(new Error("bad gateway"), { status: 502 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 status", async () => {
    const error = Object.assign(new Error("unavailable"), { status: 503 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 401", async () => {
    const error = Object.assign(new Error("unauthorized"), { status: 401 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow("unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404", async () => {
    const error = Object.assign(new Error("not found"), { status: 404 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const error = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow("server error");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry on generic errors without status", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow("network error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects Retry-After header on 429", async () => {
    const headers = { get: (name: string) => name === "Retry-After" ? "0.01" : null };
    const error = Object.assign(new Error("rate limited"), { status: 429, headers });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const start = Date.now();
    await withRetry(fn, { baseDelayMs: 5000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
