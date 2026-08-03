# Nocturne Console — production readiness

What stands between the current build and something a paying tenant could sign in to.

Status as of **2 Aug 2026**. Everything marked *verified* was observed on a running
instance against live Snowflake, not inferred from reading code.

---

## 0. How much actually works today

| | |
|---|---|
| Live Snowflake pages | 3 of 12 — Command Center, Breach Monitor, Incident Detail |
| Pages still rendering `src/mocks/*` | 9 |
| Write operations that persist | **0** |
| Automated coverage | 20 browser assertions (`npm run test:click`), 18 passing |
| Typecheck | clean (`npm run typecheck`) |

The read path is real and the tenant isolation design is sound. Everything that
*changes* state is currently local React state that disappears on reload.

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

### 1.5 Credentials have been circulated in plaintext — rotate them
The account identifier, username and programmatic access token have been shared in
chat and written to a scratch file in the repository working tree. Treat the current
token as compromised and rotate it before any deployment. Secrets belong in a
managed store (Secret Manager, Vault, or the host's env config), never in a file
inside the repo.

### 1.6 `snowflake.log` is in git history
It was tracked until this change and records the account identifier, signed-in user,
role, warehouse and OS on every connection. It is now gitignored and removed from
the index, but **it remains in history**. If this repository ever becomes public,
the history needs scrubbing.

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

This is the one open regression against a previously working behaviour: the
"why wasn't this confirmed" explanation page is unreachable on live data. It needs
either a document-level detail view or an inline expansion in the grid. This is
what the two failing assertions in `npm run test:click` are reporting.

### 2.3 Nine pages are still fixtures
`/graph`, `/actors`, `/pipeline`, `/settings`, `/admin/organizations`,
`/admin/users`, `/admin/fleet`, `/admin/fleet/actors`, `/admin/fleet/cost`.

Two of these are nearly free — the data is already in a response the app fetches:

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
The Discovery Scrubber on `/graph` works, and the demo fixture has a seven-step
timeline. Live Snowflake currently returns a **single distinct `FIRST_SEEN`** for
every node and edge, because the warehouse has only been crawled once. The control
detects this and says so rather than pretending, but the feature only becomes
meaningful after repeated crawls. Nothing to fix in the UI — it needs the crawler on
a schedule.

---

## 3. Performance and cost

### 3.1 Cold fleet load is ~9 seconds — *verified*
Measured on `/leaks` at fleet scope: `networkidle` at 0.8s, first grid row at 9.0s.
Warm, the same query returns in ~1s. The user stares at an empty grid for the
difference. Needs skeleton rows at minimum, and realistically a cache.

### 3.2 Fleet queries are unbounded
`getCommandCenter` at fleet scope runs `SELECT … FROM VW_INCIDENTS` with **no
`LIMIT` and no pagination**, then filters in Node and serialises the whole thing to
the browser. Fine at 3 incidents; not fine at 30,000. Needs server-side pagination
and a bounded default window.

### 3.3 Every page view costs warehouse seconds
All four routes set `Cache-Control: no-store`, so cost scales with page views rather
than with data volume. The underlying tables are deterministic with a ~5-minute
freshness target, so a short server-side cache keyed on `(scope, route)` would cut
warehouse spend by an order of magnitude with no correctness loss.

### 3.4 Smaller items
- `loadConfig()` re-reads and re-validates the environment on **every** query
  ([`nocturne-backend.ts`](src/server/nocturne-backend.ts)).
- One shared connection with no pool; a slow query blocks the rest.
- No query cancellation when a user navigates away mid-fetch on the server side.

---

## 4. Operations

Nothing in this section exists yet.

- **No error tracking.** Failures go to `console.error` and vanish.
- **No structured logging or request IDs.** A tenant reporting "it was slow at 3pm"
  cannot be investigated.
- **No health check endpoint** for a load balancer to probe.
- **No CI.** `typecheck`, `lint` and `test:click` all exist and none run automatically.
- **No rate limiting** on any API route.
- **No audit log.** This product displays breach intelligence about named companies;
  who viewed which tenant's incidents, and when, needs recording for compliance.
- **No deployment target chosen.** The Snowflake driver requires the Node runtime,
  so the API routes cannot run on an edge runtime.

---

## 5. Correctness of what is displayed

- **Grounding is enforced in SQL, not in the UI** — that is the right place, but the
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

- The knowledge graph is canvas-only: no keyboard navigation, no screen-reader
  alternative, no text fallback for the relationships it shows.
- No empty states. A tenant with zero incidents sees an empty grid, not an
  explanation.
- No skeletons during the multi-second live loads (see 3.1).
- **Dev-mode collision:** the Next.js dev indicator sits over the bottom-left of the
  collapsed sidebar and intercepts clicks on the sign-out button. It does not exist
  in a production build, but it makes manual testing in dev misleading.

---

## 7. Suggested order

1. Rotate the Snowflake token and move secrets out of the repo. *(§1.4, §1.5)*
2. Least-privilege Snowflake role for the dashboard. *(§1.4)*
3. Server-side tenant directory; get `users`/`organizations` out of the bundle. *(§1.2)*
4. Real identity provider. *(§1.1, §1.3)*
5. Write path for remediation status — the single most requested missing action. *(§2.1)*
6. Pagination and a short server cache. *(§3.2, §3.3)*
7. Needs-review detail view. *(§2.2)*
8. `/pipeline` and `/admin/fleet` off mocks — cheapest wins on the board. *(§2.3)*
9. Error tracking, health check, CI. *(§4)*
10. `GLOBAL_NODE_KEY` migration. *(§2.4)*

Items 1–4 are prerequisites for exposing this to anyone outside the team. Items 5–8
are what make it feel like a product. Items 9–10 are what make it maintainable.
