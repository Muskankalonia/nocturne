"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { organizations } from "@/mocks/organizations";
import { initialsFromName } from "@/lib/format";
import type { DataScope, Organization, Session, User } from "@/types";

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️  DEMO AUTHENTICATION — NOT FOR PRODUCTION
 *
 * Credentials are `username === password`, where username is either an org id
 * or the literal "admin". This is a hackathon convenience and must be replaced
 * before anyone real signs in.
 *
 * More importantly, and independent of the credential scheme: tenant isolation
 * is enforced by the signed HttpOnly server session. The client scope below is
 * presentation state; API routes verify the signed role and organization again.
 *
 * The contract that has to hold server-side:
 *   ORG_USER    → scope is forced to their own orgId, ignoring any client input
 *   SUPER_ADMIN → may pass an orgId to narrow, or omit it for fleet scope
 * ──────────────────────────────────────────────────────────────────────────── */

export interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  isLoading: boolean;

  /** The org currently being viewed. null only for a super admin at fleet scope. */
  activeOrg: Organization | null;
  /** Fleet scope means "all organizations at once". */
  isFleetScope: boolean;
  /** Organizations this session may switch between. Empty for an ORG_USER. */
  switchableOrgs: Organization[];

  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  /** Super admin only; a no-op for an ORG_USER. */
  setScope: (scope: DataScope) => void;
  /** Applies a saved profile to the in-memory session so chrome updates now. */
  applyProfile: (profile: {
    displayName: string;
    email: string | null;
    position: string | null;
  }) => void;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; error: string };

const AuthContext = createContext<AuthContextValue | null>(null);

interface SessionApiResponse {
  session?: Session;
  error?: string;
}

/**
 * Narrow a scope to its org id, or null at fleet scope. Use this instead of
 * casting — a cast would silently survive a future change to DataScope.
 */
export function scopeOrgId(scope: DataScope): string | null {
  return scope.kind === "org" ? scope.orgId : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore only from the server-verified HttpOnly cookie. No identity, role,
  // organization scope, or signing material is stored in localStorage.
  useEffect(() => {
    const controller = new AbortController();
    const restore = async () => {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body = (await response.json()) as SessionApiResponse;
        if (!controller.signal.aborted) {
          setSession(response.ok && body.session ? body.session : null);
        }
      } catch {
        if (!controller.signal.aborted) setSession(null);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    void restore();
    return () => controller.abort();
  }, []);

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResult> => {
      try {
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ username, password }),
        });
        const body = (await response.json()) as SessionApiResponse;
        if (!response.ok || !body.session) {
          return {
            ok: false,
            error: body.error ?? "Unable to create a session.",
          };
        }
        setSession(body.session);
        return { ok: true, user: body.session.user };
      } catch {
        return {
          ok: false,
          error: "The session service is unavailable. Please try again.",
        };
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/session", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
    } finally {
      setSession(null);
    }
  }, []);

  const setScope = useCallback(
    (scope: DataScope) => {
      setSession((current) => {
        if (!current || current.user.role !== "SUPER_ADMIN") return current;
        return { ...current, scope };
      });
    },
    [],
  );

  const applyProfile = useCallback(
    (profile: { displayName: string; email: string | null; position: string | null }) => {
      setSession((current) =>
        current
          ? {
              ...current,
              user: {
                ...current.user,
                displayName: profile.displayName,
                // Initials follow the name, or the avatar keeps showing the old
                // person's letters after a rename.
                initials: initialsFromName(profile.displayName, current.user.initials),
                email: profile.email,
                position: profile.position,
              },
            }
          : current,
      );
    },
    [],
  );

  const value = useMemo<AuthContextValue>(() => {
    const isSuperAdmin = session?.user.role === "SUPER_ADMIN";
    const isFleetScope = session?.scope.kind === "fleet";

    // Bind orgId to a local before the callback — TS drops the discriminated
    // union narrowing on `session.scope` once it crosses a function boundary.
    let activeOrg: Organization | null = null;
    if (session && session.scope.kind === "org") {
      const { orgId } = session.scope;
      activeOrg = organizations.find((o) => o.orgId === orgId) ?? null;
    }

    return {
      session,
      isAuthenticated: Boolean(session),
      isSuperAdmin: Boolean(isSuperAdmin),
      isLoading,
      activeOrg,
      isFleetScope: Boolean(isFleetScope),
      switchableOrgs: isSuperAdmin ? organizations : [],
      login,
      logout,
      setScope,
      applyProfile,
    };
  }, [session, isLoading, login, logout, setScope, applyProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

