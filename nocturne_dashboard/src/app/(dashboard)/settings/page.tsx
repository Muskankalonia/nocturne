"use client";

import { useMemo, useState } from "react";
import { Box, Button, Chip, Divider, Stack, Switch, TextField, Typography } from "@mui/material";
import { Plus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { PageHeader, Tag } from "@/components/ui/Primitives";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { colors, fonts, severityColor } from "@/theme/tokens";

/**
 * The most consequential page in the product, and it looks like a boring form.
 * These four arrays are what ownership resolution matches against — adding one
 * domain can flip pages from "Needs review" to "Confirmed yours". The impact
 * preview makes that consequence visible before anyone hits save.
 */
export default function SettingsPage() {
  const { activeOrg, isFleetScope } = useAuth();

  const [aliases, setAliases] = useState<string[]>(activeOrg?.aliases ?? []);
  const [domains, setDomains] = useState<string[]>(activeOrg?.domains ?? []);
  const [products, setProducts] = useState<string[]>(activeOrg?.products ?? []);
  const [enabled, setEnabled] = useState(activeOrg?.enabled ?? true);
  const [draft, setDraft] = useState({ alias: "", domain: "", product: "" });

  const dirty = useMemo(() => {
    if (!activeOrg) return false;
    return (
      aliases.join("|") !== activeOrg.aliases.join("|") ||
      domains.join("|") !== activeOrg.domains.join("|") ||
      products.join("|") !== activeOrg.products.join("|") ||
      enabled !== activeOrg.enabled
    );
  }, [activeOrg, aliases, domains, products, enabled]);

  if (isFleetScope || !activeOrg) {
    return (
      <Stack gap={2}>
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
                  backgroundColor: "rgba(6,11,20,0.85)",
                  fontFamily: fonts.mono,
                  fontSize: 13,
                }}
              >
                {activeOrg.canonicalName}
              </Box>
            </Field>

            <ChipField
              label="Aliases — an exact match confirms ownership"
              values={aliases}
              onDelete={(v) => setAliases(aliases.filter((a) => a !== v))}
              draft={draft.alias}
              onDraft={(v) => setDraft({ ...draft, alias: v })}
              onAdd={() => addTo("alias", aliases, setAliases)}
              placeholder="e.g. PANW"
              tone="ion"
            />

            <ChipField
              label="Domains — the strongest ownership signal"
              values={domains}
              onDelete={(v) => setDomains(domains.filter((d) => d !== v))}
              draft={draft.domain}
              onDraft={(v) => setDraft({ ...draft, domain: v })}
              onAdd={() => addTo("domain", domains, setDomains)}
              placeholder="e.g. panw.com"
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
                Monitoring {enabled ? "enabled" : "paused"}
              </Typography>
            </Stack>

            <Stack direction="row" gap={1.2}>
              <Button variant="contained" disabled={!dirty}>
                Save changes
              </Button>
              <Button
                variant="outlined"
                disabled={!dirty}
                onClick={() => {
                  setAliases(activeOrg.aliases);
                  setDomains(activeOrg.domains);
                  setProducts(activeOrg.products);
                  setEnabled(activeOrg.enabled);
                }}
                sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
              >
                Cancel
              </Button>
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
                  <Kv k="Needs review → yours" v="+3 incidents" color={severityColor.critical} />
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

          <Panel title="Alerts">
            <Stack gap={1.4}>
              {(
                [
                  ["critical", true],
                  ["high", true],
                  ["medium", false],
                ] as const
              ).map(([band, on]) => (
                <Stack key={band} direction="row" alignItems="center" gap={1.2}>
                  <Switch defaultChecked={on} size="small" color="secondary" />
                  <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>Email me on</Typography>
                  <SeverityChip band={band} />
                </Stack>
              ))}
              <Divider sx={{ borderColor: colors.edge, my: 0.5 }} />
              <Stack direction="row" alignItems="center" gap={1.2}>
                <Switch defaultChecked size="small" color="secondary" />
                <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
                  Weekly digest of everything else
                </Typography>
              </Stack>
            </Stack>
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
