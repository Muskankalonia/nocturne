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
import { organizations, users } from "@/mocks/organizations";
import type { DataScope, Organization, Session, User } from "@/types";

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️  DEMO AUTHENTICATION — NOT FOR PRODUCTION
 *
 * Credentials are `username === password`, where username is either an org id
 * or the literal "admin". This is a hackathon convenience and must be replaced
 * before anyone real signs in.
 *
 * More importantly, and independent of the credential scheme: **tenant
 * isolation is not a client concern.** The hidden Fleet menu and the locked org
 * badge below are conveniences, not controls. The server must pin the org scope
 * onto the session and filter every query by it. If an API route ever accepts an
 * orgId from the request body or a query string, any tenant can read any other
 * tenant's breaches by editing one value.
 *
 * The contract that has to hold server-side:
 *   ORG_USER    → scope is forced to their own orgId, ignoring any client input
 *   SUPER_ADMIN → may pass an orgId to narrow, or omit it for fleet scope
 * ──────────────────────────────────────────────────────────────────────────── */

const SESSION_STORAGE_KEY = "nocturne.session";

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
  logout: () => void;
  /** Super admin only; a no-op for an ORG_USER. */
  setScope: (scope: DataScope) => void;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; error: string };

const AuthContext = createContext<AuthContextValue | null>(null);

function scopeForUser(user: User): DataScope {
  return user.role === "SUPER_ADMIN"
    ? { kind: "fleet" }
    : { kind: "org", orgId: user.orgId! };
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

  // Restore an existing session. Re-validating the username against the known
  // user list means a hand-edited localStorage entry cannot invent a role.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Session;
        const known = users.find((u) => u.username === parsed.user?.username);
        if (known) {
          const restoredScope =
            known.role === "SUPER_ADMIN" ? parsed.scope : scopeForUser(known);
          setSession({ user: known, scope: restoredScope, issuedAt: parsed.issuedAt });
        } else {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
        }
      }
    } catch {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    setIsLoading(false);
  }, []);

  const persist = useCallback((next: Session | null) => {
    setSession(next);
    if (next) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResult> => {
      const normalized = username.trim().toLowerCase();
      const user = users.find((u) => u.username === normalized);

      // One message for both failure modes — never reveal which usernames exist.
      const rejection: LoginResult = {
        ok: false,
        error: "That username and password combination was not recognized.",
      };
      if (!user) return rejection;
      if (password !== normalized) return rejection;

      if (user.role === "ORG_USER") {
        const org = organizations.find((o) => o.orgId === user.orgId);
        if (!org) {
          return { ok: false, error: "This organization is no longer configured." };
        }
        if (!org.enabled) {
          return {
            ok: false,
            error: `Monitoring is paused for ${org.canonicalName}. Contact your administrator to re-enable it.`,
          };
        }
      }

      persist({
        user,
        scope: scopeForUser(user),
        issuedAt: new Date().toISOString(),
      });
      return { ok: true, user };
    },
    [persist],
  );

  const logout = useCallback(() => persist(null), [persist]);

  const setScope = useCallback(
    (scope: DataScope) => {
      if (!session) return;
      // An ORG_USER cannot change scope. Enforced again on the server.
      if (session.user.role !== "SUPER_ADMIN") return;
      persist({ ...session, scope });
    },
    [session, persist],
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
    };
  }, [session, isLoading, login, logout, setScope]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
