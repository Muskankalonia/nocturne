# Nocturne Console

Analyst front end for the Nocturne dark-web breach-intelligence pipeline.

Next.js 15 (App Router) · MUI v6 · TypeScript. Self-contained in this directory —
it does not modify the Python crawler or the Snowflake SQL.

```bash
npm install
npm run dev          # http://localhost:3000
```

## Sign in

Demo scheme: **username is the organization, password is the same string**.

| Username | Password | Lands on |
| --- | --- | --- |
| `palo_alto_networks` | `palo_alto_networks` | `/` scoped to Palo Alto Networks |
| `att` | `att` | `/` scoped to AT&T |
| `admin` | `admin` | `/admin/fleet`, all tenants |

`northwind_traders` exists but is disabled, so it demonstrates the
monitoring-paused rejection path.

> **This is a demo credential scheme and must not ship.** Separately and more
> importantly: the hidden Fleet menu and the locked org badge are conveniences,
> not access controls. Tenant isolation has to be enforced server-side on the
> session — see "Data" below.

## Where data comes from

Today: static mocks in `src/mocks/`, derived from the real pipeline output in
`../examples/end-to-end-test/snowflake_metadata_report.txt`. The first incident
reproduces it exactly — impact 96, confidence 86, triage 94 — and its score
vector satisfies the weights in `../snowflake/13_dt_l4_severity.sql`, so the
Incident Detail radar agrees with its own headline numbers.

Three modes, in the order we intend to adopt them:

| Mode | How | Read cost |
| --- | --- | --- |
| **A** static mocks | `src/mocks/*` imported at build time | none |
| **B** live query | route handler → `snowflake-sdk` → the views, per request | ⚠️ warehouse-seconds on every page load |
| **C** snapshot export ✅ | a job writes JSON snapshots; route handlers serve those | none |

Mode B has a trap: Snowflake bills by warehouse-second and `COMPUTE_WH` cold
starts. A reviewer clicking around a live-query dashboard costs money and waits
on spinners. Mode C decouples read cost from query cost and cannot be broken by
an expired token mid-demo.

Whichever mode, **the route handler is where tenant isolation lives.** The
contract:

- `ORG_USER` → scope forced to their own `orgId`, ignoring any client input
- `SUPER_ADMIN` → may pass an `orgId` to narrow, or omit it for fleet scope

If an API route ever accepts an `orgId` from a request body or query string and
trusts it, any tenant can read any other tenant's breaches.

## Layout

```
src/
├── app/
│   ├── layout.tsx              root: providers only
│   ├── providers.tsx           emotion cache + theme + auth
│   ├── login/page.tsx
│   └── (dashboard)/            everything behind the auth gate
│       ├── layout.tsx          → AppShell
│       ├── page.tsx            Command Center (org + fleet variants)
│       ├── leaks|graph|actors|pipeline|settings/
│       └── admin/              fleet, organizations, users
├── components/
│   ├── layout/                 AppShell · Sidebar · Header
│   └── ui/                     Panel · SeverityChip · Cascade · ComingSoon
├── config/navigation.ts        one tree, filtered by role
├── contexts/AuthContext.tsx    session, scope, login/logout
├── mocks/                      organizations · incidents · pipeline
├── theme/                      tokens.ts (palette) + index.ts (MUI theme)
└── types/                      the whole data model
```

## Design rules

Two rules govern colour, and breaking either makes it look like a game menu
instead of an instrument:

1. **Cyan means interactive or selected.** Nothing else.
2. **Green means grounded / verified verbatim.** Nothing else.

Severity is never colour alone — always a stripe *plus* a labelled chip *plus* a
number, so it survives greyscale, colour-blind viewing, and a screenshot pasted
into a ticket.

Every hash, score, IP, offset and timestamp is monospace. That single choice
does more for the "operations console" feel than any amount of glow.

Dark only, deliberately. A light variant would be an omission dressed up as a
feature.

## User-facing language

The UI never says "L0" or "target_confirmed". Plain English is primary; the
engineering token survives as a small muted tag so analysts keep the mapping.

| Internal | Shown |
| --- | --- |
| L0 indicators | Screened for signals |
| L1 relationship AI | Checked for relevance |
| L2 extraction AI | Evidence extracted |
| `target_confirmed` | Confirmed yours |
| `ambiguous` | Needs review |
| `other_organization_confirmed` | Another company |
| `exact` / `normalized` | Verified quote / Verified · reformatted |
| `unmatched` | Unverified — quarantined |

## Status

All 13 routes are built.

**Org user** — `/login`, `/` Command Center, `/leaks` Breach Monitor (AG Grid),
`/leaks/[incidentKey]` Incident Detail (score radar, verbatim evidence with
offsets, AI narrative, provenance), `/graph` Knowledge Graph (G6, interactive),
`/actors` Threat Actors, `/pipeline`, `/settings` Monitored Assets.

**Super admin** — the same pages with fleet aggregation and an Organization
column, plus `/admin/fleet`, `/admin/fleet/actors`, `/admin/fleet/cost`,
`/admin/organizations`, `/admin/users`.

Verified: `tsc --noEmit` clean · `next build` 15/15 routes · every route returns
200 with no server errors.

Not built, because the data does not exist: precision/recall, calibration, and
the geographic map. Those need the labelled gold set that was never created —
`/pipeline` says so on the page rather than showing a fabricated number.

Cross-tenant actor correlation is illustrative and labelled as such: it needs
one additive pipeline column. See `docs/global-node-key.md`.
