import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The throttle keeps its counters in module state, so each test gets a fresh
 * module rather than trying to reset a private map.
 */
async function loadRateLimit() {
  vi.resetModules();
  return import("@/server/rate-limit");
}

const originalProxyHops = process.env.NOCTURNE_PROXY_HOPS;

beforeEach(() => {
  delete process.env.NOCTURNE_PROXY_HOPS;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalProxyHops === undefined) delete process.env.NOCTURNE_PROXY_HOPS;
  else process.env.NOCTURNE_PROXY_HOPS = originalProxyHops;
});

describe("clientKey", () => {
  const headers = (value?: string) =>
    new Headers(value === undefined ? {} : { "x-forwarded-for": value });

  it("takes the last hop when nothing is proxying", async () => {
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("drops the proxy tail that Firebase Hosting appends", async () => {
    // Cloud Run appends the true peer, so with one proxy in front the entry
    // before the tail is the one a caller cannot forge away.
    process.env.NOCTURNE_PROXY_HOPS = "1";
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers("198.51.100.9, 203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
  });

  it("does not fall off the front of the list when there are more hops than entries", async () => {
    process.env.NOCTURNE_PROXY_HOPS = "5";
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers("203.0.113.7"))).toBe("unknown");
  });

  it("ignores a non-integer or negative hop count", async () => {
    process.env.NOCTURNE_PROXY_HOPS = "not-a-number";
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers("198.51.100.9, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("buckets an unattributable request rather than waving it through", async () => {
    // Falling back to "no limit" would make the throttle optional for anyone
    // who can strip the header.
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers())).toBe("unknown");
    expect(clientKey(headers("   ,  "))).toBe("unknown");
  });

  it("trims whitespace around each hop", async () => {
    const { clientKey } = await loadRateLimit();
    expect(clientKey(headers("  198.51.100.9 ,  203.0.113.7  "))).toBe("203.0.113.7");
  });
});

describe("checkLoginRate", () => {
  it("allows a caller it has never seen, with the full budget", async () => {
    const { checkLoginRate, loginRateLimits } = await loadRateLimit();
    expect(checkLoginRate("fresh")).toEqual({
      allowed: true,
      retryAfter: 0,
      remaining: loginRateLimits.MAX_FAILURES,
    });
  });

  it("counts down as failures accumulate", async () => {
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    recordLoginFailure("k");
    expect(checkLoginRate("k").remaining).toBe(loginRateLimits.MAX_FAILURES - 1);
    recordLoginFailure("k");
    expect(checkLoginRate("k").remaining).toBe(loginRateLimits.MAX_FAILURES - 2);
  });

  it("blocks once the budget is spent and reports a retry-after", async () => {
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("k");
    const verdict = checkLoginRate("k");
    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining).toBe(0);
    expect(verdict.retryAfter).toBeGreaterThan(0);
  });

  it("throttles each caller independently", async () => {
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("blocked");
    expect(checkLoginRate("blocked").allowed).toBe(false);
    expect(checkLoginRate("other").allowed).toBe(true);
  });

  it("forgets a caller once the window lapses", async () => {
    vi.useFakeTimers();
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("k");
    expect(checkLoginRate("k").allowed).toBe(false);
    vi.advanceTimersByTime(loginRateLimits.WINDOW_MS + 1);
    expect(checkLoginRate("k")).toEqual({
      allowed: true,
      retryAfter: 0,
      remaining: loginRateLimits.MAX_FAILURES,
    });
  });

  it("re-arms the window on every failure, so sustained guessing stays locked out", async () => {
    // Otherwise an attacker regains an attempt every time the original window
    // lapses and can guess forever at a slightly slower rate.
    vi.useFakeTimers();
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("k");
    vi.advanceTimersByTime(loginRateLimits.WINDOW_MS - 1_000);
    recordLoginFailure("k");
    vi.advanceTimersByTime(2_000);
    expect(checkLoginRate("k").allowed).toBe(false);
  });

  it("never reports a retry-after below one second", async () => {
    vi.useFakeTimers();
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("k");
    vi.advanceTimersByTime(loginRateLimits.WINDOW_MS - 100);
    expect(checkLoginRate("k").retryAfter).toBe(1);
  });
});

describe("recordLoginSuccess", () => {
  it("clears the record so a legitimate user is never throttled", async () => {
    const { checkLoginRate, recordLoginFailure, recordLoginSuccess, loginRateLimits } =
      await loadRateLimit();
    for (let i = 0; i < loginRateLimits.MAX_FAILURES; i += 1) recordLoginFailure("k");
    expect(checkLoginRate("k").allowed).toBe(false);
    recordLoginSuccess("k");
    expect(checkLoginRate("k").remaining).toBe(loginRateLimits.MAX_FAILURES);
  });
});

describe("expiry sweeping", () => {
  it("drops lapsed records instead of growing without bound", async () => {
    vi.useFakeTimers();
    const { checkLoginRate, recordLoginFailure, loginRateLimits } = await loadRateLimit();
    recordLoginFailure("old");
    vi.advanceTimersByTime(loginRateLimits.WINDOW_MS + 1);
    // The sweep runs on the next failure for any key.
    recordLoginFailure("new");
    expect(checkLoginRate("old").remaining).toBe(loginRateLimits.MAX_FAILURES);
    expect(checkLoginRate("new").remaining).toBe(loginRateLimits.MAX_FAILURES - 1);
  });
});
