import type { Metadata } from "next";
import type { ReactNode } from "react";
import NextLink from "next/link";
import { Box, Stack, Typography, alpha } from "@mui/material";
import {
  Boxes,
  FileSearch,
  Gauge,
  MailWarning,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { colors, fonts, gradients, layout, shadows } from "@/theme/tokens";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { GraphDemo } from "./GraphDemo";
import { HeroGraphic } from "./HeroGraphic";
import { HeroActions, StartNav } from "./StartNav";

/**
 * Public landing page — the front door at /start.
 *
 * Two constraints shaped this file.
 *
 * It reads nothing. Every figure below is a constant from a recorded reference
 * run, never a live query. This page is unauthenticated and world-reachable, so
 * wiring it to Snowflake would let anyone with the URL resume COMPUTE_WH by
 * reloading, which is both a cost and an availability problem. The stat band is
 * labelled as a reference run so nobody reads it as a live counter.
 *
 * It is a server component apart from the nav and the hero buttons. The copy is
 * static and should paint without waiting on the client bundle; only the two
 * call-to-action clusters need to know whether a session exists.
 *
 * Everything visual comes from theme/tokens. The two colour rules still hold —
 * `ion` appears on interactive things and as ambient glow (the same licence the
 * login poster takes), and `verified` green appears only where the product
 * means grounded-verbatim, which here is the evidence block.
 */

export const metadata: Metadata = {
  title: "Nocturne — dark-web breach intelligence with the receipt",
  description:
    "Nocturne finds the dark-web leaks that are actually yours, and shows the "
    + "verbatim line that proves it. Tor collection, a Snowflake Cortex AI "
    + "cascade, and a knowledge graph that has to connect to you before anything "
    + "is called a breach.",
};

/* ── recorded reference run ───────────────────────────────────────────────────
 * Captured from the deployed pipeline. Kept here as constants, deliberately:
 * see the note at the top about why this page never queries.
 */
const REFERENCE = {
  recordsClaimed: 52_001_534,
  confirmedLeaks: 18,
  incidents: 13,
  dataClasses: 5,
} as const;

const CASCADE = [
  { stage: "L0", label: "Collected", count: 30, note: "Tor pages landed and deduplicated" },
  { stage: "L0", label: "Indicators", count: 30, note: "Deterministic regex sweep, no AI spend" },
  { stage: "L1", label: "Selected", count: 22, note: "Relationship AI keeps only plausible leaks" },
  { stage: "L2", label: "Extracted", count: 21, note: "Evidence-only extraction, target hidden" },
  { stage: "L2", label: "Grounded", count: 20, note: "Every quote matched back to its page" },
  { stage: "L3", label: "Classified", count: 15, note: "Connected to a monitored organization" },
  { stage: "L4", label: "Incidents", count: 13, note: "Scored for impact, confidence, triage" },
] as const;

const CAPABILITIES = [
  {
    icon: FileSearch,
    title: "Extraction that cannot flatter you",
    body:
      "The L2 model never sees which organization you are monitoring. It reads the "
      + "page and reports what the page says. Only afterwards does deterministic SQL "
      + "resolve the names and domains it found against your profile — so a match is "
      + "something the evidence produced, not something the prompt suggested.",
  },
  {
    icon: ShieldCheck,
    title: "Grounded or it does not ship",
    body:
      "Every claim carries the verbatim span it came from, matched back to the source "
      + "page. A claim that cannot be grounded is dropped before it reaches the graph. "
      + "Nothing in the console is a summary you have to take on trust.",
  },
  {
    icon: Gauge,
    title: "Severity split three ways",
    body:
      "How bad it would be, how sure we are, and what to open first are three different "
      + "questions, so they are three independent 0–100 scores. A terrifying claim with "
      + "thin evidence sorts differently from a modest one that is nailed down.",
  },
  {
    icon: MailWarning,
    title: "Alerts with the receipt attached",
    body:
      "When a leak is confirmed against your organization, the notification carries the "
      + "quote, the actor, the marketplace and the scores — not a link asking you to go "
      + "and find out whether it mattered.",
  },
] as const;

const EDGES = [
  { edge: "MADE_CLAIM", meaning: "Actor posted or advertised the leak" },
  { edge: "ALLEGEDLY_AFFECTS", meaning: "Claim targets a specific organization" },
  { edge: "MENTIONS", meaning: "Claim references a data asset" },
  { edge: "LISTED_ON", meaning: "Claim appeared on a marketplace or forum" },
  { edge: "HAS_DOMAIN", meaning: "Organization owns a domain seen in evidence" },
  { edge: "OPERATES_ON", meaning: "Actor has presence on a marketplace" },
] as const;

const ARCHITECTURE = [
  {
    step: "Collect",
    body: "Ahmia and Dread discovery, then a breadth-first Tor crawl through headless Chromium. Pages land in GCS as gzipped JSONL.",
  },
  {
    step: "Land",
    body: "Snowflake ingests every five minutes and deduplicates on (org_id, dedupe_key), so a page recrawled tomorrow costs nothing twice.",
  },
  {
    step: "Cascade",
    body: "A deterministic indicator UDF, then cached AI_CLASSIFY, then cached AI_COMPLETE extraction with SQL grounding behind it.",
  },
  {
    step: "Score",
    body: "Multi-label leak typing, an organization-scoped knowledge graph, three-axis severity, and one AI narrative per incident.",
  },
  {
    step: "Serve",
    body: "Thirteen read-only views feed the Next.js analyst console. Every object in the chain is scoped by ORG_ID.",
  },
] as const;

const MAX_CASCADE = Math.max(...CASCADE.map((row) => row.count));

/** Matches the md height of the sticky bar in StartNav. */
const NAV_HEIGHT = 68;

export default function StartPage() {
  return (
    <Box sx={{ backgroundColor: colors.abyss, backgroundImage: gradients.page, minHeight: "100dvh" }}>
      <StartNav />

      {/* ── hero ──────────────────────────────────────────────────────────── */}
      {/* The backdrop is clipped to this section, so the animated layers stop at
        * the fold rather than drifting behind the whole document. */}
      <Box component="section" sx={{ position: "relative", overflow: "hidden" }}>
        <AmbientBackdrop />

        {/* The hero owns the first screen. Height is set on the grid rather than
          * padded to size, so the content centres in whatever is left after the
          * nav and the empty quarters fall out top and bottom on their own. */}
        <Shell
          sx={{
            position: "relative",
            zIndex: 1,
            pt: { xs: 7, md: 4 },
            pb: { xs: 7, md: 4 },
          }}
        >
          <Box
            sx={{
              display: "grid",
              gap: { xs: 6, lg: 8 },
              // The graphic is supporting material, not the message. It appears
              // only once there is width for the headline to keep its own
              // measure — below that it would squeeze the copy to buy nothing.
              gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
              alignItems: "center",
              minHeight: { md: `calc(100dvh - ${NAV_HEIGHT + 40}px)` },
            }}
          >
            <Box>
              {/* Aligned to the first line, not the block: this wraps to two
                * lines on a narrow phone, and centring would drop the dot into
                * the gap between them. Tracking tightens at xs so it usually
                * does not wrap at all. */}
              <Stack direction="row" alignItems="flex-start" gap={1.1} sx={{ mb: 3 }}>
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    mt: "5px",
                    flexShrink: 0,
                    borderRadius: "50%",
                    backgroundColor: colors.verified,
                    boxShadow: `0 0 10px ${alpha(colors.verified, 0.8)}`,
                  }}
                />
                <Mono
                  sx={{
                    color: colors.text2,
                    fontSize: { xs: 9.5, sm: 10.5 },
                    letterSpacing: { xs: "0.09em", sm: "0.15em" },
                  }}
                >
                  Built on Snowflake Cortex · claude-sonnet-4-5
                </Mono>
              </Stack>

              <Typography
                variant="h1"
                sx={{
                  fontSize: "clamp(34px, 5.2vw, 62px)",
                  lineHeight: 1.06,
                  letterSpacing: "-0.03em",
                  maxWidth: "15ch",
                  textWrap: "balance",
                }}
              >
                Every breach alert comes with{" "}
                <Box component="span" sx={{ color: colors.ion }}>
                  the receipt
                </Box>
                .
              </Typography>

              <Typography
                sx={{
                  mt: 3,
                  maxWidth: "54ch",
                  fontSize: { xs: 14.5, md: 16 },
                  lineHeight: 1.65,
                  color: colors.text2,
                }}
              >
                Most dark-web monitoring hands you a pile of maybes and leaves the
                verification to you. Nocturne crawls the same sources, then refuses
                to call anything a breach until the evidence connects to your
                organization — and shows you the exact line it used.
              </Typography>

              <HeroActions />
            </Box>

            <Stack
              alignItems="center"
              justifyContent="center"
              sx={{ display: { xs: "none", lg: "flex" }, minWidth: 0 }}
            >
              <HeroGraphic />
              <Mono sx={{ color: colors.text3, mt: 3.5, textAlign: "center" }}>
                One accepted edge decides whether it is yours
              </Mono>
            </Stack>
          </Box>
        </Shell>
      </Box>

      {/* ── stat band ─────────────────────────────────────────────────────── */}
      <Box component="section">
        <Shell sx={{ pt: { xs: 0, md: 2 }, pb: { xs: 7, md: 10 } }}>
          <Box
            sx={{
              borderRadius: `${layout.radius}px`,
              border: `1px solid ${colors.edge}`,
              backgroundImage: gradients.panel,
              backdropFilter: "blur(20px)",
              boxShadow: shadows.raised,
              overflow: "hidden",
            }}
          >
            {/* Rules are placed here rather than on the cell so they follow the
              * reflow: three verticals in a four-across row, and a cross in the
              * 2×2 the same cells become on a phone. */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" },
                "& > *": {
                  borderRight: `1px solid ${colors.edge}`,
                  borderBottom: { xs: `1px solid ${colors.edge}`, md: "none" },
                },
                "& > *:nth-of-type(2n)": {
                  borderRight: { xs: "none", md: `1px solid ${colors.edge}` },
                },
                "& > *:nth-of-type(4)": { borderRight: "none" },
                "& > *:nth-of-type(n+3)": { borderBottom: "none" },
              }}
            >
              <Stat value={REFERENCE.recordsClaimed.toLocaleString()} label="Records claimed" />
              <Stat value={String(REFERENCE.confirmedLeaks)} label="Confirmed leaks" />
              <Stat value={String(REFERENCE.incidents)} label="Scored incidents" />
              <Stat value={String(REFERENCE.dataClasses)} label="Exposed data classes" />
            </Box>
            <Box sx={{ px: 2.5, py: 1.4, borderTop: `1px solid ${colors.edge}` }}>
              <Mono sx={{ color: colors.text3 }}>
                Recorded reference run of the deployed pipeline — not a live counter
              </Mono>
            </Box>
          </Box>
        </Shell>
      </Box>

      {/* ── cascade ───────────────────────────────────────────────────────── */}
      <Section id="cascade" eyebrow="How it works">
        <SectionHead
          title="Thirty pages in. Thirteen incidents out."
          body={
            <>
              Each stage is allowed to throw work away, and the expensive stages sit
              last on purpose. Deterministic regex runs on everything; the models only
              ever see what survived. Every AI result is cached against its input, so
              recrawling the same page costs nothing.
            </>
          }
        />

        <Stack gap={0.9} sx={{ mt: 5 }}>
          {CASCADE.map((row, index) => (
            <Stack
              key={`${row.stage}-${row.label}`}
              direction={{ xs: "column", sm: "row" }}
              alignItems={{ sm: "center" }}
              gap={{ xs: 0.6, sm: 2 }}
              sx={{
                px: { xs: 1.8, md: 2.2 },
                py: 1.5,
                borderRadius: `${layout.radiusSm}px`,
                border: `1px solid ${colors.edge}`,
                backgroundColor: alpha(colors.hull, 0.55),
              }}
            >
              <Mono sx={{ width: 26, flexShrink: 0, color: colors.ion }}>{row.stage}</Mono>

              <Typography sx={{ width: { sm: 118 }, flexShrink: 0, fontSize: 13.5, fontWeight: 600 }}>
                {row.label}
              </Typography>

              {/* The bar is the point of this list: the taper from 30 to 13 is
                * what the cascade *is*, and a column of numbers alone does not
                * show it. Width is proportional to the widest stage. */}
              <Box sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 1.6 }}>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 60,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: alpha(colors.edgeHi, 0.35),
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      width: `${(row.count / MAX_CASCADE) * 100}%`,
                      height: "100%",
                      borderRadius: 3,
                      // The final row is the output, not another filter step.
                      backgroundImage:
                        index === CASCADE.length - 1 ? gradients.action : "none",
                      backgroundColor:
                        index === CASCADE.length - 1 ? undefined : alpha(colors.ion, 0.42),
                    }}
                  />
                </Box>
                <Mono
                  sx={{
                    width: 28,
                    textAlign: "right",
                    fontSize: 13,
                    color: colors.text1,
                    letterSpacing: 0,
                  }}
                >
                  {row.count}
                </Mono>
              </Box>

              <Typography
                sx={{
                  width: { md: 290 },
                  flexShrink: 0,
                  fontSize: 12.5,
                  color: colors.text3,
                  display: { xs: "none", md: "block" },
                }}
              >
                {row.note}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Section>

      {/* ── capabilities ──────────────────────────────────────────────────── */}
      <Section eyebrow="Platform">
        <SectionHead
          title="Built so the answer survives being questioned."
          body="Four decisions that separate a confirmed incident from a search hit."
        />

        <Box
          sx={{
            mt: 5,
            display: "grid",
            gap: `${layout.gap}px`,
            gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          }}
        >
          {CAPABILITIES.map((item) => {
            const Icon = item.icon;
            return (
              <Stack
                key={item.title}
                gap={1.6}
                sx={{
                  p: { xs: 2.4, md: 3 },
                  borderRadius: `${layout.radius}px`,
                  border: `1px solid ${colors.edge}`,
                  backgroundImage: gradients.panel,
                  boxShadow: shadows.panel,
                }}
              >
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: `${layout.radiusSm}px`,
                    display: "grid",
                    placeItems: "center",
                    border: `1px solid ${colors.edgeHi}`,
                    backgroundColor: alpha(colors.ion, 0.09),
                  }}
                >
                  <Icon size={17} color={colors.ion} />
                </Box>
                <Typography variant="h3" sx={{ fontSize: 16.5 }}>
                  {item.title}
                </Typography>
                <Typography sx={{ fontSize: 13.5, lineHeight: 1.65, color: colors.text2 }}>
                  {item.body}
                </Typography>
              </Stack>
            );
          })}
        </Box>
      </Section>

      {/* ── evidence ──────────────────────────────────────────────────────── */}
      <Section id="evidence" eyebrow="The receipt">
        <Box
          sx={{
            display: "grid",
            gap: { xs: 4, md: 6 },
            gridTemplateColumns: { xs: "1fr", md: "0.95fr 1.05fr" },
            alignItems: "center",
          }}
        >
          <Box>
            <Typography
              variant="h2"
              sx={{ fontSize: "clamp(24px, 3vw, 36px)", letterSpacing: "-0.025em", lineHeight: 1.16 }}
            >
              &ldquo;Is this actually us?&rdquo; should take one second to answer.
            </Typography>
            <Typography sx={{ mt: 2.4, fontSize: 14.5, lineHeight: 1.7, color: colors.text2 }}>
              A claim only becomes a confirmed incident when a grounded leak claim
              connects to your organization through an accepted{" "}
              <Code>ALLEGEDLY_AFFECTS</Code> edge — resolved against your configured
              name, aliases and exact domains. If nothing resolves to you, the page
              never reaches leak typing, the graph, or your inbox.
            </Typography>
            <Typography sx={{ mt: 2, fontSize: 14.5, lineHeight: 1.7, color: colors.text2 }}>
              The console shows you that edge and the span it rests on, side by side.
            </Typography>
          </Box>

          <Box
            sx={{
              borderRadius: `${layout.radius}px`,
              border: `1px solid ${colors.edge}`,
              backgroundImage: gradients.panel,
              boxShadow: shadows.raised,
              overflow: "hidden",
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              gap={1}
              sx={{ px: 2.2, py: 1.3, borderBottom: `1px solid ${colors.edge}` }}
            >
              <ShieldCheck size={13} color={colors.verified} />
              <Mono sx={{ color: colors.verified }}>Grounded verbatim</Mono>
            </Stack>

            {/* Verified green is reserved for grounded-verbatim in the product,
              * so it is the one thing on this page allowed to wear it.
              *
              * This span is real. It is MASKED_EVIDENCE_TEXT from the highest
              * triage-priority row of VW_INCIDENT_CLAIMS, with the scores from
              * its VW_INCIDENTS parent, copied verbatim. An earlier draft used
              * prose I had written to look like an extraction, which is exactly
              * the thing this page accuses everyone else of — a page arguing
              * "we show you the actual line" cannot show an invented one under
              * a grounded-verbatim label. */}
            <Box sx={{ p: { xs: 2.2, md: 2.8 } }}>
              <Box
                sx={{
                  pl: 2,
                  borderLeft: `2px solid ${colors.verified}`,
                  fontFamily: fonts.mono,
                  fontSize: 12.5,
                  lineHeight: 1.85,
                  color: colors.text1,
                }}
              >
                Almost 21M records containing Full Names, Physical addresses, email
                addresses, phone numbers, and plaintext passwords, IBAN, passport
                numbers, driver license numbers and other internal corporate data
                have been compromised.
              </Box>

              <Stack gap={1.1} sx={{ mt: 2.6 }}>
                <Row label="Resolved to" value="Odido (odido.nl)" />
                <Row label="Edge" value="ALLEGEDLY_AFFECTS · accepted" />
                <Row label="Grounding" value="exact · corroborated" tone={colors.verified} />
                <Row label="Impact" value="95 · critical" tone={colors.critical} />
                <Row label="Confidence" value="98 · very high" tone={colors.verified} />
                <Row label="Triage priority" value="96 · critical" tone={colors.critical} />
              </Stack>

              {/* The product's own semantics: "corroborated" means the claim was
                * seen across independent sources, not that it is true. Saying so
                * costs one line and stops the panel reading as an endorsement of
                * the seller's numbers. */}
              <Typography sx={{ mt: 2.4, fontSize: 11.5, lineHeight: 1.6, color: colors.text3 }}>
                A seller&rsquo;s claim, quoted as found and corroborated across sources —
                not a verified record count.
              </Typography>
            </Box>
          </Box>
        </Box>
      </Section>

      {/* ── knowledge graph ───────────────────────────────────────────────── */}
      <Section id="graph" eyebrow="Knowledge graph">
        <SectionHead
          title="Six edges, and only one of them makes it yours."
          body={
            <>
              Extracted entities become nodes; resolved relationships become edges. A
              claim is promoted into the graph only when it is accepted, grounded, and
              connected to a monitored target — which is also what makes the graph
              worth querying rather than just worth looking at.
            </>
          }
        />

        <Box sx={{ mt: 5 }}>
          <GraphDemo />
        </Box>

        <Box
          sx={{
            mt: `${layout.gap}px`,
            display: "grid",
            gap: `${layout.gap}px`,
            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(3, 1fr)" },
          }}
        >
          {EDGES.map((item) => (
            <Stack
              key={item.edge}
              gap={0.9}
              sx={{
                p: 2.2,
                borderRadius: `${layout.radiusSm}px`,
                border: `1px solid ${colors.edge}`,
                backgroundColor: alpha(colors.hull, 0.55),
              }}
            >
              <Mono
                sx={{
                  color: item.edge === "ALLEGEDLY_AFFECTS" ? colors.ion : colors.text2,
                  fontSize: 11,
                }}
              >
                {item.edge}
              </Mono>
              <Typography sx={{ fontSize: 13, lineHeight: 1.55, color: colors.text2 }}>
                {item.meaning}
              </Typography>
            </Stack>
          ))}
        </Box>

        <Stack
          direction={{ xs: "column", sm: "row" }}
          gap={{ xs: 2, sm: 4 }}
          sx={{
            mt: 3,
            p: { xs: 2.4, md: 3 },
            borderRadius: `${layout.radius}px`,
            border: `1px solid ${colors.edge}`,
            backgroundImage: gradients.panel,
          }}
        >
          <Stack gap={1} sx={{ flex: 1 }}>
            <Typography variant="h4">Impact</Typography>
            <Mono sx={{ color: colors.text3, fontSize: 11, lineHeight: 1.8 }}>
              0.60 data_sensitivity
              <br />
              0.25 exposure_actionability
              <br />
              0.15 claimed_scale
            </Mono>
          </Stack>
          <Stack gap={1} sx={{ flex: 1 }}>
            <Typography variant="h4">Confidence</Typography>
            <Mono sx={{ color: colors.text3, fontSize: 11, lineHeight: 1.8 }}>
              0.35 ownership_evidence
              <br />
              0.25 evidence_grounding
              <br />
              0.20 claim_proof
              <br />
              0.15 content_corroboration
              <br />
              0.05 actor_credibility
            </Mono>
          </Stack>
          <Stack gap={1} sx={{ flex: 1 }}>
            <Typography variant="h4">Triage priority</Typography>
            <Mono sx={{ color: colors.text3, fontSize: 11, lineHeight: 1.8 }}>
              0.80 impact
              <br />
              0.20 confidence
            </Mono>
            <Typography sx={{ fontSize: 12, color: colors.text3, mt: 0.5 }}>
              Banded informational · low · medium · high · critical.
            </Typography>
          </Stack>
        </Stack>
      </Section>

      {/* ── architecture ──────────────────────────────────────────────────── */}
      <Section id="architecture" eyebrow="Architecture">
        <SectionHead
          title="One boundary, held from the crawler to the console."
          body="Paths, hashes, cache keys, graph keys and every serving view are scoped by ORG_ID. Multi-tenant is a property of the schema, not a filter applied at the end."
        />

        <Stack gap={0} sx={{ mt: 5 }}>
          {ARCHITECTURE.map((item, index) => (
            <Stack
              key={item.step}
              direction={{ xs: "column", sm: "row" }}
              gap={{ xs: 0.8, sm: 3 }}
              sx={{
                py: 2.4,
                borderTop: index === 0 ? `1px solid ${colors.edge}` : "none",
                borderBottom: `1px solid ${colors.edge}`,
              }}
            >
              <Stack direction="row" alignItems="center" gap={1.4} sx={{ width: { sm: 190 }, flexShrink: 0 }}>
                <Mono sx={{ color: colors.text3 }}>{String(index + 1).padStart(2, "0")}</Mono>
                <Typography variant="h4" sx={{ fontSize: 15 }}>
                  {item.step}
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 13.5, lineHeight: 1.7, color: colors.text2 }}>
                {item.body}
              </Typography>
            </Stack>
          ))}
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          gap={1.4}
          sx={{ mt: 3, color: colors.text3 }}
        >
          <Workflow size={14} />
          <Typography sx={{ fontSize: 12.5 }}>
            AI stages have no polling schedule. Each waits on its own stream and runs
            only when there is new material — a waiting task holds no warehouse.
          </Typography>
        </Stack>
      </Section>

      {/* ── closing ───────────────────────────────────────────────────────── */}
      <Section>
        <Stack
          alignItems="center"
          gap={2.6}
          sx={{
            textAlign: "center",
            px: { xs: 3, md: 6 },
            py: { xs: 6, md: 8 },
            borderRadius: `${layout.radius}px`,
            border: `1px solid ${colors.edgeHi}`,
            backgroundImage: [
              `radial-gradient(600px 300px at 50% 0%, ${alpha(colors.ion, 0.14)}, transparent 70%)`,
              gradients.panel,
            ].join(","),
            boxShadow: shadows.raised,
          }}
        >
          <Boxes size={26} color={colors.ion} />
          <Typography
            variant="h2"
            sx={{ fontSize: "clamp(22px, 3vw, 32px)", letterSpacing: "-0.025em", maxWidth: "22ch" }}
          >
            See what the dark web is already saying about you.
          </Typography>
          <Typography sx={{ fontSize: 14, color: colors.text2, maxWidth: "52ch", lineHeight: 1.7 }}>
            Sign in with your organization identifier to open the console.
          </Typography>
          <HeroActions secondary={false} align="center" />
        </Stack>
      </Section>

      {/* ── footer ────────────────────────────────────────────────────────── */}
      <Box component="footer" sx={{ borderTop: `1px solid ${colors.edge}`, mt: { xs: 4, md: 6 } }}>
        <Shell sx={{ py: 3.5 }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ sm: "center" }}
            gap={1.5}
          >
            <Stack direction="row" alignItems="center" gap={1.1}>
              <Box component="img" src="/nocturne-mark.png" alt="" width={18} height={18} />
              <Typography sx={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.06em" }}>
                NOCTURNE
              </Typography>
            </Stack>
            <Mono sx={{ color: colors.text3, ml: { sm: "auto" } }}>
              Dark-web breach intelligence · Snowflake Cortex
            </Mono>
            <Typography
              component={NextLink}
              href="/login"
              sx={{
                fontSize: 12.5,
                color: colors.text2,
                textDecoration: "none",
                "&:hover": { color: colors.ion },
              }}
            >
              Sign in
            </Typography>
          </Stack>
        </Shell>
      </Box>
    </Box>
  );
}

/* ── building blocks ──────────────────────────────────────────────────────── */

/** Shared max-width and gutter. Every section sits on this one measure. */
function Shell({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: React.ComponentProps<typeof Box>["sx"];
}) {
  return (
    <Box sx={{ maxWidth: 1480, mx: "auto", px: { xs: 2.5, md: 5 }, ...sx }}>{children}</Box>
  );
}

function Section({
  id,
  eyebrow,
  children,
}: {
  id?: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      id={id}
      // Anchor links land under a sticky bar unless the target is offset.
      sx={{ scrollMarginTop: 80 }}
    >
      <Shell sx={{ py: { xs: 7, md: 11 } }}>
        {eyebrow && <Mono sx={{ color: colors.ion, mb: 2.2 }}>{eyebrow}</Mono>}
        {children}
      </Shell>
    </Box>
  );
}

function SectionHead({ title, body }: { title: string; body: ReactNode }) {
  return (
    <Box sx={{ maxWidth: "62ch" }}>
      <Typography
        variant="h2"
        sx={{ fontSize: "clamp(24px, 3.2vw, 38px)", letterSpacing: "-0.026em", lineHeight: 1.15 }}
      >
        {title}
      </Typography>
      <Typography sx={{ mt: 2.2, fontSize: 14.5, lineHeight: 1.7, color: colors.text2 }}>
        {body}
      </Typography>
    </Box>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Stack
      gap={0.8}
      sx={{ px: { xs: 2, md: 2.8 }, py: { xs: 2.4, md: 3 } }}
    >
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: "clamp(20px, 2.4vw, 30px)",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: colors.text1,
        }}
      >
        {value}
      </Typography>
      <Mono sx={{ color: colors.text3 }}>{label}</Mono>
    </Stack>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Stack direction="row" alignItems="baseline" gap={2}>
      <Mono sx={{ width: 118, flexShrink: 0, color: colors.text3 }}>{label}</Mono>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 12.5,
          color: tone ?? colors.text1,
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

/** The console's uppercase mono label, at landing-page scale. */
function Mono({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: React.ComponentProps<typeof Typography>["sx"];
}) {
  return (
    <Typography
      sx={{
        fontFamily: fonts.mono,
        fontSize: 10.5,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        lineHeight: 1.6,
        ...sx,
      }}
    >
      {children}
    </Typography>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <Box
      component="code"
      sx={{
        fontFamily: fonts.mono,
        fontSize: "0.88em",
        px: 0.7,
        py: 0.2,
        borderRadius: "4px",
        border: `1px solid ${colors.edge}`,
        backgroundColor: alpha(colors.ion, 0.08),
        color: colors.text1,
      }}
    >
      {children}
    </Box>
  );
}
