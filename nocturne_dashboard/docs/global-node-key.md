# Proposed pipeline change: `GLOBAL_NODE_KEY`

**Status:** proposal — not applied. This document lives in the dashboard repo so
the pipeline stays untouched until someone who owns it reviews the change.

**File:** `snowflake/10_dt_l2_grounding_routing.sql`, in the final `SELECT` of
`DT_L2_ENTITIES` (around lines 613–626).

---

## The problem

Every branch of `NODE_KEY` includes `ORG_ID`:

```sql
CASE
  WHEN ENTITY_MATCH_STATUS = 'confirmed' AND ITEM_TYPE = 'organization'
    THEN SHA2(ORG_ID || '|organization|' || ORG_ID)
  WHEN ITEM_TYPE = 'actor_alias'
    AND NORMALIZED_NAME IN ('admin', 'seller', 'user', 'vendor')
    THEN SHA2(ORG_ID || '|' || ITEM_TYPE || '|' || NORMALIZED_NAME || '|'
              || COALESCE(URL, SOURCE, SOURCE_FILE, 'unknown_source'))
  WHEN ITEM_TYPE = 'domain'
    THEN SHA2(ORG_ID || '|domain|' || NORMALIZED_DOMAIN)
  ELSE SHA2(ORG_ID || '|' || ITEM_TYPE || '|' || NORMALIZED_NAME)
END AS NODE_KEY
```

Per tenant this is exactly right — it is what guarantees that one customer's
graph can never join another's.

But it means the actor `NightFox`, seen while crawling for `palo_alto_networks`
and seen again while crawling for `att`, produces **two different node keys that
cannot be joined**. The single most valuable fleet-level insight — *"this actor
is hitting three of your five tenants"* — is currently uncomputable.

## The change

Add one column beside the existing one. Nothing is renamed or removed.

```sql
    -- Existing org-scoped key, unchanged. Keeps tenant isolation.
    CASE
      ...
    END AS NODE_KEY,

    -- NEW: org-independent identity for fleet-level correlation.
    -- Deliberately excludes ORG_ID so the same real-world entity collapses to
    -- one key across tenants. Generic aliases stay per-source so two unrelated
    -- sellers both called "admin" do not merge into one actor.
    CASE
      WHEN ITEM_TYPE = 'actor_alias'
        AND NORMALIZED_NAME IN ('admin', 'seller', 'user', 'vendor')
        THEN NULL
      WHEN ITEM_TYPE = 'domain'
        THEN SHA2('domain|' || NORMALIZED_DOMAIN)
      ELSE SHA2(ITEM_TYPE || '|' || NORMALIZED_NAME)
    END AS GLOBAL_NODE_KEY
```

Then carry it through `DIM_GRAPH_NODE` (step 12) as a grouped passthrough:

```sql
    MIN(GLOBAL_NODE_KEY) AS GLOBAL_NODE_KEY,
```

## Why generic aliases return NULL

The existing code already special-cases `admin` / `seller` / `user` / `vendor`
by mixing the source URL into the hash, because two different sellers using the
name "admin" are two different actors. That reasoning is *stronger* at fleet
scope, not weaker — merging every "admin" across five tenants into one node
would manufacture a fake super-actor and put it at the top of the correlation
table. Returning `NULL` keeps them out of cross-tenant correlation entirely.

## Blast radius

- **Additive.** No column renamed, no type changed, no downstream query broken.
- `DT_L2_ENTITIES` is `REFRESH_MODE = INCREMENTAL`; `CREATE OR REPLACE` on it
  triggers a full reinitialize of that table and its dependents.
- **No Cortex calls are repeated.** The four AI result tables are keyed on
  `(ORG_ID, DEDUPE_KEY)` and are untouched by this change, so a rebuild reuses
  every cached extraction. Cost of applying this is warehouse compute only.
- Verify with:

```sql
SELECT GLOBAL_NODE_KEY, ANY_VALUE(DISPLAY_NAME) AS NAME,
       COUNT(DISTINCT ORG_ID) AS TENANTS
FROM NOCTURNE.RAW.DIM_GRAPH_NODE
WHERE NODE_TYPE = 'actor_alias' AND GLOBAL_NODE_KEY IS NOT NULL
GROUP BY GLOBAL_NODE_KEY
HAVING COUNT(DISTINCT ORG_ID) > 1
ORDER BY TENANTS DESC;
```

## Until it ships

`GraphNode.globalNodeKey` and `ThreatActor.globalNodeKey` are typed as
`string | null` and are `null` everywhere. `/admin/fleet/actors` degrades to
per-tenant actors with a note explaining why, rather than inventing correlation
that the data cannot support.
