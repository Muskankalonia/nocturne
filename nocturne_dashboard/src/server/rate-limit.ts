/**
 * Per-address throttle for the sign-in endpoint.
 *
 * The console is reachable without an IP allowlist, and the demo scheme derives
 * every password from a single shared suffix. Without a throttle, that suffix
 * is guessable at whatever rate the network allows — and a caller who gets in
 * can run Snowflake warehouse queries, which is where the real money is. This
 * puts a ceiling on that.
 *
 * Scope, stated plainly: the counter lives in the instance's memory. Cloud Run
 * may run up to `max-instances` containers, so a determined attacker gets up to
 * that multiple of the limit, and a deploy resets every counter. Making it
 * exact would mean a shared store (Redis, Firestore) — worth it for production,
 * not for a demo whose threat model is casual guessing.
 */

if (typeof window !== "undefined") {
  throw new Error("Nocturne rate limiting may only run on the server.");
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

interface Attempt {
  failures: number;
  /** Epoch ms after which this record is forgotten. */
  expiresAt: number;
}

const attempts = new Map<string, Attempt>();

/**
 * Identify the caller from X-Forwarded-For, dropping the trailing hops added by
 * any proxy in front of Cloud Run. Mirrors the accounting in src/middleware.ts:
 * Cloud Run appends the true peer, so the entry before the proxy tail is the
 * one a caller cannot forge away.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  const proxyHops = Number(process.env.NOCTURNE_PROXY_HOPS ?? "0");
  const trimmed =
    Number.isInteger(proxyHops) && proxyHops > 0
      ? hops.slice(0, Math.max(hops.length - proxyHops, 0))
      : hops;

  // Fall back to a single bucket rather than to no limit: an unattributable
  // request should still be counted, not waved through.
  return trimmed[trimmed.length - 1] ?? "unknown";
}

function sweep(now: number): void {
  // The map only grows on failed sign-ins, so an occasional linear sweep is
  // cheaper than tracking expiry separately.
  for (const [key, attempt] of attempts) {
    if (attempt.expiresAt <= now) attempts.delete(key);
  }
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the caller may try again. Zero when allowed. */
  retryAfter: number;
  /** Attempts left before the block engages. */
  remaining: number;
}

export function checkLoginRate(key: string): RateLimitVerdict {
  const now = Date.now();
  const attempt = attempts.get(key);

  if (!attempt || attempt.expiresAt <= now) {
    return { allowed: true, retryAfter: 0, remaining: MAX_FAILURES };
  }
  if (attempt.failures < MAX_FAILURES) {
    return {
      allowed: true,
      retryAfter: 0,
      remaining: MAX_FAILURES - attempt.failures,
    };
  }
  return {
    allowed: false,
    retryAfter: Math.max(Math.ceil((attempt.expiresAt - now) / 1000), 1),
    remaining: 0,
  };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  sweep(now);

  const attempt = attempts.get(key);
  if (!attempt || attempt.expiresAt <= now) {
    attempts.set(key, { failures: 1, expiresAt: now + WINDOW_MS });
    return;
  }

  attempt.failures += 1;
  // Each failure re-arms the window, so sustained guessing stays locked out
  // rather than regaining an attempt every time the original window lapses.
  attempt.expiresAt = now + WINDOW_MS;
}

/** A correct password clears the record: legitimate users are never throttled. */
export function recordLoginSuccess(key: string): void {
  attempts.delete(key);
}

export const loginRateLimits = { MAX_FAILURES, WINDOW_MS };
