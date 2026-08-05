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
import { useAuth } from "@/contexts/AuthContext";
import type {
  CommandCenterOrganizationSnapshot,
  CommandCenterResponse,
  DashboardIncident,
} from "@/types/dashboard";
import type { SeverityBand } from "@/types";

/**
 * One live read of `/api/command-center`, shared by the chrome and the page.
 *
 * This exists because the shell used to derive its numbers from `@/mocks`
 * while the page underneath it read Snowflake, so the rail could claim two
 * critical incidents beside a KPI reporting one. Both now consume the same
 * response, which makes disagreement impossible rather than merely unlikely.
 *
 * The fetch lives here rather than in the page so that mounting the shell does
 * not cost a second query — the command centre, the sidebar badge, the tenant
 * switcher and global search all read this one payload.
 */

const configuredRefreshMs = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_MS ?? "300000",
);
const refreshIntervalMs =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs >= 30_000
    ? configuredRefreshMs
    : 300_000;

/** A tenant's headline posture, for the switcher's per-org triage summary. */
export interface OrgPostureSummary {
  orgId: string;
  criticals: number;
  topScore: number;
  band: SeverityBand;
  /** False when the current scope excludes this tenant, so it has no numbers. */
  hasData: boolean;
}

export interface PostureContextValue {
  /** Null until the first successful load, or while the scope is mismatched. */
  data: CommandCenterResponse | null;
  incidents: DashboardIncident[];
  organizations: CommandCenterOrganizationSnapshot[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
  /** Critical incidents still needing work — the sidebar badge. */
  openCriticalCount: number;
  summaryFor: (orgId: string) => OrgPostureSummary;
}

const PostureContext = createContext<PostureContextValue | null>(null);

/** Statuses that take an incident off the queue. Anything else still counts. */
const CLOSED_STATUSES = new Set(["resolved", "false_positive", "suppressed"]);

function bandForScore(score: number): SeverityBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score >= 20) return "low";
  return "informational";
}

export function PostureProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [data, setData] = useState<CommandCenterResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal, background = false) => {
      if (!session) return;
      if (background) setIsRefreshing(true);
      const params = new URLSearchParams();
      if (session.user.role === "SUPER_ADMIN" && session.scope.kind === "org") {
        params.set("orgId", session.scope.orgId);
      }
      const url = params.size
        ? `/api/command-center?${params.toString()}`
        : "/api/command-center";

      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const body = (await response.json()) as
          | CommandCenterResponse
          | { error?: string };
        if (!response.ok || !("totals" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : "Unable to load live dashboard data.",
          );
        }
        setData(body);
        setError(null);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load live dashboard data.",
        );
      } finally {
        if (background) setIsRefreshing(false);
      }
    },
    [session],
  );

  useEffect(() => {
    if (!session) {
      setData(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setData(null);
    setError(null);
    setIsLoading(true);
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void load(controller.signal, true);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, refreshIntervalMs);
    window.addEventListener("focus", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [load, session]);

  // A response that arrived for a scope we have since left must not be
  // rendered — an org user would briefly see fleet aggregates, and an admin
  // who switched tenant would see the previous tenant's rows.
  const visibleData = useMemo(() => {
    if (!data || !session) return null;
    if (data.scope.kind !== session.scope.kind) return null;
    if (data.scope.kind === "fleet") return data;
    return session.scope.kind === "org" && data.scope.orgId === session.scope.orgId
      ? data
      : null;
  }, [data, session]);

  const value = useMemo<PostureContextValue>(() => {
    const incidents = visibleData?.incidents ?? [];
    const organizations = visibleData?.organizations ?? [];

    const openCriticalCount = incidents.filter(
      (incident) =>
        incident.impactSeverityBand === "critical"
        && !CLOSED_STATUSES.has(incident.remediationStatus),
    ).length;

    // Per-tenant rollup, computed from the incidents actually in scope. A
    // tenant outside the current scope reports `hasData: false` rather than a
    // zero, because "no rows here" and "nothing wrong there" are not the same
    // claim and the switcher must not imply the second.
    const byOrg = new Map<string, { criticals: number; topScore: number }>();
    for (const organization of organizations) {
      byOrg.set(organization.orgId, { criticals: 0, topScore: 0 });
    }
    for (const incident of incidents) {
      const entry = byOrg.get(incident.orgId) ?? { criticals: 0, topScore: 0 };
      if (incident.impactSeverityBand === "critical") entry.criticals += 1;
      entry.topScore = Math.max(entry.topScore, incident.impactSeverityScore ?? 0);
      byOrg.set(incident.orgId, entry);
    }

    const summaryFor = (orgId: string): OrgPostureSummary => {
      const entry = byOrg.get(orgId);
      if (!entry) {
        return { orgId, criticals: 0, topScore: 0, band: "informational", hasData: false };
      }
      return {
        orgId,
        criticals: entry.criticals,
        topScore: entry.topScore,
        band: bandForScore(entry.topScore),
        hasData: true,
      };
    };

    return {
      data: visibleData,
      incidents,
      organizations,
      isLoading,
      isRefreshing,
      error,
      refresh: () => void load(undefined, true),
      openCriticalCount,
      summaryFor,
    };
  }, [visibleData, isLoading, isRefreshing, error, load]);

  return <PostureContext.Provider value={value}>{children}</PostureContext.Provider>;
}

export function usePosture(): PostureContextValue {
  const ctx = useContext(PostureContext);
  if (!ctx) throw new Error("usePosture must be used inside <PostureProvider>");
  return ctx;
}
