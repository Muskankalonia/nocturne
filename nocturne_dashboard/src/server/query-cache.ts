import type { DataScope } from "@/types";

/**
 * Short-lived cache for the read-only dashboard queries.
 *
 * Every page view previously ran its Snowflake query from scratch — about a
 * second each, which is what the loading skeletons were covering. The
 * underlying data does not move nearly that fast: the deterministic tables
 * target roughly five-minute freshness and the browser only refreshes every
 * five minutes anyway, so serving a result a minute old costs nothing and makes
 * the console feel instant.
 *
 * Two properties matter more than the speed:
 *
 * 1. Entries are keyed by data scope. A cached fleet-wide result must never be
 *    handed to a tenant, so the scope is part of the key rather than something
 *    the caller remembers to include.
 * 2. Concurrent misses share one query. Without that, a cold start with several
 *    panels loading at once fires the same expensive query several times over.
 *
 * State is per-instance and vanishes on deploy, which is fine: a miss is just
 * the old behaviour.
 */

if (typeof window !== "undefined") {
  throw new Error("Nocturne query caching may only run on the server.");
}

const DEFAULT_TTL_MS = 60_000;

/** 6 hours — for data that only changes on pipeline runs. */
export const PIPELINE_CYCLE_TTL_MS = 6 * 60 * 60_000;

/** 5 minutes — for data that changes on user triage actions. */
export const TRIAGE_TTL_MS = 5 * 60_000;

function ttlMs(): number {
  // Test the raw string before converting: Number("") is 0, not NaN, so an
  // unset variable would otherwise read as a zero TTL and disable the cache.
  const raw = process.env.NOCTURNE_QUERY_CACHE_MS?.trim();
  if (!raw) return DEFAULT_TTL_MS;

  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_TTL_MS;
  return configured;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const entries = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

/** Stable, collision-free key fragment for a scope. */
export function scopeKey(scope: DataScope): string {
  return scope.kind === "fleet" ? "fleet" : `org:${scope.orgId}`;
}

export async function cachedQuery<T>(
  key: string,
  load: () => Promise<T>,
  overrideTtlMs?: number,
): Promise<T> {
  const ttl = overrideTtlMs ?? ttlMs();
  if (ttl === 0) return load();

  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  // Join an identical query already running rather than starting a second one.
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const request = load()
    .then((value) => {
      entries.set(key, { value, expiresAt: Date.now() + ttl });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
      // Failures are deliberately not cached: a transient Snowflake error
      // should not pin an error state for the whole TTL.
      if (entries.size > 200) {
        const cutoff = Date.now();
        for (const [k, entry] of entries) {
          if (entry.expiresAt <= cutoff) entries.delete(k);
        }
      }
    });

  inFlight.set(key, request);
  return request;
}

/** Drop cached entries after a write so the next read reflects it. */
export function invalidateQueryCache(prefix: string): void {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/**
 * Clears the reads that show incident state, after a triage action changes it.
 *
 * When an orgId is provided, only that org's cached entries (plus fleet-level
 * entries that aggregate across orgs) are cleared. Without an orgId, all
 * breach-monitor and command-center entries are cleared (legacy behaviour).
 */
export function invalidateIncidentViews(orgId?: string): void {
  if (orgId) {
    // Clear the specific org's cache entries
    invalidateQueryCache(`breach-monitor:org:${orgId}`);
    invalidateQueryCache(`command-center:org:${orgId}`);
    // Fleet entries include this org's data in their aggregates
    invalidateQueryCache("breach-monitor:fleet");
    invalidateQueryCache("command-center:fleet");
  } else {
    invalidateQueryCache("breach-monitor:");
    invalidateQueryCache("command-center:");
  }
}
