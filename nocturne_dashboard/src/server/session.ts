import { createHmac, timingSafeEqual } from "node:crypto";

import type { DataScope, User, UserRole } from "@/types";

if (typeof window !== "undefined") {
  throw new Error("Nocturne session signing may only run on the server.");
}

export const SESSION_COOKIE_NAME = "nocturne.session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionClaims {
  version: 1;
  username: string;
  role: UserRole;
  orgId: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifiedServerSession {
  username: string;
  role: UserRole;
  orgId: string | null;
  scope: DataScope;
  issuedAt: string;
  expiresAt: string;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

function sessionSecret(): string {
  const secret = process.env.NOCTURNE_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32 || secret.startsWith("replace-with-")) {
    throw new Error(
      "NOCTURNE_SESSION_SECRET must contain at least 32 non-placeholder characters.",
    );
  }
  return secret;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(encodedClaims: string): string {
  return createHmac("sha256", sessionSecret())
    .update(encodedClaims, "utf8")
    .digest("base64url");
}

function isRole(value: unknown): value is UserRole {
  return value === "ORG_USER" || value === "SUPER_ADMIN";
}

function validClaims(value: unknown): value is SessionClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  if (
    claims.version !== 1
    || typeof claims.username !== "string"
    || !claims.username
    || !isRole(claims.role)
    || typeof claims.issuedAt !== "number"
    || !Number.isInteger(claims.issuedAt)
    || typeof claims.expiresAt !== "number"
    || !Number.isInteger(claims.expiresAt)
  ) {
    return false;
  }

  if (claims.role === "ORG_USER") {
    return typeof claims.orgId === "string" && claims.orgId.length > 0;
  }
  return claims.orgId === null;
}

function scopeForClaims(claims: SessionClaims): DataScope {
  return claims.role === "SUPER_ADMIN"
    ? { kind: "fleet" }
    : { kind: "org", orgId: claims.orgId! };
}

export function createSessionToken(user: User, now = new Date()): string {
  if (user.role === "ORG_USER" && !user.orgId) {
    throw new Error("An organization user cannot be signed without an orgId.");
  }
  if (user.role === "SUPER_ADMIN" && user.orgId !== null) {
    throw new Error("A super-admin session cannot be bound to an orgId.");
  }

  const issuedAt = Math.floor(now.getTime() / 1_000);
  const claims: SessionClaims = {
    version: 1,
    username: user.username,
    role: user.role,
    orgId: user.orgId,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
  };
  const encodedClaims = encode(JSON.stringify(claims));
  return `${encodedClaims}.${signature(encodedClaims)}`;
}

export function verifySessionToken(
  token: string | undefined,
  now = new Date(),
): VerifiedServerSession | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [encodedClaims, suppliedSignature] = parts;
  const expectedSignature = signature(encodedClaims);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(encodedClaims));
  } catch {
    return null;
  }
  if (!validClaims(parsed)) return null;

  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (parsed.expiresAt <= nowSeconds || parsed.issuedAt > nowSeconds + 60) {
    return null;
  }

  return {
    username: parsed.username,
    role: parsed.role,
    orgId: parsed.orgId,
    scope: scopeForClaims(parsed),
    issuedAt: new Date(parsed.issuedAt * 1_000).toISOString(),
    expiresAt: new Date(parsed.expiresAt * 1_000).toISOString(),
  };
}
