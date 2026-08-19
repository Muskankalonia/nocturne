import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadCache() {
  vi.resetModules();
  return import("@/server/query-cache");
}

const original = process.env.NOCTURNE_QUERY_CACHE_MS;

beforeEach(() => {
  delete process.env.NOCTURNE_QUERY_CACHE_MS;
});

afterEach(() => {
  vi.useRealTimers();
  if (original === undefined) delete process.env.NOCTURNE_QUERY_CACHE_MS;
  else process.env.NOCTURNE_QUERY_CACHE_MS = original;
});

describe("scopeKey", () => {
  it("distinguishes fleet from a tenant", async () => {
    const { scopeKey } = await loadCache();
    expect(scopeKey({ kind: "fleet" })).toBe("fleet");
    expect(scopeKey({ kind: "org", orgId: "acme_corp" })).toBe("org:acme_corp");
  });

  it("never collides one tenant with another", async () => {
    // A cached fleet-wide result handed to a tenant would be a data leak, so
    // the scope is part of the key rather than something a caller remembers.
    const { scopeKey } = await loadCache();
    expect(scopeKey({ kind: "org", orgId: "acme" })).not.toBe(scopeKey({ kind: "org", orgId: "acme_corp" }));
  });
});

describe("cachedQuery", () => {
  it("serves a second read from cache", async () => {
    const { cachedQuery } = await loadCache();
    const load = vi.fn().mockResolvedValue("value");
    expect(await cachedQuery("k", load)).toBe("value");
    expect(await cachedQuery("k", load)).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys entries separately", async () => {
    const { cachedQuery } = await loadCache();
    expect(await cachedQuery("a", async () => 1)).toBe(1);
    expect(await cachedQuery("b", async () => 2)).toBe(2);
  });

  it("collapses concurrent misses into one query", async () => {
    // A cold start with several panels loading at once would otherwise fire
    // the same expensive Snowflake query several times over.
    const { cachedQuery } = await loadCache();
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const first = cachedQuery("k", load);
    const second = cachedQuery("k", load);
    resolve("shared");
    expect(await first).toBe("shared");
    expect(await second).toBe("shared");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("expires an entry after the TTL", async () => {
    vi.useFakeTimers();
    process.env.NOCTURNE_QUERY_CACHE_MS = "1000";
    const { cachedQuery } = await loadCache();
    const load = vi.fn().mockResolvedValue("v");
    await cachedQuery("k", load);
    vi.advanceTimersByTime(1_001);
    await cachedQuery("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    // A transient Snowflake error must not pin an error state for a whole TTL.
    const { cachedQuery } = await loadCache();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");
    await expect(cachedQuery("k", load)).rejects.toThrow("transient");
    expect(await cachedQuery("k", load)).toBe("recovered");
  });

  it("bypasses the cache entirely when the TTL is zero", async () => {
    process.env.NOCTURNE_QUERY_CACHE_MS = "0";
    const { cachedQuery } = await loadCache();
    const load = vi.fn().mockResolvedValue("v");
    await cachedQuery("k", load);
    await cachedQuery("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default TTL for an unset or nonsense value", async () => {
    // Number("") is 0, not NaN, so an unset variable would otherwise read as a
    // zero TTL and silently disable the cache.
    for (const raw of ["", "   ", "not-a-number", "-5"]) {
      process.env.NOCTURNE_QUERY_CACHE_MS = raw;
      const { cachedQuery } = await loadCache();
      const load = vi.fn().mockResolvedValue("v");
      await cachedQuery("k", load);
      await cachedQuery("k", load);
      expect(load, `TTL input ${JSON.stringify(raw)}`).toHaveBeenCalledTimes(1);
    }
  });
});

describe("eviction", () => {
  it("sweeps expired entries once the map grows past its bound", async () => {
    // State is per-instance and unbounded otherwise: a fleet admin paging
    // through organizations mints a new key each time.
    vi.useFakeTimers();
    process.env.NOCTURNE_QUERY_CACHE_MS = "1000";
    const { cachedQuery } = await loadCache();
    for (let i = 0; i < 201; i += 1) {
      await cachedQuery(`key-${i}`, async () => i);
    }
    // Everything above is now stale, and the next write trips the sweep.
    vi.advanceTimersByTime(1_001);
    await cachedQuery("trigger", async () => "v");

    const load = vi.fn().mockResolvedValue("reloaded");
    expect(await cachedQuery("key-0", load)).toBe("reloaded");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateQueryCache", () => {
  it("drops every entry under a prefix after a write", async () => {
    const { cachedQuery, invalidateQueryCache } = await loadCache();
    const load = vi.fn().mockResolvedValue("v");
    await cachedQuery("breach-monitor:org:acme", load);
    await cachedQuery("breach-monitor:fleet", load);
    await cachedQuery("pipeline:org:acme", load);
    invalidateQueryCache("breach-monitor:");
    await cachedQuery("breach-monitor:org:acme", load);
    await cachedQuery("pipeline:org:acme", load);
    // Three cold loads, then one reload of the invalidated key only.
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("is a no-op for a prefix that matches nothing", async () => {
    const { invalidateQueryCache } = await loadCache();
    expect(() => invalidateQueryCache("nothing:")).not.toThrow();
  });
});
