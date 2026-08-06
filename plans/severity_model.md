# Nocturne final severity model (L4)

Companion to `L2_L3_L4_design.md`. Your step-9 comment already reserved this:
*"NER/KG receives every component so entity resolution can refine relevance and
calculate a separate final severity without overwriting this preliminary score."*
This is that calculation.

---

## 1. What the preliminary score cannot do

Four concrete limits in `09_dt_leak_type_severity.sql`, each fixable with data
you either already have or are about to have.

### 1.1 Leak types don't compound

```sql
IMPACT_SCORE = GREATEST(50, EVIDENCE_SCORE,
  credential→85, corporate_data→75, pii→85, financial→90, malware_exploit→70)
```

`GREATEST` means credential + financial + PII scores **90** — identical to
financial alone. A breach spanning three data classes is materially worse than
one spanning a single class, and the current formula cannot express that.

### 1.2 Resolution is too low to rank

`IMPACT_SCORE` takes roughly five distinct values and
`TARGET_RELEVANCE_SCORE` is floored at 70 for every `target_data_leak`, so the
preliminary score for a confirmed leak lives in a narrow band with heavy
ties. An analyst opening the dashboard needs a rank order, not twelve documents
tied at "high".

### 1.3 The attribution signal is thrown away before it's used

`BUILD_CLASSIFICATION_INPUT` scores anchors precisely — `target_domain` 100,
`canonical_name` 90, `target_alias` 80, `target_product` 60. Then step 8 does:

```sql
GREATEST(70, COALESCE(TARGET_MATCH_SCORE, 0)) AS TARGET_RELEVANCE_SCORE
```

That floor collapses a weak product-only match (60) and a strong domain match
(100) into 70 vs 100 — and it is `TARGET_RELEVANCE_SCORE`, not the raw
`TARGET_MATCH_SCORE`, that feeds the preliminary severity. **The final model
should read `TARGET_MATCH_SCORE` directly.** A page matching `bankofbaroda.in`
deserves far more attribution confidence than one matching the word "Baroda",
and you already compute that distinction.

### 1.4 No credibility, no recency, no scale

A bare boast ("I have ODIDO creds, DM me") and a post carrying a verifiable
sample with 40 real credential patterns score identically. So does an
18-month-old listing. And a 500-record breach scores the same as a
5-million-record one.

---

## 2. The model: four factors, one per pipeline layer

```
FINAL_SEVERITY_SCORE = IMPACT × CONFIDENCE × ATTRIBUTION × RECENCY
                       (0–100)   (0.40–1)    (0.30–1)     (0.60–1)
```

Each factor answers a different question, and — the part worth putting on a
slide — **each is sourced from a different layer**:

| Factor | Question | Source |
|---|---|---|
| **IMPACT** | How bad is this data if real? | L0 indicators + L1 leak types + L2 quantity |
| **CONFIDENCE** | Do we believe it? | L2 grounding + L3 corroboration + actor history |
| **ATTRIBUTION** | Is it really *our* org? | L1 anchor score + L3 entity resolution |
| **RECENCY** | Is it still actionable? | L0 `FETCHED_AT` |

Every layer contributes exactly one term to the final number. That is the
cleanest possible answer to "why does this pipeline need four layers?"

Ranges are floored deliberately so the product doesn't collapse: worst case
`0.40 × 0.30 × 0.60 = 0.072`, so a 100-impact leak with no credibility, weak
attribution, and 18 months of age scores 7 (informational). Best case is 1.0.
That spread is wide enough to rank on and bounded enough to explain.

### 2.1 IMPACT (0–100)

Replace `GREATEST` with max-plus-damped-bonus so additional leak types
compound without exploding:

```sql
TYPE_COUNT      = number of TRUE has_*_leak flags
MAX_TYPE_WEIGHT = GREATEST(financial 90, credential 85, pii 85,
                           corporate_data 75, malware_exploit 70)

IMPACT = LEAST(100,
           GREATEST(50, EVIDENCE_SCORE, MAX_TYPE_WEIGHT)
           + 5 * (TYPE_COUNT - 1)          -- each extra class adds 5
           + SCALE_BONUS)                  -- see below
```

Financial alone stays 90; financial + credential is 95; all three is 100.
Monotonic, bounded, and trivially explainable to a judge.

**Add scale.** This is the biggest missing impact dimension and it costs one
field in the L2 schema:

```
'quantity_claimed': {'type': ['integer','null']}   -- "500,000 customer records"
```

```sql
SCALE_BONUS = CASE
  WHEN QUANTITY_CLAIMED IS NULL        THEN 0
  WHEN QUANTITY_CLAIMED >= 1000000     THEN 10
  WHEN QUANTITY_CLAIMED >= 100000      THEN 7
  WHEN QUANTITY_CLAIMED >= 10000       THEN 4
  WHEN QUANTITY_CLAIMED >= 1000        THEN 2
  ELSE 0 END
```

Guard it with the grounding check from L2 — only trust a quantity whose
`evidence_text` verified verbatim, otherwise the model can inflate severity by
hallucinating a number.

### 2.2 CONFIDENCE (0.40–1.00)

This is what L2 and L3 buy you, and it is where the graph earns its place.

```sql
CONFIDENCE = LEAST(1.00,
    0.40                                                    -- floor
  + 0.25 * COALESCE(CLAIM_GROUNDING_RATE, 0)                -- L2 verbatim check
  + 0.15 * LEAST(1.0, (CORROBORATION_COUNT - 1) / 2.0)      -- L3: 1 doc→0, 3+→1
  + 0.12 * LEAST(1.0, ACTOR_CORROBORATED_CLAIMS / 3.0)      -- L3 actor history
  + 0.08 * IFF(STRONG_INDICATOR_COUNT > 0, 1, 0))           -- L0 real secrets
```

Weights sum to exactly 1.00. Each component:

- **`CLAIM_GROUNDING_RATE`** — fraction of L2 claims whose `evidence_text`
  verified as a verbatim substring. Extraction that fails verification is a
  model that is guessing, and its claims should not drive an alert.
- **`CORROBORATION_COUNT`** — distinct `DEDUPE_KEY`s asserting the same claim
  about the same resolved entity. One document is an allegation; three
  independent documents is an incident. `DEDUPE_KEY` (content hash) rather than
  `DOC_ID` matters here — otherwise a mirrored page corroborates itself.
- **`ACTOR_CORROBORATED_CLAIMS`** — how many corroborated claims this actor
  node has made across the whole graph. A known actor with a track record is
  more credible than a first-time alias.
- **`STRONG_INDICATOR_COUNT`** — your L0 strong patterns are private keys,
  GitHub tokens, AWS secret keys, and password assignments. Their presence
  means real secret material is on the page, not just talk about it.

### 2.3 ATTRIBUTION (0.30–1.00)

```sql
ATTRIBUTION = GREATEST(0.30,
    (COALESCE(TARGET_MATCH_SCORE, 0) / 100.0)     -- raw, NOT the 70-floored one
  * IFF(GRAPH_ORG_RESOLVED, 1.00, 0.85))
```

`GRAPH_ORG_RESOLVED` is TRUE when L2 independently extracted an
`organization` entity that resolves (via the L3 `NODE_KEY` hash) to the
monitored org. That is a second, independent confirmation from a different
method than L1's string anchors — regex said it, and the extraction model
agreed. Cheap to compute, and it directly addresses the false-positive risk
that "Baroda" appears in an unrelated footer.

### 2.4 RECENCY (0.60–1.00)

```sql
RECENCY = 0.60 + 0.40 * EXP(-LN(2)
            * DATEDIFF('day', FETCHED_AT, CURRENT_TIMESTAMP()) / 180.0)
```

180-day half-life with a 0.60 floor: leaks decay in urgency but never become
irrelevant. Use `FETCHED_AT`, and note in the README that it is crawl time, not
publication time — an honest caveat judges respect more than a fake precision.

---

## 3. Incident rollup — the unit an organization actually cares about

Document-level severity is the wrong unit for a dashboard. Ten marketplace
mirrors of one credential dump is **one** incident, not ten criticals. Ten
*independent actors* each claiming access is much worse than one actor posting
ten times. The graph is what tells those two situations apart, and nothing in
L0/L1 can.

```sql
INCIDENT_KEY = SHA2(ORG_ID || '|' || COALESCE(ACTOR_NODE_KEY, DEDUPE_KEY))
```

Roll up with `MAX(FINAL_SEVERITY_SCORE)` per incident, carrying
`COUNT(DISTINCT DEDUPE_KEY)` as spread and `COUNT(DISTINCT ACTOR_NODE_KEY)` per
org as the actor-pressure signal. Org-level headline = max incident severity,
with open critical incident count beside it.

Reuse your existing band thresholds (≤19 informational, ≤39 low, ≤59 medium,
≤79 high, else critical) so preliminary and final are directly comparable.

---

## 4. Keep both scores and show the delta

Do not overwrite `PRELIMINARY_SEVERITY_SCORE` — your step-9 comment is right.
Store both and surface the movement:

```sql
FINAL_SEVERITY_SCORE - PRELIMINARY_SEVERITY_SCORE AS SEVERITY_DELTA,
ARRAY_CONSTRUCT(                          -- human-readable reason codes
  IFF(CORROBORATION_COUNT >= 3, 'corroborated_by_3_sources', NULL),
  IFF(CLAIM_GROUNDING_RATE < 0.5, 'weak_extraction_grounding', NULL),
  IFF(TARGET_MATCH_SCORE >= 100, 'domain_level_attribution', NULL),
  IFF(ACTOR_CORROBORATED_CLAIMS = 0, 'unproven_actor', NULL)
) AS SEVERITY_REASONS
```

The delta *is* the demo. "L1 flagged this critical on regex and leak type
alone. The graph found the claim uncorroborated, the actor with no history,
and the org matched only on a product name — final severity medium." And the
inverse: a document L1 rated medium that three independent marketplaces
corroborate, from an actor with a track record, escalating to critical. One
screen, and the value of L2 and L3 is self-evident.

`SEVERITY_REASONS` also makes the score auditable rather than a black box,
which is what turns this from a number into a product.

---

## 5. Validating it in the time you have

Precision/recall needs labels you don't have and won't get by 6 August. Do this
instead — it is honest and it is enough:

1. **Monotonicity checks as SQL assertions.** More corroboration never lowers
   severity; more leak types never lower impact; older never scores above
   newer at equal inputs. Three `SELECT COUNT(*) ... HAVING` queries that must
   return zero. Put them in step 15 next to your existing go-live validations.
2. **Hand-label ~20 documents** yourself into critical/high/medium/low. Report
   rank correlation between your labels and the model, for preliminary vs
   final. If final beats preliminary, that single number justifies L2–L4.
3. **A deliberate adversarial page** in the seed corpus: a boast with no
   evidence, no corroboration, and an unknown actor, claiming a catastrophic
   breach. L1 should rate it critical; the final model should rate it low.
   That one example demonstrates the whole thesis in ten seconds.

Point 3 is worth building even if you skip 1 and 2.

---

## 6. Where it goes

One new file, `14_dt_l4_severity.sql`, after the L3 graph tables. Pure SQL, no
Cortex calls, so it adds no inference cost and refreshes in seconds. Structure
it as `DT_L4_DOCUMENT_SEVERITY` → `DT_L4_INCIDENT_SEVERITY` →
`VW_L4_ORG_POSTURE`, mirroring the CTE-per-stage style you already use in step 9
so the arithmetic stays inspectable stage by stage.
