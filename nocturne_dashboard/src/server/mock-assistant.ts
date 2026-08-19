/**
 * Nocturne Console — Mock assistant for demo/test mode.
 *
 * Returns canned responses so the assistant drawer works without
 * live Snowflake or Cortex COMPLETE calls.
 */

import type { AssistantMessage, AssistantResponse } from "@/server/nlq-assistant";

const MOCK_LATENCY_MS = 350;

interface MockAnswer {
  pattern: RegExp;
  answer: string;
  toolsCalled: string[];
  suggestedFollowUps: string[];
}

const MOCK_ANSWERS: MockAnswer[] = [
  {
    pattern: /how many.*(incident|breach)/i,
    answer:
      "Based on the current data, you have **5 confirmed incidents** across your monitored organization:\n\n- 1 Critical severity\n- 2 High severity\n- 1 Medium severity\n- 1 Low severity\n\nThe most recent was discovered 3 days ago involving credential exposure.",
    toolsCalled: ["getCommandCenter"],
    suggestedFollowUps: [
      "Tell me about the critical incident",
      "Which threat actors are involved?",
      "How is severity calculated?",
    ],
  },
  {
    pattern: /critical|highest.*severity|most.*severe/i,
    answer:
      "Your highest-priority incident is **\"Alleged employee credential database offered for sale\"** (Critical severity, score 87/100).\n\n**Key details:**\n- Leak types: credential, pii\n- Evidence confidence: High (72/100)\n- Actor: \"darkmarket_vendor_x\" (credibility: 65/100)\n- Corroborated by 3 independent sources\n- First seen: 2026-07-28\n\nThe severity is driven by credential + PII data types (high sensitivity), combined with strong evidence grounding (exact match) and cross-source corroboration.",
    toolsCalled: ["getBreachMonitor"],
    suggestedFollowUps: [
      "What recommended actions should we take?",
      "Are there other incidents from the same actor?",
      "How is the evidence confidence scored?",
    ],
  },
  {
    pattern: /actor|threat.*actor|who.*behind|credib/i,
    answer:
      "You have **3 distinct threat actors** identified across your incidents:\n\n| Actor | Credibility | Claims | Corroborated |\n|-------|------------|--------|-------------|\n| darkmarket_vendor_x | 65/100 | 4 | 3 |\n| shadow_leaks_22 | 42/100 | 2 | 1 |\n| anon_dumper | 18/100 | 1 | 0 |\n\n**darkmarket_vendor_x** is the most credible — their claims are corroborated by independent sources across 3 distinct documents, and they operate on 2 marketplaces.",
    toolsCalled: ["getThreatActors"],
    suggestedFollowUps: [
      "Show me incidents from darkmarket_vendor_x",
      "How is actor credibility calculated?",
      "What's my overall posture?",
    ],
  },
  {
    pattern: /severity.*(calc|scor|mean|work)|how.*scor|triage.*priority/i,
    answer:
      "The severity scoring model uses **three separate scores** (never multiplied as probabilities):\n\n**1. Impact Severity (0-100)**\n- 60% Data sensitivity by leak type (financial=90, credential=85, PII=80, corporate_data=70, malware=70)\n- 25% Exposure actionability (self-evidenced sample → 100, strong indicators → 90)\n- 15% Record scale (log-scaled quantity claimed)\n\n**2. Evidence Confidence (0-100)**\n- 35% Ownership evidence (entity resolution against configured domains/aliases)\n- 25% Grounding confidence (exact substring match = 100, normalized = 85)\n- 20% Claim proof (self-evidenced = 95, strong indicators = 80)\n- 15% Corroboration (3+ distinct contents = 85, 2 = 70, 1 = 40)\n- 5% Actor credibility\n\n**3. Triage Priority (0-100)**\n- 80% Impact severity + 20% Evidence confidence\n\n**Bands:** Critical ≥ 80, High ≥ 60, Medium ≥ 40, Low ≥ 20, Informational < 20",
    toolsCalled: [],
    suggestedFollowUps: [
      "What's my current posture?",
      "Show me critical incidents",
      "How does grounding work?",
    ],
  },
  {
    pattern: /ground|evidence.*verif|how.*trust|hallucin/i,
    answer:
      "**Evidence grounding** is how Nocturne verifies that AI-extracted claims are real, not hallucinated.\n\n**How it works:**\n1. The AI extraction model returns `evidence_text` — a quote it claims comes from the source document\n2. SQL verification checks if that quote exists as an exact or normalized substring of the actual source\n3. Results:\n   - **Exact** — character-for-character match found → trusted\n   - **Normalized** — matches after whitespace/unicode normalization → trusted\n   - **Unmatched** — quote not found in source → **rejected and quarantined**\n\n**Why this matters:** Unmatched claims never enter severity scoring, never appear as confirmed incidents, and never trigger alerts. This is why the dashboard shows a \"grounding rate\" metric — it measures what percentage of AI extractions passed this verification.\n\nYour current grounding rate is **94%** — meaning 6% of model extractions were caught as hallucinations and blocked.",
    toolsCalled: [],
    suggestedFollowUps: [
      "What's my current grounding rate?",
      "Show me corroborated claims",
      "How does corroboration work?",
    ],
  },
  {
    pattern: /posture|overview|summary|status|dashboard/i,
    answer:
      "**Current Breach Posture Summary:**\n\n- **5 confirmed incidents** (1 critical, 2 high, 1 medium, 1 low)\n- **3 pages needing review** (awaiting L2 ownership verification)\n- **2 other-company leaks** (context only, not your data)\n- **3 active threat actors** (highest credibility: 65/100)\n- **Evidence grounding rate: 94%**\n- **Last activity:** 3 days ago\n\n**Pipeline health:** All stages healthy. 47 pages collected → 32 screened → 12 selected for deep analysis → 5 confirmed incidents raised.\n\nTop priority: the Critical-severity credential leak from darkmarket_vendor_x, corroborated by 3 independent sources.",
    toolsCalled: ["getCommandCenter"],
    suggestedFollowUps: [
      "Tell me about the critical incident",
      "Who are the threat actors?",
      "Show me the pipeline details",
    ],
  },
  {
    pattern: /pipeline|stage|cascade|collected|screened/i,
    answer:
      "**Pipeline cascade (current organization):**\n\n| Stage | Count |\n|-------|-------|\n| Pages collected | 47 |\n| Pages screened (L0) | 32 |\n| Unique pages | 28 |\n| Relevance checked (L1) | 28 |\n| Selected for L2 | 12 |\n| Evidence extracted | 10 |\n| Ownership verified | 7 |\n| Data types classified | 5 |\n| Incidents raised | 5 |\n\n**Conversion:** 47 raw pages → 5 confirmed incidents (10.6% yield).\n\nAll AI stages are healthy with no errors. Last ingestion was 6 hours ago.",
    toolsCalled: ["getPipeline"],
    suggestedFollowUps: [
      "What's the overall posture?",
      "Show me the confirmed incidents",
      "How does the pipeline work?",
    ],
  },
  {
    pattern: /corrobor/i,
    answer:
      "**Corroboration** measures how many independent sources confirm a breach claim.\n\n**How it's counted:**\n- Based on **distinct content hashes** (not duplicate mirrors of the same document)\n- Same content posted on multiple forums = 1 corroboration (it's just a mirror)\n- Different write-ups from different sources describing the same breach = multiple corroborations\n\n**Levels:**\n- 3+ distinct contents → **Corroborated**\n- 2 distinct contents → **Partially corroborated**\n- 1 content → **Unverified**\n- Contradicted by another source → **Disputed**\n\nCorroboration feeds into both the **evidence confidence score** (15% weight) and the **actor credibility score** (45% weight on corroboration ratio).",
    toolsCalled: [],
    suggestedFollowUps: [
      "Which incidents are corroborated?",
      "How is actor credibility calculated?",
      "Show me evidence confidence details",
    ],
  },
];

const DEFAULT_ANSWER: Omit<MockAnswer, "pattern"> = {
  answer:
    "I can help you with questions about your breach data, threat actors, pipeline health, and how the scoring methodology works.\n\nHere are some things you can ask:\n- \"What's my current breach posture?\"\n- \"Show me critical incidents\"\n- \"Who are the threat actors?\"\n- \"How is severity calculated?\"\n- \"How does evidence grounding work?\"",
  toolsCalled: [],
  suggestedFollowUps: [
    "What's my current breach posture?",
    "Show me critical incidents",
    "How is severity calculated?",
  ],
};

export function mockAskAssistant(
  question: string,
): AssistantResponse {
  const matched = MOCK_ANSWERS.find((a) => a.pattern.test(question));
  const source = matched ?? DEFAULT_ANSWER;

  return {
    answer: source.answer,
    citations: [],
    suggestedFollowUps: source.suggestedFollowUps,
    toolsCalled: source.toolsCalled,
    latencyMs: MOCK_LATENCY_MS,
  };
}
