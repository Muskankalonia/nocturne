---
name: "remaining ui optimizations"
created: "2026-08-21T19:03:17.474Z"
status: pending
---

# Plan: Remaining UI Optimizations

## Overview

Implement 8 performance optimizations across the Snowflake backend, Next.js API routes, and React frontend. These changes are independent and can be implemented in sequence without breaking existing functionality.

---

## Task 1: Trim AI Text Columns from Command Center List Query

**Problem:** The command center fetches 6 large AI-generated text columns (`EXECUTIVE_SUMMARY`, `WHAT_HAPPENED`, `BUSINESS_IMPACT`, `RECOMMENDED_ACTIONS`, `CONFIDENCE_ASSESSMENT`, `INSIGHT_CAVEATS`) that are only displayed on the incident *detail* page, not the list/grid.

**Change:**

- Create `INCIDENT_LIST_COLUMNS` in `nocturne-backend.ts` — same as `INCIDENT_COLUMNS` but without the 6 AI text blobs
- Use `INCIDENT_LIST_COLUMNS` in `getCommandCenter()`
- Keep `INCIDENT_COLUMNS` for `getIncidentDetail()` where the text is needed
- Update the row mapper to handle optional fields gracefully

**Impact:** \~50-70% reduction in JSON payload size for the command center API response.

---

## Task 2: Server-Side Pagination for Breach Monitor and Command Center

**Problem:** All rows are fetched from Snowflake and transferred to the browser, then paginated client-side. Fleet admins may have thousands of rows.

**Change:**

- Add `page` and `pageSize` query params to `/api/breach-monitor` and `/api/command-center`
- Add `LIMIT ? OFFSET ?` to the Snowflake SQL queries
- Run a parallel `SELECT COUNT(*)` to return total row count
- Return `{ rows, totalCount }` from the API
- Update the breach monitor `DataTable` to pass `rowCount` to AG Grid for proper pagination display
- Command center priority queue already shows 5 at a time client-side — paginate the underlying fetch to top-50 scored incidents (the queue only shows scored ones)

**Defaults:** pageSize=50 for breach monitor, all scored incidents for command center priority queue (typically <100 rows, so server pagination may be overkill here — will assess).

---

## Task 3: Snowflake Connection Pooling

**Problem:** Single shared connection serializes all concurrent requests. Under load (multiple users, auto-refresh timers, triage actions), queries queue behind each other.

**Change:**

- Replace `snowflake.createConnection()` with `snowflake.createPool()`
- Configure: `min: 1, max: 5`
- Update `getConnection()` to use `pool.use(async (conn) => ...)` pattern
- `executeQuery` will acquire a connection from the pool per query and release it after

**File:** `nocturne-backend.ts:968-1094`

---

## Task 4: HTTP Cache-Control Headers

**Problem:** Every API route returns `Cache-Control: no-store`. The browser can never serve a cached response, even for back-navigation or tab switches.

**Change per route:**

| Route                  | Header                                           |
| ---------------------- | ------------------------------------------------ |
| `/api/knowledge-graph` | `max-age=300, stale-while-revalidate=600`        |
| `/api/threat-actors`   | `max-age=300, stale-while-revalidate=600`        |
| `/api/command-center`  | `max-age=30, stale-while-revalidate=120`         |
| `/api/breach-monitor`  | `max-age=30, stale-while-revalidate=120`         |
| `/api/pipeline`        | `no-cache` (revalidate each time, but allow 304) |

Keep `Vary: Cookie` on all routes to prevent cross-user cache leakage.

---

## Task 5: Targeted Cache Invalidation

**Problem:** `invalidateIncidentViews()` clears ALL entries with `breach-monitor:` and `command-center:` prefixes — every org's cache is wiped when any single user triages one incident.

**Change:**

- Accept `scope: DataScope` parameter in `invalidateIncidentViews()`
- Only clear keys matching the specific scope: `breach-monitor:${scopeKey(scope)}:*` and `command-center:${scopeKey(scope)}:*`
- Also clear the fleet-level cache (since fleet totals change too)
- Update callers (triage routes) to pass the affected scope

---

## Task 6: Materialize Actor Network View

**Problem:** The actor network CTEs perform multiple self-joins on `VW_KNOWLEDGE_GRAPH_EDGES` — expensive even on small datasets.

**Change:**

- Provide DDL for a dynamic table `DT_ACTOR_NETWORK_NODES` and `DT_ACTOR_NETWORK_EDGES` that pre-computes the CTE logic
- Update the backend `ACTOR_NETWORK_NODE_QUERY` and `ACTOR_NETWORK_EDGE_QUERY` to read from the dynamic tables instead
- Set target lag to match the pipeline cycle (12 hours or downstream of the graph DTs)

**Note:** This requires running SQL in the Snowflake account. Will provide the DDL for the user to execute.

---

## Task 7: Deduplicate Polling Across Tabs

**Problem:** Each open tab independently polls every 5 minutes. Three tabs = three identical Snowflake queries.

**Change:**

- Create a `src/lib/broadcast-poll.ts` utility that:

  - Uses `BroadcastChannel` to coordinate which tab is the "leader"
  - Only the leader tab fetches; others receive the result via the channel
  - If the leader tab closes, another tab claims leadership

- Integrate into `PostureContext` polling loop

- Graceful fallback: if `BroadcastChannel` is unsupported, behave as today

---

## Task 8: Lazy-Load Heavy Components

**Problem:** PostureFlow (complex SVG), Cascade (chart), and AssistantDrawer (LLM client) are statically imported — their code is in the initial JS bundle even if the user hasn't scrolled to them.

**Change:**

- Wrap `PostureFlow` import with `next/dynamic({ ssr: false, loading: ... })`
- Wrap `Cascade` import with `next/dynamic({ ssr: false, loading: ... })`
- Wrap `AssistantDrawer` import with `next/dynamic({ ssr: false, loading: ... })`
- Use existing skeleton components as loading placeholders

**Already done:** `KnowledgeGraph` on the graph page.

---

## Implementation Order

1 → 4 → 5 → 8 → 3 → 7 → 2 → 6

Rationale: Start with low-effort high-impact changes (trim columns, headers, lazy-load), then infrastructure (pooling, broadcast), then the more complex ones (pagination, materialized views).
