# Nocturne Console — production readiness

What stands between the current build and something a paying tenant could sign in to,
plus what has to hold up on stage.

Status as of **2 Aug 2026**, commit `772e187`. Everything marked *verified* was
observed on a running instance against live Snowflake, not inferred from reading
code.

---

## 0. How much actually works today

| | |
|---|---|
| Live Snowflake pages | 3 of 12 — Command Center, Breach Monitor, Incident Detail |
| Pages still rendering `src/mocks/*` | 9 |
| Write operations that persist | **0** |
| Committed automated coverage | 20 browser assertions (`npm run test:click`), 18 passing |
| Typecheck | clean (`npm run typecheck`) |
| Production dependency vulnerabilities | 4 — 1 moderate, 3 high |

The read path is real and the tenant isolation design is sound. Everything that
*changes* state is currently local React state that disappears on reload.

### Resolved since the first draft

- **`snowflake.log` purged from git history** and force-pushed. The blob is
  unreachable from every ref including `origin/main` — *verified*. Two caveats
  below in §1.6.
- **Discovery replay shipped** — the graph timeline scrubber on `/graph`.
- **Loading states are skeletons**, not spinners, across all five loading paths.
- **Checkbox column filters** on every grid, built on AG Grid Community's
  custom-filter API rather than an Enterprise licence (§8).

---

## 1. Blockers — do not put a real user in front of this

### 1.1 Authentication is a demo scheme
`username === password`, against a hardcoded array in
[`src/mocks/organizations.ts`](src/mocks/organizations.ts). No hashing, no MFA, no
lockout, no reset, no expiry. Replace with a real identity provider (OIDC or SAML)
before anyone outside the team signs in.

### 1.2 The tenant directory ships to the browser
`organizations` and `users` are imported by **client** components
([`AuthContext.tsx`](src/contexts/AuthContext.tsx),
[`Header.tsx`](src/components/layout/Header.tsx),
[`GlobalSearch.tsx`](src/components/layout/GlobalSearch.tsx)). Every tenant's name,
domains and analyst list is in the JavaScript bundle served to every other tenant.
This must move behind a server-only lookup keyed off the session.

### 1.3 Sessions cannot be revoked
[`session.ts`](src/server/session.ts) issues a stateless HMAC token with an 8-hour
TTL. Signing someone out clears their cookie but the token stays valid until it
expires — a copied cookie keeps working. Needs either a server-side session store
or a short TTL plus refresh.

### 1.4 Snowflake access is a shared `ACCOUNTADMIN` token
One programmatic access token, `ACCOUNTADMIN`, shared by the whole team. The
dashboard only ever runs `SELECT` against `NOCTURNE.DASHBOARD.*`, so it should have
a dedicated role with exactly that grant and nothing else.

**The current token expires 2026-08-07** — one day after the hackathon deadline.
If the demo slips, the dashboard goes dark.

### 1.5 Credentials have been circulated in plaintext — rotate them
The account identifier, username and programmatic access token were shared in chat
and written to a scratch file in the repository working tree. They now also sit in
`.env.local`, which is gitignored but unencrypted on disk. Treat the current token
as compromised and rotate it before any deployment. Secrets belong in a managed
store (Secret Manager, Vault, or the host's env config).

### 1.6 `snowflake.log` — purged, but the exposure already happened
The file recorded the account identifier, signed-in user, role and warehouse on
every connection. It has been removed from history and force-pushed; no ref reaches
the blob any more. Two things remain:

- **Every teammate must `git fetch --prune` and hard-reset `main`.** Anyone who
  merges instead of resetting drags the old commits — and the log — back in.
- **Rewriting history does not undo disclosure.** GitHub may retain unreferenced
  objects, and anyone who cloned before the rewrite still has it. This is a reason
  to rotate (§1.5), not a substitute for it.

---

## 2. Functional gaps

### 2.1 Nothing can be written back
Three controls look functional and are not:

| Control | Where | Current behaviour |
|---|---|---|
| Monitoring enable/disable | `/admin/organizations` | Local `useState` + toast. Resets on reload. |
| Save Changes | `/settings` | Button enables on edit, then does nothing. |
| Remediation status | `/leaks`, incident detail | Read-only. No way to mark triaged or resolved. |

Each needs a mutable Snowflake table (the `DASHBOARD` schema is views only, which
cannot be written) plus a `POST`/`PATCH` route with the same session checks the read
routes already perform. Estimate: half a day for all three together.

### 2.2 Needs-review rows are a dead end — *verified*
`VW_BREACH_MONITOR` returns `DETAIL_AVAILABLE = false` for `needs_review` and
`another_company` rows, because `VW_INCIDENTS` only contains confirmed incidents.
The grid's row click is gated on that flag, so those rows do nothing.

This is the one open regression against previously working behaviour: the
"why wasn't this confirmed" explanation page is unreachable on live data. It needs
either a document-level detail view or an inline expansion in the grid. The two
failing assertions in `npm run test:click` are reporting exactly this.

### 2.3 Nine pages are still fixtures
`/graph`, `/actors`, `/pipeline`, `/settings`, `/admin/organizations`,
`/admin/users`, `/admin/fleet`, `/admin/fleet/actors`, `/admin/fleet/cost`.

Two are nearly free — the data is already in a response the app fetches:

- **`/pipeline`** — `CommandCenterResponse.cascade` is already returned and ignored.
- **`/admin/fleet`** — fleet scope already returns the full per-org
  `organizations[]` array with metrics.

`/admin/fleet/cost` has no backing data anywhere. Either instrument warehouse and
Cortex spend properly or cut the page; do not ship invented numbers.

### 2.4 Cross-tenant actor correlation is blocked
`NODE_KEY` includes `ORG_ID`, so the same alias hashes differently per tenant and
cannot be joined. `/admin/fleet/actors` — the strongest story in the product — has
no real data behind it. The additive fix is written up in
[`docs/global-node-key.md`](docs/global-node-key.md) and repeats zero Cortex calls,
but it is a pipeline migration and needs re-verification budget.

### 2.5 The discovery replay has one stop on live data — *verified*
The Discovery Scrubber on `/graph` works and the demo fixture has a seven-step
timeline. Live Snowflake returns a **single distinct `FIRST_SEEN`** for every node
and edge, because the warehouse has only been crawled once. The control detects
this and says so rather than pretending. Nothing to fix in the UI — it needs the
crawler on a schedule.

---

## 3. Performance and cost

### 3.1 Cold fleet load is ~9 seconds — *verified*
Measured on `/leaks` at fleet scope: `networkidle` at 0.8s, first grid row at 9.0s.
Warm, the same query returns in ~1s. Skeletons now cover the wait so the layout is
stable and the page reads as loading rather than broken — but nine seconds is still
nine seconds. The fix is caching (§3.3), not more placeholder polish.

### 3.2 Fleet queries are unbounded
`getCommandCenter` at fleet scope runs `SELECT … FROM VW_INCIDENTS` with **no
`LIMIT` and no pagination**, then filters in Node and serialises the whole thing to
the browser. Fine at 3 incidents; not fine at 30,000. Needs server-side pagination
and a bounded default window.

### 3.3 Every page view costs warehouse seconds
All four routes set `Cache-Control: no-store`, so cost scales with page views
rather than with data volume. The underlying tables are deterministic with a
~5-minute freshness target, so a short server-side cache keyed on `(scope, route)`
would cut warehouse spend by an order of magnitude with no correctness loss.

### 3.4 Nothing bounds Snowflake spend
There is no resource monitor, no warehouse auto-suspend policy documented, and no
budget alert. A loop in a client — or one enthusiastic demo audience — bills
straight to the account. Snowflake provides resource monitors with suspend
thresholds; configure one before this is reachable by anyone outside the team.

### 3.5 Smaller items
- `loadConfig()` re-reads and re-validates the environment on **every** query
  ([`nocturne-backend.ts`](src/server/nocturne-backend.ts)).
- One shared connection with no pool; a slow query blocks the rest.
- No server-side query cancellation when a user navigates away mid-fetch.

---

## 4. Operations

Nothing in this section exists yet.

- **No error tracking.** Failures go to `console.error` and vanish.
- **No structured logging or request IDs.** A tenant reporting "it was slow at 3pm"
  cannot be investigated.
- **No health check endpoint** for a load balancer to probe.
- **No CI for the dashboard.** `.github/workflows/deploy-pipeline.yml` covers the
  Snowflake pipeline only. `typecheck`, `lint` and `test:click` all exist and none
  run automatically.
- **No rate limiting** on any API route.
- **No audit log.** This product displays breach intelligence about named companies;
  who viewed which tenant's incidents, and when, needs recording for compliance.
- **No SLOs and no on-call.** No target for availability or query latency, so there
  is nothing to alert against.

---

## 5. Correctness of what is displayed

- **Grounding is enforced in SQL, not in the UI** — the right place, but the
  dashboard should surface the quarantined count prominently rather than only the
  grounding rate, so a reviewer can see what was rejected.
- **`MASKED_EVIDENCE_TEXT` masking needs an independent review.** The claim is that
  L2 only ever saw `EVIDENCE_INPUT` with indicators already replaced. That property
  is the difference between showing evidence and leaking someone's credentials, and
  it should be tested explicitly, not assumed.
- **No data retention or deletion policy.** Breach records about third-party
  companies are being stored indefinitely.

---

## 6. Accessibility and UX

- **No conformance target.** Pick one — WCAG 2.2 AA is the normal enterprise
  procurement bar — and test against it, rather than fixing issues ad hoc.
- The knowledge graph is canvas-only: no keyboard navigation, no screen-reader
  alternative, no text fallback for the relationships it shows.
- No empty states. A tenant with zero incidents sees an empty grid, not an
  explanation.
- No responsive/mobile pass. The layouts assume a wide desktop; several panels use
  fixed viewport-height math that has not been checked below ~1000px tall.
- No browser support matrix. Nothing has been tested outside Chromium.
- **Dev-mode collision:** the Next.js dev indicator sits over the bottom-left of the
  collapsed sidebar and intercepts clicks on the sign-out button. It does not exist
  in a production build, but it makes manual testing in dev misleading.

---

## 7. Testing

`npm run test:click` is the only suite **in the repository** — 20 assertions,
18 passing, the 2 failures being §2.2.

Three further suites were written during development and verified real behaviour —
layout/filters/sidebar (12), graph and pipeline tabs (12), skeleton loading (9) —
but they live outside the repo and will be lost. Either commit them under
`scripts/` or accept that 33 verified assertions disappear.

Also missing:

- **No unit tests at all.** The scoring band helpers, `graph-timeline.ts` and the
  session token verifier are pure functions with obvious edge cases.
- **No API contract tests.** A change to a `DASHBOARD` view's column list breaks the
  mappers in `nocturne-backend.ts` silently at runtime.
- **No load test.** The 9-second cold query has never been run concurrently.
- **Tests depend on live Snowflake.** There is no fixture mode, so CI cannot run the
  browser suite without credentials and warehouse spend.

---

## 8. Dependencies, licensing and supply chain

**Vulnerabilities — 4 in production dependencies (1 moderate, 3 high):**

| Package | Severity | Note |
|---|---|---|
| `sharp` (via `next`) | high | libvips CVEs, **no fix available** |
| `postcss` (via `next`) | moderate | resolved by a Next upgrade |

**Version currency:** seven packages are a major version behind, including
`next` 15 → 16, `@mui/material` 6 → 9, and `ag-grid` 32 → 36. The MUI jump in
particular is not a drop-in.

**Licensing is currently clean and should stay that way.** AG Grid Community, G6 and
MUI are MIT; `snowflake-sdk` is Apache-2.0. The checkbox column filter was written
against Community's custom-filter API specifically to avoid AG Grid Enterprise —
do not "fix" it by adding an Enterprise trial key, which is both a licence
obligation and a watermark on every grid.

**Missing:** no `engines` field pinning a Node version, no lockfile audit in CI, no
dependency update policy.

---

## 9. Environments and deployment

- **No deployment target chosen.** The Snowflake driver requires the Node runtime,
  so API routes cannot run on an edge runtime — that rules out several defaults.
- **No environment separation.** One Snowflake account, one set of credentials, no
  dev/staging/production split. A demo and a customer would share a warehouse.
- **The production build passes** — *verified*, compiles in ~3s, all 12 pages
  prerender and the 4 API routes are correctly marked server-rendered. Worth
  keeping honest: every AG Grid page carries a ~390 kB first load (`/leaks` 396 kB,
  `/admin/organizations` 399 kB) against ~145 kB elsewhere. That is the grid
  bundle, and it is the obvious lever if first paint ever matters.
- **No rollback plan.** `deploy_pipeline.py` applies steps 02–16 forward. There is
  no documented way to revert a bad `DASHBOARD` view, and no note of the Snowflake
  Time Travel retention window that would make recovery possible.
- **No backup or DR position.** What happens if the account is lost is undefined.

---

## 10. Legal and data protection

These are not engineering tasks, but they gate a real deployment and no one has
written anything down.

- **Collection legality.** Crawling and retaining dark-web marketplace content has
  jurisdictional constraints. Get a position in writing before this leaves a demo.
- **Third-party company data.** The product stores and displays breach claims about
  named organizations that are not customers — `another_company` rows exist by
  design. Publishing an unverified claim about a company is a defamation surface.
- **Personal data.** Evidence text is masked in SQL, but leak records concern real
  people's credentials. GDPR/DPDP obligations — lawful basis, retention, subject
  access and erasure — are unaddressed.
- **Tenant contract terms.** Who inside a customer may see which incidents, and what
  the retention commitment is, has no answer yet.

---

## 11. Demo readiness

What holds up in front of judges, and what to route around.

**Safe to show, live and real:** sign-in as `admin` and as a tenant, Command Center
including the posture flow, Breach Monitor with checkbox filters and CSV export, an
incident detail with its score decomposition and verbatim evidence, and the
knowledge graph with the spine layout and discovery replay.

**Mock-backed but presentable** — say so if asked: Pipeline, Threat Actors, Fleet
Command, Organizations, Users, Settings.

**Do not click during a demo:** any needs-review or other-company row (§2.2 — nothing
happens), Save Changes on Settings, or Fleet Cost.

**Rehearse the cold start.** The first fleet query takes ~9 seconds. Load the app
once before presenting so the warehouse is warm, or the opening move is a nine-second
skeleton.

**Have an offline answer ready.** If the network or Snowflake is unavailable the
three live pages show an error panel with Retry, and there is no fixture fallback.
A `NOCTURNE_DATA_SOURCE=mock` path would remove that risk entirely — roughly 250
lines mapping the existing mocks onto the backend's response types — and is the
single highest-value insurance policy before a live presentation.

---

## 12. Suggested order

1. Rotate the Snowflake token and move secrets out of local files. *(§1.4, §1.5)*
2. Have every teammate hard-reset `main` after the history rewrite. *(§1.6)*
3. Mock data-source fallback, so the demo cannot be taken down by a network. *(§11)*
4. Least-privilege Snowflake role plus a resource monitor. *(§1.4, §3.4)*
5. Server-side tenant directory; get `users`/`organizations` out of the bundle. *(§1.2)*
6. Real identity provider. *(§1.1, §1.3)*
7. Write path for remediation status — the most requested missing action. *(§2.1)*
8. Pagination and a short server cache. *(§3.2, §3.3)*
9. Needs-review detail view. *(§2.2)*
10. `/pipeline` and `/admin/fleet` off mocks — cheapest wins on the board. *(§2.3)*
11. Commit the three uncommitted test suites; add CI. *(§7, §4)*
12. Error tracking, health check, audit log. *(§4)*
13. `GLOBAL_NODE_KEY` migration. *(§2.4)*
14. Dependency upgrades, starting with Next. *(§8)*

Items 1–3 are what protect the presentation. Items 4–6 are prerequisites for
exposing this to anyone outside the team. Items 7–10 are what make it feel like a
product. The rest is what makes it maintainable.
