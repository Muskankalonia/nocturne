import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/types";

const SECRET = "a".repeat(48);

/**
 * The module reads NOCTURNE_SESSION_SECRET on every sign and verify, so tests
 * set it before importing rather than mocking the crypto.
 */
async function loadSession() {
  vi.resetModules();
  return import("@/server/session");
}

function user(overrides: Partial<User> = {}): User {
  return {
    username: "acme_corp",
    displayName: "Acme Analyst",
    initials: "AA",
    role: "ORG_USER",
    orgId: "acme_corp",
    lastSignInAt: null,
    email: null,
    position: null,
    ...overrides,
  };
}

const admin = user({ username: "admin", role: "SUPER_ADMIN", orgId: null });

beforeEach(() => {
  process.env.NOCTURNE_SESSION_SECRET = SECRET;
});

describe("the session secret", () => {
  it("refuses to sign without one", async () => {
    process.env.NOCTURNE_SESSION_SECRET = "";
    const { createSessionToken } = await loadSession();
    expect(() => createSessionToken(user())).toThrow(/at least 32/);
  });

  it("refuses a secret that is too short", async () => {
    process.env.NOCTURNE_SESSION_SECRET = "short";
    const { createSessionToken } = await loadSession();
    expect(() => createSessionToken(user())).toThrow(/at least 32/);
  });

  it("refuses the placeholder shipped in the example env file", async () => {
    // A long-enough placeholder would otherwise sign real sessions with a
    // value that is public in the repo.
    process.env.NOCTURNE_SESSION_SECRET = `replace-with-${"x".repeat(40)}`;
    const { createSessionToken } = await loadSession();
    expect(() => createSessionToken(user())).toThrow(/non-placeholder/);
  });
});

describe("createSessionToken", () => {
  it("refuses to sign a tenant user with no organization", async () => {
    const { createSessionToken } = await loadSession();
    expect(() => createSessionToken(user({ orgId: null }))).toThrow(/without an orgId/);
  });

  it("refuses to bind a super-admin to one organization", async () => {
    // A fleet-scoped session carrying an orgId would be ambiguous about what
    // it may read.
    const { createSessionToken } = await loadSession();
    expect(() => createSessionToken(user({ username: "admin", role: "SUPER_ADMIN", orgId: "acme_corp" })))
      .toThrow(/cannot be bound to an orgId/);
  });

  it("emits a two-part claims.signature token", async () => {
    const { createSessionToken } = await loadSession();
    expect(createSessionToken(user()).split(".")).toHaveLength(2);
  });
});

describe("verifySessionToken", () => {
  it("round-trips a tenant session into an org scope", async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const verified = verifySessionToken(createSessionToken(user()));
    expect(verified).toMatchObject({
      username: "acme_corp",
      role: "ORG_USER",
      orgId: "acme_corp",
      scope: { kind: "org", orgId: "acme_corp" },
    });
  });

  it("round-trips a super-admin into fleet scope", async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    expect(verifySessionToken(createSessionToken(admin))?.scope).toEqual({ kind: "fleet" });
  });

  it("rejects a missing or malformed token", async () => {
    const { verifySessionToken } = await loadSession();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("onlyonepart")).toBeNull();
    expect(verifySessionToken("three.parts.here")).toBeNull();
    expect(verifySessionToken(".")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    // The whole point of the HMAC: editing the claims must invalidate them.
    const { createSessionToken, verifySessionToken } = await loadSession();
    const [claims, signature] = createSessionToken(user()).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(claims, "base64url").toString()), role: "SUPER_ADMIN", orgId: null }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { createSessionToken } = await loadSession();
    const token = createSessionToken(user());
    process.env.NOCTURNE_SESSION_SECRET = "b".repeat(48);
    const { verifySessionToken } = await loadSession();
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects a signature of the wrong length without throwing", async () => {
    // timingSafeEqual throws on a length mismatch, so the length is compared
    // first. A caller must get null, not a 500.
    const { createSessionToken, verifySessionToken } = await loadSession();
    const [claims] = createSessionToken(user()).split(".");
    expect(verifySessionToken(`${claims}.tooshort`)).toBeNull();
  });

  it("rejects claims that are not JSON", async () => {
    const { verifySessionToken } = await loadSession();
    const claims = Buffer.from("not json at all").toString("base64url");
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", SECRET).update(claims, "utf8").digest("base64url");
    expect(verifySessionToken(`${claims}.${signature}`)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { createSessionToken, verifySessionToken, SESSION_TTL_SECONDS } = await loadSession();
    const issued = new Date("2026-08-18T00:00:00Z");
    const token = createSessionToken(user(), issued);
    const afterExpiry = new Date(issued.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    expect(verifySessionToken(token, afterExpiry)).toBeNull();
    expect(verifySessionToken(token, issued)).not.toBeNull();
  });

  it("rejects a token issued in the future beyond the clock-skew allowance", async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const now = new Date("2026-08-18T00:00:00Z");
    const fromTheFuture = createSessionToken(user(), new Date(now.getTime() + 5 * 60_000));
    expect(verifySessionToken(fromTheFuture, now)).toBeNull();
  });

  it("tolerates a small forward clock skew", async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const now = new Date("2026-08-18T00:00:00Z");
    const slightlyAhead = createSessionToken(user(), new Date(now.getTime() + 30_000));
    expect(verifySessionToken(slightlyAhead, now)).not.toBeNull();
  });
});

describe("claim validation", () => {
  async function signed(claims: unknown): Promise<string> {
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const { createHmac } = await import("node:crypto");
    return `${encoded}.${createHmac("sha256", SECRET).update(encoded, "utf8").digest("base64url")}`;
  }

  const base = {
    version: 1,
    username: "acme_corp",
    role: "ORG_USER",
    orgId: "acme_corp",
    issuedAt: Math.floor(Date.parse("2026-08-18T00:00:00Z") / 1000),
    expiresAt: Math.floor(Date.parse("2026-08-18T08:00:00Z") / 1000),
  };
  const at = new Date("2026-08-18T01:00:00Z");

  it("accepts the baseline it is built from", async () => {
    const { verifySessionToken } = await loadSession();
    expect(verifySessionToken(await signed(base), at)).not.toBeNull();
  });

  it.each([
    ["a future claims version", { version: 2 }],
    ["a non-object payload", null],
    ["an empty username", { username: "" }],
    ["an unknown role", { role: "ROOT" }],
    ["a non-integer issuedAt", { issuedAt: 1.5 }],
    ["a non-integer expiresAt", { expiresAt: "soon" }],
    ["a tenant session with no orgId", { orgId: null }],
    ["a tenant session with an empty orgId", { orgId: "" }],
    ["a super-admin carrying an orgId", { role: "SUPER_ADMIN" }],
  ])("rejects %s", async (_label, patch) => {
    const { verifySessionToken } = await loadSession();
    const claims = patch === null ? "a string, not an object" : { ...base, ...patch };
    expect(verifySessionToken(await signed(claims), at)).toBeNull();
  });
});

describe("cookie options", () => {
  it("is named __session because Firebase Hosting strips every other cookie", async () => {
    const { SESSION_COOKIE_NAME } = await loadSession();
    expect(SESSION_COOKIE_NAME).toBe("__session");
  });

  it("is httpOnly and lax by default", async () => {
    const { sessionCookieOptions, SESSION_TTL_SECONDS } = await loadSession();
    expect(sessionCookieOptions.httpOnly).toBe(true);
    expect(sessionCookieOptions.sameSite).toBe("lax");
    expect(sessionCookieOptions.path).toBe("/");
    expect(sessionCookieOptions.maxAge).toBe(SESSION_TTL_SECONDS);
  });
});
