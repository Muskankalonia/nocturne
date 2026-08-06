import type { L2Route, LeakType, RemediationStatus } from "@/types";

/**
 * User-facing language. The UI never shows "target_confirmed" or "L2" as a
 * primary label — an analyst should not have to learn the pipeline's internals
 * to read their own dashboard. The raw token stays available as a tooltip or a
 * muted secondary tag where provenance matters.
 */

export const routeLabel: Record<L2Route, string> = {
  target_confirmed: "Confirmed Breach",
  other_organization_confirmed: "Other Company Breach",
  ambiguous: "Needs Review",
  not_relevant: "Not Relevant",
  extraction_error: "Processing Failed",
};

export const routeTone: Record<L2Route, "ok" | "neutral" | "medium" | "critical"> = {
  target_confirmed: "ok",
  other_organization_confirmed: "neutral",
  ambiguous: "medium",
  not_relevant: "neutral",
  extraction_error: "critical",
};

export const leakTypeLabel: Record<LeakType, string> = {
  credential: "Credentials",
  corporate_data: "Corporate Data",
  pii: "Personal Data",
  financial: "Financial",
  malware_exploit: "Malware / Exploit",
};

/** The two classes that most often mean immediate, actionable harm. */
export const highRiskLeakTypes: LeakType[] = ["credential", "financial"];

export const remediationLabel: Record<RemediationStatus, string> = {
  new: "New",
  investigating: "Investigating",
  contained: "Contained",
  resolved: "Resolved",
  false_positive: "False Positive",
  suppressed: "Suppressed",
  context_only: "Context Only",
};

export const remediationTone: Record<
  RemediationStatus,
  "critical" | "high" | "ok" | "neutral"
> = {
  new: "critical",
  investigating: "high",
  contained: "ok",
  resolved: "ok",
  false_positive: "neutral",
  suppressed: "neutral",
  context_only: "neutral",
};

/** Reason codes from SCORE_REASONS, in plain English. */
export const scoreReasonLabel: Record<string, string> = {
  grounded_target_ownership_confirmed: "Ownership confirmed by grounded evidence",
  record_count_unknown_and_omitted: "Record count unknown — excluded from scoring",
  corroborated_by_3_or_more_distinct_contents: "Confirmed by 3+ independent sources",
  corroborated_by_2_distinct_contents: "Confirmed by 2 independent sources",
  single_distinct_content: "Only one source so far",
  same_content_mirrors_not_counted_as_corroboration: "Reposts not counted as confirmation",
  claim_disputed: "Claim disputed elsewhere",
  strong_exposed_material_present: "Live secret material on the page",
  actor_not_identified_confidence_weight_omitted: "No identified actor",
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function shortHash(hash: string, head = 8, tail = 8): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  return n.toLocaleString();
}

export function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Avatar initials from a display name.
 *
 * Shared by the session overlay on the server and by the in-memory profile
 * update on the client: if only one of them recomputed initials, renaming
 * yourself would leave the previous person's letters in the avatar until the
 * next sign-in.
 */
export function initialsFromName(name: string, fallback = ""): string {
  const letters = name
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return letters || fallback;
}
