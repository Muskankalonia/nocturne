# Nocturne Console — readiness

Two documents in one: **what has to be ready for the hackathon** (§1), and what
stands between this and something a paying tenant could sign in to (§3 onward).

Status as of **5 Aug 2026**, commit `e548a13`. Submission is **6 Aug**. Everything
marked *verified* was observed on a running instance against live Snowflake, not
inferred from reading code.

---

## 0. Where the build actually is

| | |
|---|---|
| Live Snowflake pages | **4 of 12** — Command Center, Breach Monitor, Incident Detail, Monitored Assets |
| Pages still rendering `src/mocks/*` | 8 |
| Write operations that persist | **1 of 3** — Monitored Assets writes; the other two do not |
| Committed automated coverage | 20 browser assertions (`npm run test:click`), 18 passing |
| Typecheck | clean (`npm run typecheck`) |
| Production build | passes, ~3s, 12 pages prerendered |
| Production dependency vulnerabilities | 4 — 1 moderate, 3 high |

### What changed since the last revision

The team closed the **config loop**, which is the most important thing to happen to
this project since the backend landed.

- `NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS` is now writable from the UI through
  `PUT /api/monitored-organizations` — parameterised, session-scoped, with
  cross-tenant writes refused server-side (403, *verified*).
- `snowflake/03_target_configuration.sql` now grants `SELECT, UPDATE` on exactly
  that one table and nothing else.
- `scripts/org_crawl_config.py` bridges that row to the crawler's environment.

That means **an analyst adding a domain in Monitored Assets changes what gets
crawled, and flips pages from "Needs Review" to "Confirmed Breach."** That is a
complete story with a beginning and an end, and it is the strongest thing you can
put in front of a judge.

Also landed earlier: `snowflake.log` purged from history and force-pushed (blob
unreachable from every ref, *verified*), the graph discovery scrubber, skeleton
loading states, and checkbox column filters on every grid.

---

## 1. Before the hackathon

Ordered by what actually threatens the submission. Effort is a rough half-day unit.

### 1.1 Blocking — do these first

**Confirm the Snowflake token outlives the demo.** It expires **2026-08-07**. That
is one day after submission, with no margin. If judging slips, or anyone reviews the
project the following week, every live page goes dark. Issue a longer-lived token
now. *(~15 min)*

**Add a mock data-source fallback.** Right now, if the network drops or Snowflake is
unreachable mid-presentation, your four best pages show an error panel with a Retry
button and nothing behind it. A `NOCTURNE_DATA_SOURCE=mock` path — roughly 250 lines
mapping the existing mocks onto the backend's response types — removes that risk
entirely. This is the single highest-value insurance policy available. *(~half day)*

**Rehearse the cold start.** The first fleet query takes ~9 seconds (*verified*).
Load the app once before presenting so the warehouse is warm, or your opening move
is a nine-second skeleton.

### 1.2 Worth doing if there is time

**Fix the needs-review dead end** (§4.2). Clicking a "Needs review" or "Another
company" row does nothing — no detail, no explanation. A judge exploring the grid
will find this within a minute, and the two failing assertions in `test:click` are
reporting exactly it. Even an inline expansion would close it. *(~half day)*

**Make the admin organizations toggle real.** The write path now exists; that page
just is not wired to it. It is the same `PUT` the Settings page already calls.
*(~1 hour)*

**Take `/pipeline` and `/admin/fleet` off mocks.** Both already have their data in a
response the app fetches — `CommandCenterResponse.cascade` and the per-org
`organizations[]` array. Cheapest credibility win on the board. *(~half day each)*

### 1.3 Decide, do not build

- **`/admin/fleet/cost`** has no backing data anywhere. Either cut the page for the
  demo or label it clearly as a mock. Do not ship invented spend figures in front of
  judges.
- **`/admin/fleet/actors`** is the best story in the product and is blocked on
  `GLOBAL_NODE_KEY` (§4.4). It cannot be made real in a day. Present it as a
  designed-and-specified capability, with the migration written up.

### 1.4 Demo script

**Safe, live and real:** sign in as a tenant and as `admin`; Command Center with the
posture flow; Breach Monitor with checkbox filters and CSV export; an incident detail
with score decomposition and verbatim evidence; the knowledge graph with the spine
layout and discovery replay; **Monitored Assets — edit a domain and show it persist.**

**Mock-backed but presentable** — say so if asked: Pipeline, Threat Actors, Fleet
Command, Organizations, Users.

**Do not click:** any needs-review or other-company row, and Fleet Cost.

**Have an answer ready** for "how do you know the AI didn't make this up" — the
grounding story is your differentiator and it is genuinely implemented. Evidence text
is verified by offset in SQL; unmatched claims are quarantined and never reach a
score. Show the Evidence Quality tab.

---

## 2. New risks introduced by the config write

The write path is well built, but it changes the threat model and nothing in the
product accounts for that yet.

- **An org user can now change what gets crawled.** `PUT /api/monitored-organizations`
  lets an `ORG_USER` edit their own aliases, domains and products. Those feed L1
  ownership resolution and the crawler's search query, so a tenant can widen their
  own collection scope — and the warehouse and Cortex spend that comes with it.
  There is no approval step, no rate limit, and no per-tenant cost ceiling.
- **No audit trail on the change.** `UPDATED_AT` moves, but not *who* changed it or
  what the previous value was. For a control that alters collection behaviour, that
  is the first thing an auditor asks for.
- **No validation against reality.** Nothing stops a tenant adding `gmail.com` as a
  monitored domain and pulling in everyone else's leaks.
- **The grant still defaults to `ACCOUNTADMIN`.** The SQL now has a proper
  least-privilege block with a `NOCTURNE_DASHBOARD_ROLE` variable, but it is set to
  `ACCOUNTADMIN` with a comment saying to change it. Change it (§3.4).

---

## 3. Production blockers — do not put a real user in front of this

### 3.1 Authentication is a demo scheme
`username === password`, against a hardcoded array in
[`src/mocks/organizations.ts`](src/mocks/organizations.ts). No hashing, no MFA, no
lockout, no reset, no expiry. Replace with a real identity provider (OIDC or SAML).

### 3.2 The tenant directory ships to the browser
`organizations` and `users` are imported by **client** components
([`AuthContext.tsx`](src/contexts/AuthContext.tsx),
[`Header.tsx`](src/components/layout/Header.tsx),
[`GlobalSearch.tsx`](src/components/layout/GlobalSearch.tsx)). Every tenant's name,
domains and analyst list is in the JavaScript bundle served to every other tenant.
Move it behind a server-only lookup keyed off the session.

### 3.3 Sessions cannot be revoked
[`session.ts`](src/server/session.ts) issues a stateless HMAC token with an 8-hour
TTL. Signing out clears the cookie but the token stays valid — a copied cookie keeps
working. Needs a server-side session store, or a short TTL plus refresh.

### 3.4 Snowflake access is still `ACCOUNTADMIN`
One shared programmatic access token running as `ACCOUNTADMIN`. The console needs
`SELECT` on `NOCTURNE.DASHBOARD.*` and `SELECT, UPDATE` on one config table — the
grants are now written, they just point at the wrong role. Create the least-privileged
role and set `SNOWFLAKE_ROLE` to match.

### 3.5 Credentials have been circulated in plaintext — rotate them
The account identifier, username and token were shared in chat and written to a
scratch file in the working tree. They now also sit unencrypted in `.env.local`.
Treat the current token as compromised. Secrets belong in a managed store.

### 3.6 `snowflake.log` — purged, but the exposure already happened
Removed from history and force-pushed; no ref reaches the blob. Two things remain:
**every teammate must `git fetch --prune` and hard-reset `main`** — merging instead
drags the old commits back — and **rewriting history does not undo disclosure**.
Anyone who cloned before the rewrite still has it. That is a reason to rotate
(§3.5), not a substitute.

---

## 4. Functional gaps

### 4.1 Two of three write controls are still theatre

| Control | Where | State |
|---|---|---|
| Monitored Assets | `/settings` | **Real** — persists to Snowflake, *verified* |
| Monitoring enable/disable | `/admin/organizations` | Local `useState` + toast. Resets on reload. |
| Remediation status | `/leaks`, incident detail | Read-only. No way to mark triaged or resolved. |

The admin toggle can reuse the existing `PUT`. Remediation status needs a new table —
the `DASHBOARD` schema is views only, which cannot be written.

### 4.2 Needs-review rows are a dead end — *verified*
`VW_BREACH_MONITOR` returns `DETAIL_AVAILABLE = false` for `needs_review` and
`another_company` rows, because `VW_INCIDENTS` only contains confirmed incidents.
The grid's row click is gated on that flag, so those rows do nothing. Needs either a
document-level detail view or an inline expansion.

### 4.3 Eight pages are still fixtures
`/graph`, `/actors`, `/pipeline`, `/admin/organizations`, `/admin/users`,
`/admin/fleet`, `/admin/fleet/actors`, `/admin/fleet/cost`. See §1.2 for the two
that are nearly free.

### 4.4 Cross-tenant actor correlation is blocked
`NODE_KEY` includes `ORG_ID`, so the same alias hashes differently per tenant and
cannot be joined. The additive fix is in
[`docs/global-node-key.md`](docs/global-node-key.md) and repeats zero Cortex calls,
but it is a pipeline migration needing re-verification budget.

### 4.5 The discovery replay has one stop on live data — *verified*
Live Snowflake returns a **single distinct `FIRST_SEEN`** for every node and edge,
because the warehouse has been crawled once. The control detects this and says so.
Nothing to fix in the UI — it needs the crawler on a schedule.

---

## 5. Performance and cost

- **Cold fleet load is ~9 seconds** (*verified*; ~1s warm). Skeletons cover the wait,
  but the fix is caching, not more placeholder polish.
- **Fleet queries are unbounded.** `getCommandCenter` at fleet scope runs
  `SELECT … FROM VW_INCIDENTS` with no `LIMIT` and no pagination, filters in Node,
  and serialises everything to the browser. Fine at 3 incidents; not at 30,000.
- **Every page view costs warehouse seconds.** All routes set `Cache-Control:
  no-store`. The tables are deterministic with a ~5-minute freshness target, so a
  short server-side cache keyed on `(scope, route)` would cut spend by an order of
  magnitude with no correctness loss.
- **Nothing bounds Snowflake spend.** No resource monitor, no documented auto-suspend,
  no budget alert. Configure a resource monitor before this is reachable by anyone
  outside the team — and note §2 now lets tenants widen their own collection scope.
- `loadConfig()` re-reads and re-validates the environment on **every** query. One
  shared connection, no pool. No server-side query cancellation.

---

## 6. Operations

Nothing in this section exists yet.

- **No error tracking.** Failures go to `console.error` and vanish.
- **No structured logging or request IDs.** "It was slow at 3pm" is uninvestigable.
- **No health check endpoint.**
- **No CI for the dashboard.** `.github/workflows/deploy-pipeline.yml` covers the
  Snowflake pipeline only. `typecheck`, `lint` and `test:click` never run automatically.
- **No rate limiting** on any API route — now including a write route.
- **No audit log.** Who viewed which tenant's incidents, and who changed monitoring
  config, needs recording.
- **No SLOs, no on-call.**

---

## 7. Correctness of what is displayed

- **Grounding is enforced in SQL, not the UI** — the right place. The dashboard should
  surface the quarantined count as prominently as the grounding rate.
- **`MASKED_EVIDENCE_TEXT` masking needs an independent review.** The claim is that L2
  only ever saw `EVIDENCE_INPUT` with indicators already replaced. That property is
  the difference between showing evidence and leaking credentials; test it explicitly.
- **No data retention or deletion policy.**

---

## 8. Accessibility and UX

- **No conformance target.** Pick one — WCAG 2.2 AA is the enterprise procurement bar.
- The knowledge graph is canvas-only: no keyboard navigation, no screen-reader
  alternative, no text fallback.
- No empty states; a tenant with zero incidents sees an empty grid.
- No responsive pass. Layouts assume a wide desktop, and several panels use fixed
  viewport-height math unverified below ~1000px tall.
- No browser support matrix. Nothing tested outside Chromium.
- **Dev-mode collision:** the Next.js dev indicator covers the collapsed sidebar's
  sign-out button. Absent in production builds, but it makes manual dev testing
  misleading.

---

## 9. Testing

`npm run test:click` is the only suite **in the repository** — 20 assertions, 18
passing, the 2 failures being §4.2.

Suites written during development that verified real behaviour but live outside the
repo and are being lost: layout/filters/sidebar (12), graph and pipeline tabs (12),
skeleton loading (9), config write path (7). **40 verified assertions** that nobody
can re-run. Commit them under `scripts/` or accept the loss.

Also missing: no unit tests at all (the band helpers, `graph-timeline.ts` and the
session verifier are pure functions with obvious edge cases); no API contract tests
(a column rename in a `DASHBOARD` view breaks the mappers silently at runtime); no
load test; and no fixture mode, so CI cannot run the browser suite without
credentials and warehouse spend.

---

## 10. Dependencies, licensing and supply chain

**4 vulnerabilities in production dependencies (1 moderate, 3 high):** `sharp` via
`next` carries libvips CVEs with **no fix available**; `postcss` via `next` is
resolved by a Next upgrade.

**Version currency:** seven packages a major behind, including `next` 15 → 16,
`@mui/material` 6 → 9, `ag-grid` 32 → 36. The MUI jump is not a drop-in.

**Licensing is clean and should stay that way.** AG Grid Community, G6 and MUI are
MIT; `snowflake-sdk` is Apache-2.0. The checkbox filter was written against
Community's custom-filter API specifically to avoid AG Grid Enterprise — do not
"fix" it with an Enterprise trial key, which is both a licence obligation and a
watermark on every grid.

**Missing:** no `engines` field pinning Node, no lockfile audit in CI, no dependency
update policy.

---

## 11. Environments and deployment

- **No deployment target chosen.** The Snowflake driver requires the Node runtime, so
  API routes cannot run on an edge runtime — that rules out several defaults.
- **No environment separation.** One account, one credential set, no dev/staging/prod
  split. A demo and a customer would share a warehouse — and now a config table that
  the UI writes to.
- **The production build passes** — *verified*, ~3s, all 12 pages prerender, 5 API
  routes correctly server-rendered. Every AG Grid page carries a ~390 kB first load
  against ~145 kB elsewhere; that is the obvious lever if first paint ever matters.
- **No rollback plan.** `deploy_pipeline.py` applies steps 02–16 forward. No documented
  way to revert a bad `DASHBOARD` view, and no note of the Time Travel retention
  window that would make recovery possible.
- **No backup or DR position.**

---

## 12. Legal and data protection

Not engineering tasks, but they gate a real deployment and nothing is written down.

- **Collection legality.** Crawling and retaining dark-web marketplace content has
  jurisdictional constraints. Get a written position before this leaves a demo.
- **Third-party company data.** The product stores and displays breach claims about
  named organizations that are not customers — `another_company` rows exist by
  design. Publishing an unverified claim about a company is a defamation surface.
- **Personal data.** Evidence text is masked, but leak records concern real people's
  credentials. Lawful basis, retention, subject access and erasure are unaddressed.
- **Tenant contract terms.** Who inside a customer may see which incidents, what the
  retention commitment is, and now **who may change monitoring scope** (§2).

---

## 13. Order after the hackathon

1. Rotate the Snowflake token; move secrets to a managed store. *(§3.5)*
2. Every teammate hard-resets `main` after the history rewrite. *(§3.6)*
3. Least-privilege Snowflake role — the grants are written, point them at it. *(§3.4)*
4. Resource monitor and per-tenant collection-scope limits. *(§5, §2)*
5. Audit log on config changes and incident views. *(§2, §6)*
6. Server-side tenant directory; get `users`/`organizations` out of the bundle. *(§3.2)*
7. Real identity provider. *(§3.1, §3.3)*
8. Remaining write paths: admin toggle, remediation status. *(§4.1)*
9. Pagination and a short server cache. *(§5)*
10. Needs-review detail view. *(§4.2)*
11. Commit the four uncommitted test suites; add CI. *(§9, §6)*
12. Error tracking, health check. *(§6)*
13. `GLOBAL_NODE_KEY` migration. *(§4.4)*
14. Dependency upgrades, starting with Next. *(§10)*

Items 1–3 protect the account. Items 4–7 are prerequisites for exposing this to
anyone outside the team. Items 8–10 make it feel like a product. The rest makes it
maintainable.
