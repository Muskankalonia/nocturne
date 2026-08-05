"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, InputBase, Popper, Paper, Stack, Typography, alpha } from "@mui/material";
import { Search, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePosture } from "@/contexts/PostureContext";
import { colors, fonts, layout, severityColor, shadows } from "@/theme/tokens";
import { hostOf, routeLabel, shortHash } from "@/lib/format";

type Hit = {
  kind: "Incident" | "Actor" | "Organization";
  title: string;
  detail: string;
  href: string;
  accent: string;
};

/**
 * Global search across everything the session is allowed to see.
 *
 * The corpus is the live command-centre response, which the API has already
 * scoped to the session — an org user's payload only ever contains their own
 * tenant, so there is no client-side filter here that could be bypassed.
 * Actors are folded out of the incident rows rather than read from a separate
 * source, so an actor can only ever surface alongside an incident the caller
 * is already entitled to see.
 */
export function GlobalSearch() {
  const router = useRouter();
  const { session, isFleetScope } = useAuth();
  const { incidents, organizations } = usePosture();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl-K focuses search, Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // One row per distinct actor named in the visible incidents, with the counts
  // rolled up. Credibility is the max rather than the mean: the strongest
  // corroborated sighting is what an analyst is searching for.
  const actors = useMemo(() => {
    const rollup = new Map<
      string,
      { actorName: string; credibility: number; incidentCount: number; hosts: Set<string> }
    >();
    for (const incident of incidents) {
      if (!incident.actorName) continue;
      const entry = rollup.get(incident.actorName) ?? {
        actorName: incident.actorName,
        credibility: 0,
        incidentCount: 0,
        hosts: new Set<string>(),
      };
      entry.credibility = Math.max(entry.credibility, incident.actorCredibilityScore ?? 0);
      entry.incidentCount += 1;
      entry.hosts.add(hostOf(incident.topUrl));
      rollup.set(incident.actorName, entry);
    }
    return [...rollup.values()];
  }, [incidents]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !session) return [];

    const out: Hit[] = [];

    for (const i of incidents) {
      const haystack = [
        i.topTitle,
        i.organizationName,
        i.actorName ?? "",
        hostOf(i.topUrl),
        i.contentSha256,
        i.incidentKey,
        ...i.leakTypes,
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) {
        out.push({
          kind: "Incident",
          title: i.topTitle,
          detail: `${i.organizationName} · ${routeLabel[i.route]}${
            i.impactSeverityScore !== null ? ` · impact ${i.impactSeverityScore}` : ""
          }`,
          href: `/leaks/${i.incidentKey}`,
          accent: i.impactSeverityBand ? severityColor[i.impactSeverityBand] : colors.informational,
        });
      }
    }

    for (const a of actors) {
      if ([a.actorName, ...a.hosts].join(" ").toLowerCase().includes(q)) {
        out.push({
          kind: "Actor",
          title: a.actorName,
          detail: `credibility ${a.credibility} · ${a.incidentCount} incident${
            a.incidentCount === 1 ? "" : "s"
          }`,
          href: "/actors",
          accent: colors.ion,
        });
      }
    }

    if (isFleetScope) {
      for (const o of organizations) {
        if ([o.organizationName, o.orgId].join(" ").toLowerCase().includes(q)) {
          out.push({
            kind: "Organization",
            title: o.organizationName,
            detail: `${o.metrics.incidentsByBand.critical} critical · ${o.orgId}`,
            href: "/admin/organizations",
            accent: colors.verified,
          });
        }
      }
    }

    return out.slice(0, 8);
  }, [query, session, isFleetScope, incidents, actors, organizations]);

  useEffect(() => setActive(0), [query]);

  const go = (hit: Hit) => {
    setOpen(false);
    setQuery("");
    router.push(hit.href);
  };

  return (
    <>
      <Stack
        ref={anchorRef}
        direction="row"
        alignItems="center"
        gap={1.1}
        sx={{
          flex: 1,
          maxWidth: 400,
          px: 1.4,
          py: 0.75,
          borderRadius: `${layout.radiusSm}px`,
          border: `1px solid ${colors.edge}`,
          backgroundColor: alpha(colors.abyss, 0.7),
          "&:focus-within": {
            borderColor: alpha(colors.ion, 0.5),
            boxShadow: `0 0 0 3px ${alpha(colors.ion, 0.1)}`,
          },
        }}
      >
        <Search size={13} color={colors.text3} />
        <InputBase
          inputRef={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % hits.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + hits.length) % hits.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(hits[active]!);
            }
          }}
          placeholder={
            isFleetScope
              ? "Search all tenants — incidents, actors, domains…"
              : "Search incidents, actors, hosts, hashes…"
          }
          inputProps={{ "aria-label": "Search" }}
          sx={{
            flex: 1,
            fontSize: 12,
            color: colors.text1,
            "& input::placeholder": { color: colors.text3, opacity: 1 },
          }}
        />
        {query ? (
          <Box
            component="button"
            type="button"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setQuery("")}
            sx={{
              border: 0,
              background: "none",
              cursor: "pointer",
              color: colors.text3,
              display: "flex",
              p: 0,
              "&:hover": { color: colors.text1 },
            }}
          >
            <X size={13} />
          </Box>
        ) : (
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 9.5,
              color: colors.text3,
              border: `1px solid ${colors.edge}`,
              borderRadius: "4px",
              px: 0.6,
              whiteSpace: "nowrap",
            }}
          >
            ⌘K
          </Typography>
        )}
      </Stack>

      <Popper
        open={open && query.trim().length >= 2}
        anchorEl={anchorRef.current}
        placement="bottom-start"
        sx={{ zIndex: 1300 }}
      >
        <Paper
          sx={{
            mt: 0.8,
            width: anchorRef.current?.clientWidth ?? 380,
            maxHeight: 420,
            overflowY: "auto",
            backgroundColor: colors.hullHi,
            border: `1px solid ${colors.edgeHi}`,
            boxShadow: shadows.menu,
            p: 0.7,
          }}
        >
          {hits.length === 0 ? (
            <Box sx={{ p: 1.6 }}>
              <Typography sx={{ fontSize: 12, color: colors.text2 }}>
                No matches for “{query}”.
              </Typography>
              <Typography sx={{ fontSize: 11, color: colors.text3, mt: 0.8, lineHeight: 1.6 }}>
                Try an incident title, an actor alias, a host, a leak type, or a content hash.
              </Typography>
            </Box>
          ) : (
            hits.map((hit, i) => (
              <Box
                key={`${hit.kind}-${hit.href}-${hit.title}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(hit)}
                onMouseEnter={() => setActive(i)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.2,
                  px: 1.3,
                  py: 1,
                  borderRadius: "7px",
                  cursor: "pointer",
                  backgroundColor: i === active ? alpha(colors.ion, 0.1) : "transparent",
                }}
              >
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "1px",
                    backgroundColor: hit.accent,
                    flexShrink: 0,
                  }}
                />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      color: colors.text1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {hit.title}
                  </Typography>
                  <Typography sx={{ fontSize: 10.5, color: colors.text3, fontFamily: fonts.mono }}>
                    {hit.detail}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    fontFamily: fonts.mono,
                    fontSize: 9,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: colors.text3,
                    flexShrink: 0,
                  }}
                >
                  {hit.kind}
                </Typography>
              </Box>
            ))
          )}
        </Paper>
      </Popper>
    </>
  );
}

export default GlobalSearch;
