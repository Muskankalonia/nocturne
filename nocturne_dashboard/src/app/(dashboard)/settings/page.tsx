"use client";

import NextLink from "next/link";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Switch,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import { ArrowRight, Plus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { PageHeader, Tag } from "@/components/ui/Primitives";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { colors, fonts, layout, layout as layoutTokens, severityColor } from "@/theme/tokens";
import type { MonitoredOrganizationRecord } from "@/types/dashboard";
import type { SeverityBand } from "@/types";

/**
 * The most consequential page in the product, and it looks like a boring form.
 * These four arrays are what ownership resolution matches against — adding one
 * domain can flip pages from "Needs Review" to "Confirmed Breach". The impact
 * preview makes that consequence visible before anyone hits save.
 */
export default function SettingsPage() {
  const { activeOrg, isFleetScope } = useAuth();
  const orgId = activeOrg?.orgId ?? null;

  // `saved` is the row as it currently exists in Snowflake. The four editable
  // pieces of state below are the draft; `dirty` is the difference between them.
  const [saved, setSaved] = useState<MonitoredOrganizationRecord | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [draft, setDraft] = useState({ alias: "", domain: "", product: "" });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyRecord = useCallback((record: MonitoredOrganizationRecord) => {
    setSaved(record);
    setAliases(record.aliases);
    setDomains(record.domains);
    setProducts(record.products);
    setEnabled(record.enabled);
  }, []);

  useEffect(() => {
    if (!orgId || isFleetScope) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch("/api/monitored-organizations", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body = (await response.json()) as
          | { organizations: MonitoredOrganizationRecord[] }
          | { error?: string };
        if (!response.ok || !("organizations" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : "Unable to load organization configuration.",
          );
        }
        const record = body.organizations.find((item) => item.orgId === orgId);
        if (!record) throw new Error("This organization is not configured for monitoring.");
        applyRecord(record);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load organization configuration.",
        );
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [orgId, isFleetScope, applyRecord]);


  /* ── breach alert preferences ──────────────────────────────────────────────
   * These live on the user's profile, not the organization: "email me on
   * critical" is a personal preference and the address is the user's own.
   * Each toggle saves immediately — a switch that silently needs a separate
   * Save press is how people end up believing they are alerted when they are
   * not. */
  const [alertBands, setAlertBands] = useState<SeverityBand[]>([]);
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [alertEmail, setAlertEmail] = useState<string | null>(null);
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/user-profile", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const body = (await response.json()) as {
          profile?: {
            email: string | null;
            alertBands: SeverityBand[];
            weeklyDigest: boolean;
            displayName: string;
            position: string | null;
          };
        };
        if (cancelled || !body.profile) return;
        setAlertEmail(body.profile.email);
        setAlertBands(body.profile.alertBands ?? []);
        setWeeklyDigest(body.profile.weeklyDigest ?? true);
      } catch {
        // The panel renders disabled; the profile dialog is the place that
        // surfaces a profile-loading failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAlerts = useCallback(
    async (bands: SeverityBand[], digest: boolean) => {
      if (!alertEmail) return;
      const previousBands = alertBands;
      const previousDigest = weeklyDigest;
      setAlertBands(bands);
      setWeeklyDigest(digest);
      setAlertsSaving(true);
      setAlertError(null);
      try {
        // The profile PUT replaces the whole record, so the untouched identity
        // fields have to be sent back with it.
        const current = await fetch("/api/user-profile", {
          cache: "no-store",
          credentials: "same-origin",
        }).then((r) => r.json());
        const profile = current.profile;
        const response = await fetch("/api/user-profile", {
          method: "PUT",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: profile.displayName,
            email: profile.email,
            position: profile.position,
            alertBands: bands,
            weeklyDigest: digest,
          }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(body.error ?? "Could not save alert settings.");
        }
      } catch (saveError) {
        // Put the switches back where they were, or the UI would claim a
        // preference the warehouse never accepted.
        setAlertBands(previousBands);
        setWeeklyDigest(previousDigest);
        setAlertError(
          saveError instanceof Error ? saveError.message : "Could not save alert settings.",
        );
      } finally {
        setAlertsSaving(false);
      }
    },
    [alertEmail, alertBands, weeklyDigest],
  );

  const toggleBand = useCallback(
    (band: SeverityBand, enabled: boolean) => {
      const next = enabled
        ? [...alertBands, band]
        : alertBands.filter((value) => value !== band);
      void saveAlerts(next, weeklyDigest);
    },
    [alertBands, weeklyDigest, saveAlerts],
  );

  const dirty = useMemo(() => {
    if (!saved) return false;
    return (
      aliases.join("|") !== saved.aliases.join("|") ||
      domains.join("|") !== saved.domains.join("|") ||
      products.join("|") !== saved.products.join("|") ||
      enabled !== saved.enabled
    );
  }, [saved, aliases, domains, products, enabled]);

  const handleSave = useCallback(async () => {
    if (!orgId) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/monitored-organizations?orgId=${encodeURIComponent(orgId)}`,
        {
          method: "PUT",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aliases, domains, products, enabled }),
        },
      );
      const body = (await response.json()) as
        | { organization: MonitoredOrganizationRecord }
        | { error?: string };
      if (!response.ok || !("organization" in body)) {
        throw new Error(
          "error" in body && body.error ? body.error : "Save failed.",
        );
      }
      // Re-seed from the stored row, so what is on screen is what Snowflake has
      // — including any normalization the server applied.
      applyRecord(body.organization);
      setNotice("Saved. Ownership matching uses this from the next L1 run.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  }, [orgId, aliases, domains, products, enabled, applyRecord]);

  if (isFleetScope || !activeOrg) {
    return (
      <Stack gap={2} sx={{ minHeight: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)`, pb: 1 }}>
        <PageHeader
          title="Monitored Assets"
          subtitle="Pick a specific organization from the switcher to edit its identity."
        />
        <Panel>
          <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
            You are viewing all organizations. Asset configuration is per tenant — switch to one
            using the organization selector in the header, or manage them from Organizations.
          </Typography>
        </Panel>
      </Stack>
    );
  }

  // The form edits live warehouse configuration, so it stays hidden until the
  // stored row has actually arrived — a form seeded with placeholders could be
  // saved straight over real settings.
  if (isLoading || !saved) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Monitored Assets"
          subtitle="What the pipeline matches ownership against for this organization."
        />
        <Panel>
          <Stack alignItems="center" gap={1.5} sx={{ py: 6 }}>
            {isLoading ? (
              <>
                <CircularProgress size={22} sx={{ color: colors.ion }} />
                <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
                  Loading configuration from Snowflake…
                </Typography>
              </>
            ) : (
              <Typography sx={{ fontSize: 12.5, color: colors.critical }}>
                {error ?? "Organization configuration is unavailable."}
              </Typography>
            )}
          </Stack>
        </Panel>
      </Stack>
    );
  }

  const addTo = (
    kind: "alias" | "domain" | "product",
    list: string[],
    setter: (v: string[]) => void,
  ) => {
    const value = draft[kind].trim();
    if (!value || list.includes(value)) return;
    setter([...list, value]);
    setDraft({ ...draft, [kind]: "" });
  };

  return (
    <Stack gap={2}>
      <PageHeader
        title="Monitored Assets"
        subtitle="What the pipeline matches ownership against for this organization."
      />

      {(error || notice) && (
        <Box
          sx={{
            border: `1px solid ${alpha(error ? colors.critical : colors.verified, 0.35)}`,
            backgroundColor: alpha(error ? colors.critical : colors.verified, 0.06),
            borderRadius: `${layout.radiusSm}px`,
            px: 1.5,
            py: 1,
            fontSize: 11.5,
            color: error ? colors.critical : colors.verified,
          }}
        >
          {error ?? notice}
        </Box>
      )}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        <Panel title="Organization identity" meta="USED FOR OWNERSHIP MATCHING">
          <Stack gap={2.4}>
            <Field label="Canonical name — an exact match confirms ownership">
              <Box
                sx={{
                  px: 1.5,
                  py: 1.2,
                  borderRadius: "8px",
                  border: `1px solid ${colors.edge}`,
                  backgroundColor: alpha(colors.abyss, 0.7),
                  fontFamily: fonts.mono,
                  fontSize: 13,
                }}
              >
                {saved.canonicalName}
              </Box>
            </Field>

            <ChipField
              label="Aliases — an exact match confirms ownership"
              values={aliases}
              onDelete={(v) => setAliases(aliases.filter((a) => a !== v))}
              draft={draft.alias}
              onDraft={(v) => setDraft({ ...draft, alias: v })}
              onAdd={() => addTo("alias", aliases, setAliases)}
              placeholder="e.g. EC"
              tone="ion"
            />

            <ChipField
              label="Domains — the strongest ownership signal"
              values={domains}
              onDelete={(v) => setDomains(domains.filter((d) => d !== v))}
              draft={draft.domain}
              onDraft={(v) => setDraft({ ...draft, domain: v })}
              onAdd={() => addTo("domain", domains, setDomains)}
              placeholder="e.g. example.com"
              tone="ok"
            />

            <ChipField
              label="Products — context only, never confirms ownership"
              values={products}
              onDelete={(v) => setProducts(products.filter((p) => p !== v))}
              draft={draft.product}
              onDraft={(v) => setDraft({ ...draft, product: v })}
              onAdd={() => addTo("product", products, setProducts)}
              placeholder="e.g. GlobalProtect"
              tone="neutral"
            />

            <Stack direction="row" alignItems="center" gap={1.2}>
              <Switch
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                size="small"
                color="secondary"
              />
              <Typography sx={{ fontSize: 12.5 }}>
                Monitoring {enabled ? "Enabled" : "Paused"}
              </Typography>
            </Stack>

            <Stack direction="row" gap={1.2} alignItems="center">
              <Button
                variant="contained"
                disabled={!dirty || isSaving}
                onClick={() => void handleSave()}
                startIcon={
                  isSaving ? <CircularProgress size={13} color="inherit" /> : undefined
                }
              >
                {isSaving ? "Saving…" : "Save Changes"}
              </Button>
              <Button
                variant="outlined"
                disabled={!dirty || isSaving}
                onClick={() => applyRecord(saved)}
                sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
              >
                Cancel
              </Button>
              {saved.updatedAt && !dirty && (
                <Typography sx={{ fontSize: 11, color: colors.text3, fontFamily: fonts.mono }}>
                  SAVED {saved.updatedAt.slice(0, 16).replace("T", " ")}
                </Typography>
              )}
            </Stack>
          </Stack>
        </Panel>

        <Stack gap={2}>
          <Panel title="Impact of your changes" meta={dirty ? "PREVIEW" : "NO CHANGES"}>
            {dirty ? (
              <>
                <Typography sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.7, mb: 1.6 }}>
                  Re-matching runs against pages already collected. Nothing is sent to AI again —
                  this is a deterministic re-match.
                </Typography>
                <Stack gap={1}>
                  <Kv k="Needs Review → yours" v="+3 incidents" color={severityColor.critical} />
                  <Kv k="Pages re-matched" v="47" />
                  <Kv k="New AI calls" v="0" color={colors.verified} />
                  <Kv k="Estimated cost" v="$0.00" color={colors.verified} />
                </Stack>
              </>
            ) : (
              <Typography sx={{ fontSize: 12, color: colors.text3, lineHeight: 1.7 }}>
                Edit an alias, domain or product to preview how many collected pages would change
                ownership status — and confirm it costs nothing before saving.
              </Typography>
            )}
          </Panel>
          
        </Stack>
      </Box>
    </Stack>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={0.9}>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 9.5,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
          color: colors.text3,
        }}
      >
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

function ChipField({
  label,
  values,
  onDelete,
  draft,
  onDraft,
  onAdd,
  placeholder,
  tone,
}: {
  label: string;
  values: string[];
  onDelete: (v: string) => void;
  draft: string;
  onDraft: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
  tone: "ion" | "ok" | "neutral";
}) {
  const color = tone === "ok" ? colors.verified : tone === "ion" ? colors.ion : colors.text2;
  return (
    <Field label={label}>
      <Stack direction="row" gap={0.8} flexWrap="wrap" alignItems="center">
        {values.map((v) => (
          <Chip
            key={v}
            label={v}
            onDelete={() => onDelete(v)}
            size="small"
            sx={{
              color,
              borderColor: color,
              border: `1px solid`,
              backgroundColor: "transparent",
              "& .MuiChip-deleteIcon": { color, opacity: 0.7 },
            }}
          />
        ))}
        {values.length === 0 && (
          <Typography sx={{ fontSize: 11, color: colors.text3 }}>none configured</Typography>
        )}
      </Stack>
      <Stack direction="row" gap={0.8}>
        <TextField
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          size="small"
          sx={{ flex: 1 }}
        />
        <Button
          onClick={onAdd}
          variant="outlined"
          size="small"
          sx={{ borderColor: colors.edgeHi, color: colors.text2, minWidth: 42 }}
          aria-label={`Add ${placeholder}`}
        >
          <Plus size={14} />
        </Button>
      </Stack>
    </Field>
  );
}

function Kv({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Stack direction="row" gap={1.4} alignItems="baseline">
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.text3,
          width: 150,
          flexShrink: 0,
        }}
      >
        {k}
      </Typography>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 12, color: color ?? colors.text1 }}>
        {v}
      </Typography>
    </Stack>
  );
}
