"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  FOCUS_QUERY_PARAM,
  canonicalNodeKey,
  type GraphFocus,
  type GraphFocusPrecision,
  type GraphFocusResolution,
} from "@/lib/graph-focus";

/**
 * The graph selection, promoted to a filter the whole console can read.
 *
 * A click on the canvas has to reach panels that are not the canvas — the KPI
 * row, the severity split, the priority queue, and the same page after a
 * navigation. That is why this is a context and not page state: the Command
 * Center's embedded network and the full-screen `/graph` screen both write
 * here, and the Command Center reads it wherever the click came from.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **A click never waits.** The caller resolves the selection locally from
 *    the graph payload it already holds and passes those incident keys in, so
 *    the page filters in the same frame. The exact answer from the warehouse
 *    replaces them when it lands, and `precision` says which one is on screen.
 *
 * 2. **A focus cannot outlive its tenant.** Incident keys are org-scoped, so a
 *    focus set while looking at one organization must be dropped the moment the
 *    scope changes rather than silently filtering another tenant's rows against
 *    keys that belong to somebody else.
 */

export interface FocusContextValue {
  focus: GraphFocus | null;
  /** Null while a URL-restored focus is still resolving. */
  incidentKeys: string[] | null;
  precision: GraphFocusPrecision;
  isResolving: boolean;
  error: string | null;
  /**
   * `attributedIncidentKeys` is the caller's local answer, used until the
   * warehouse replies. Pass what the graph walk found — an empty array is a
   * legitimate answer and is treated as one.
   */
  setFocus: (focus: GraphFocus, attributedIncidentKeys: string[]) => void;
  clearFocus: () => void;
  /** Identity when nothing is focused, so callers can apply it unconditionally. */
  filterIncidents: <T extends { incidentKey: string }>(incidents: readonly T[]) => readonly T[];
}

const FocusContext = createContext<FocusContextValue | null>(null);

/** Reflect the focus in the URL so a filtered console is a shareable link. */
function writeFocusToUrl(nodeKey: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (nodeKey) url.searchParams.set(FOCUS_QUERY_PARAM, nodeKey);
  else url.searchParams.delete(FOCUS_QUERY_PARAM);
  // history over the router: this provider wraps every dashboard page, and
  // reading the params through `useSearchParams()` here would opt all of them
  // out of static prerendering for a value that is cosmetic on first paint.
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const orgId = session?.scope.kind === "org" ? session.scope.orgId : null;

  const [focus, setFocusState] = useState<GraphFocus | null>(null);
  const [incidentKeys, setIncidentKeys] = useState<string[] | null>(null);
  const [precision, setPrecision] = useState<GraphFocusPrecision>("empty");
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the newest selection may write state. Without this a slow resolve for
  // a node the analyst has already clicked past would overwrite the current
  // one — the filter would settle on the wrong entity and look haunted.
  const requestRef = useRef(0);

  const resolve = useCallback(
    async (nodeKey: string, token: number) => {
      if (!orgId) return;
      setIsResolving(true);
      const query = new URLSearchParams({ nodeKey, orgId });
      try {
        const response = await fetch(`/api/graph-focus?${query.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const body = (await response.json()) as
          | GraphFocusResolution
          | { error?: string };
        if (requestRef.current !== token) return;
        if (!response.ok || !("incidentKeys" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : "Unable to resolve the selected entity.",
          );
        }
        setIncidentKeys(body.incidentKeys);
        setPrecision("exact");
        setError(null);
        // A focus restored from a link arrives without a label or a type; the
        // warehouse knows both, so adopt them once it answers.
        setFocusState((current) =>
          current && current.nodeKey === body.nodeKey
            ? {
                ...current,
                label: current.label || body.displayName || "",
                nodeType: current.nodeType
                  ?? (body.nodeType as GraphFocus["nodeType"] | null),
              }
            : current,
        );
      } catch (resolveError) {
        if (requestRef.current !== token) return;
        // The local attribution match stays on screen. It is an approximation,
        // and `precision` already says so, but it is far better than dropping
        // the analyst's filter because one request failed.
        setError(
          resolveError instanceof Error
            ? resolveError.message
            : "Unable to resolve the selected entity.",
        );
      } finally {
        if (requestRef.current === token) setIsResolving(false);
      }
    },
    [orgId],
  );

  const setFocus = useCallback(
    (next: GraphFocus, attributedIncidentKeys: string[]) => {
      const token = requestRef.current + 1;
      requestRef.current = token;
      const nodeKey = canonicalNodeKey(next.nodeKey);
      setFocusState({ ...next, nodeKey });
      // An empty local answer is treated as "not known yet", not as "nothing
      // matched". Attribution only reaches incidents credited to an actor, so
      // an empty result there is as likely to mean the walk fell short as it
      // is to mean the entity is clean — and filtering the page to zero on
      // that guess, a beat before the warehouse says otherwise, is the one
      // failure mode that would read as the feature being broken.
      setIncidentKeys(attributedIncidentKeys.length > 0 ? attributedIncidentKeys : null);
      setPrecision(attributedIncidentKeys.length > 0 ? "attributed" : "empty");
      setError(null);
      writeFocusToUrl(nodeKey);
      void resolve(nodeKey, token);
    },
    [resolve],
  );

  const clearFocus = useCallback(() => {
    requestRef.current += 1;
    setFocusState(null);
    setIncidentKeys(null);
    setPrecision("empty");
    setIsResolving(false);
    setError(null);
    writeFocusToUrl(null);
  }, []);

  // Restore from the URL once the tenant is known. Read from `location` rather
  // than `useSearchParams()` for the prerendering reason noted above.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !orgId) return;
    restoredRef.current = true;
    const nodeKey = new URLSearchParams(window.location.search).get(FOCUS_QUERY_PARAM);
    if (!nodeKey) return;

    const token = requestRef.current + 1;
    requestRef.current = token;
    setFocusState({
      // Both filled in from the resolution; until it lands the banner names
      // neither rather than guessing at them.
      nodeKey: canonicalNodeKey(nodeKey),
      label: "",
      nodeType: null,
      origin: "node",
    });
    void resolve(canonicalNodeKey(nodeKey), token);
  }, [orgId, resolve]);

  // Tenant changed underneath the filter — see the header comment.
  const lastOrgRef = useRef(orgId);
  useEffect(() => {
    if (lastOrgRef.current === orgId) return;
    lastOrgRef.current = orgId;
    clearFocus();
  }, [clearFocus, orgId]);

  const value = useMemo<FocusContextValue>(() => {
    const keySet = incidentKeys ? new Set(incidentKeys) : null;
    return {
      focus,
      incidentKeys,
      precision,
      isResolving,
      error,
      setFocus,
      clearFocus,
      filterIncidents: (incidents) => {
        // No focus, or a focus whose incident set is not known yet: show
        // everything. Blanking the page while a request is in flight would
        // read as "this entity has no incidents", which is a different and
        // wrong claim.
        if (!focus || !keySet) return incidents;
        return incidents.filter((incident) => keySet.has(incident.incidentKey));
      },
    };
  }, [clearFocus, error, focus, incidentKeys, isResolving, precision, setFocus]);

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error("useFocus must be used inside <FocusProvider>");
  return ctx;
}
