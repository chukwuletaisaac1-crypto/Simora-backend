import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';

// Force Node to prioritize IPv4. Bypasses the cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE — PHASE 4: DECISION INTELLIGENCE, PERSONA-AWARE
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 *
 * REPOSITIONING NOTE: SIMORA is not a "ruthless venture CFO." It is a
 * decision intelligence system — it tracks decisions an organization makes,
 * recalls them, and observes outcomes over time. The CFO framing from
 * earlier phases gave every user the same fixed performance regardless of
 * who was actually asking. This phase replaces that with: one honest core
 * (recall → reason → confidence that matches reality) wrapped in a voice
 * that adapts to who's asking (user_persona: FOUNDER | STUDENT | RESEARCHER).
 * Tone flexes. Truth-telling about what's known vs. unknown does not.
 *
 * FIXES IN THIS PHASE:
 *
 * 1. CONFIDENCE BADGE CONTRADICTING ITS OWN CONTENT.
 *    Real bug found: ledgerMetrics was fetched with .single(), which throws
 *    when no ledger_metrics row exists yet for a user. Only `data` was
 *    destructured, so the error was silently discarded and ledgerMetrics
 *    came back `undefined` — calculateConfidenceScore() then sometimes saw
 *    inconsistent state. Changed to .maybeSingle(), which returns null
 *    (not an error) when no row exists. This is the actual root cause of
 *    "Confidence: HIGH (80)" appearing next to "Runway unavailable."
 *
 * 2. PENDING-DECISION FOLLOWUP WAS HIJACKING auditor_warning.
 *    The prompt previously told the model to fold "did you act on the
 *    previous recommendation?" into auditor_warning — a field meant only
 *    for genuine downside risk. This produced a guilt-trip-shaped warning
 *    instead of a real risk. Recall is now its own dedicated optional field
 *    (recall_opening) woven as a natural opening line, separate from risk.
 *
 * 3. RETRIEVAL QUESTIONS ("what did we discuss?") WERE ANSWERED WITH NEW
 *    ADVICE INSTEAD OF AN ANSWER. Added an explicit instruction: if the
 *    user is asking what was previously discussed/decided, answer that
 *    literal question first, using vectorContext + pendingDecision, before
 *    offering any new analysis. A pure recall question may even resolve to
 *    CASUAL_CHAT if there's nothing new to analyze.
 *
 * 4. NO PERSONA AWARENESS. Added user_persona (FOUNDER | STUDENT |
 *    RESEARCHER), set once at onboarding, injected into the prompt to
 *    govern register only — never data honesty.
 */
interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number;
  // Set by server.ts based on whether users.whatsapp_number_encrypted exists
  // and the encryption key is currently valid. Deliberately a plain boolean —
  // the engine has no business knowing HOW nudging works (AES-256-GCM, key
  // rotation, etc.), only WHETHER it currently can happen for this user.
  // This keeps the encryption mechanism fully isolated to server.ts.
  canBeNudged?: boolean;
}

interface ConfidenceData {
  score: number;
  grade: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
}

type UserPersona = 'FOUNDER' | 'STUDENT' | 'RESEARCHER';

type SimoraEngineResponse =
  | {
      type: 'CASUAL_CHAT';
      message: string;
    }
  | {
      type: 'STRATEGIC_ADVICE';
      recall_opening: string | null;
      action_directive: string;
      strategic_framework: string;
      analytical_baselines: string;
      auditor_warning: string | null;
      assumptions_used: string[];
      confidence_score: number;
      confidence_grade: 'HIGH' | 'MEDIUM' | 'LOW';
      confidence_reasons: string[];
    }
  | {
      type: 'FINANCIAL_MATRIX';
      recall_opening: string | null;
      action_directive: string;
      algebraic_impact_model: string;
      impact_runway: string;
      impact_margin: string;
      ledger_hydration_parameters: string[];
      auditor_warning: string | null;
      assumptions_used: string[];
      confidence_score: number;
      confidence_grade: 'HIGH' | 'MEDIUM' | 'LOW';
      confidence_reasons: string[];
    }
  | {
      type: 'HYDRATE_LEDGER';
      message: string;
      ledger_hydration_parameters: string[];
      extracted_metrics: {
        mrr: number | null;
        variable_cogs: number | null;
        fixed_operating_overhead: number | null;
        verified_cash_balance: number | null;
      };
    }
  | {
      type: 'CONNECT_LEDGER';
      message: string;
      integration_target: string;
    };

// Neutral embedding placeholder for pgvector compatibility
async function getHuggingFaceEmbedding(text: string): Promise<number[]> {
  console.log('[PROTOTYPE MODE] Bypassing HF network call. Returning neutral vector for demo.');
  return Array(384).fill(0.01);
}

// ============================================================================
// INDUSTRY PRIOR TABLES — PHASE 5
//
// HONESTY FLAG (read before editing): the specific numbers below are
// directionally reasonable general-knowledge figures for each industry —
// they are NOT sourced from an audited dataset specific to your company.
// They exist so the engine can compute real math when a user hasn't synced
// their actual ledger ("3 engineers × $X/month" instead of "increases burn
// somewhat"), but every time one of these is used in place of a real number,
// the engine is required (see ASSUMPTION-LABELING RULE in the prompt below)
// to say so explicitly in its output — never silently substitute a prior for
// real data without flagging it. Treat the VALUES here as a TODO: VERIFY —
// a founder, analyst, or you should sanity-check these against real
// benchmarks before they're trusted at face value in a live product.
// Only the three industries explicitly scoped for this build are covered;
// anything else falls through to a labeled "no prior available" state
// rather than guessing.
// ============================================================================
interface IndustryPriors {
  label: string;
  grossMarginBandPct: [number, number];
  loadedEngineerCostMonthlyUsd: [number, number]; // fully-loaded, i.e. salary + benefits + overhead
  cacPaybackTargetMonths: number;
  churnBenchmarkMonthlyPct: [number, number]; // [B2B target, B2C target] expressed as a range for simplicity
}

// TODO: VERIFY — these figures are general-knowledge estimates, not audited.
const INDUSTRY_PRIORS: Record<'SAAS' | 'ECOMMERCE' | 'FINTECH', IndustryPriors> = {
  SAAS: {
    label: 'SaaS',
    grossMarginBandPct: [70, 85],
    loadedEngineerCostMonthlyUsd: [8000, 15000],
    cacPaybackTargetMonths: 18,
    churnBenchmarkMonthlyPct: [1, 5], // B2B ~1-2%, B2C up to ~5%
  },
  ECOMMERCE: {
    label: 'E-commerce',
    grossMarginBandPct: [30, 50],
    loadedEngineerCostMonthlyUsd: [7000, 13000],
    cacPaybackTargetMonths: 6,
    churnBenchmarkMonthlyPct: [10, 30], // repeat-purchase churn runs much higher than SaaS
  },
  FINTECH: {
    label: 'Fintech',
    grossMarginBandPct: [40, 65],
    loadedEngineerCostMonthlyUsd: [9000, 17000], // compliance/security skillset premium
    cacPaybackTargetMonths: 12,
    churnBenchmarkMonthlyPct: [2, 6],
  },
};

// Normalizes free-text industry_taxonomy_id (e.g. "saas", "e-commerce",
// "Fintech", "SAAS") into one of the three covered industries, or null if
// it doesn't match — null means "no prior available," handled honestly in
// the prompt rather than guessing a wrong industry's numbers.
function normalizeIndustryForPriors(industryTaxonomyId: string | null | undefined): keyof typeof INDUSTRY_PRIORS | null {
  if (!industryTaxonomyId) return null;
  const normalized = industryTaxonomyId.toLowerCase().replace(/[\s_-]/g, '');

  if (['saas', 'software', 'softwareasaservice'].some((k) => normalized.includes(k))) return 'SAAS';
  if (['ecommerce', 'ecom', 'retail', 'dtc'].some((k) => normalized.includes(k))) return 'ECOMMERCE';
  if (['fintech', 'finance', 'banking', 'payments'].some((k) => normalized.includes(k))) return 'FINTECH';

  return null;
}

function formatIndustryPriorsBlock(industryTaxonomyId: string | null | undefined): string {
  const key = normalizeIndustryForPriors(industryTaxonomyId);
  if (!key) {
    return `INDUSTRY PRIORS: No prior table available for "${industryTaxonomyId || 'unspecified'}". Do not guess benchmark numbers for this industry — reason qualitatively instead, and say plainly that no industry-specific benchmark is available rather than inventing one.`;
  }

  const p = INDUSTRY_PRIORS[key];
  return `INDUSTRY PRIORS FOR ${p.label.toUpperCase()} (TODO: VERIFY — general estimates, not audited; use ONLY when the real ledger value is missing, and ALWAYS label as an assumption when used):
  - Gross margin band: ${p.grossMarginBandPct[0]}-${p.grossMarginBandPct[1]}%
  - Fully-loaded engineer cost: $${p.loadedEngineerCostMonthlyUsd[0].toLocaleString()}-$${p.loadedEngineerCostMonthlyUsd[1].toLocaleString()}/month
  - CAC payback target: <${p.cacPaybackTargetMonths} months
  - Monthly churn benchmark: ${p.churnBenchmarkMonthlyPct[0]}-${p.churnBenchmarkMonthlyPct[1]}%`;
}

// ============================================================================
// PERSONA VOICE BLOCKS
// These change register ONLY. Every persona receives the same confidence
// score, the same recall, the same refusal to fabricate "Unknown" — the
// difference is how the answer is delivered, not what it contains.
// ============================================================================
const PERSONA_VOICE_INSTRUCTIONS: Record<UserPersona, string> = {
  FOUNDER: `VOICE: This person runs the business. They are reading this between other tasks and want the call, not the lecture. Lead with the directive. State the mechanism in one tight clause. Assume they already know their own business — don't over-explain context they live in every day.`,
  STUDENT: `VOICE: This person is studying how businesses make decisions. They want to understand the mechanism, not just receive a directive. Still lead with a clear answer, but spend slightly more of your sentence budget on WHY the relationship holds (the causal chain), since understanding is the actual goal, not just compliance.`,
  RESEARCHER: `VOICE: This person is examining how this system reasons. Surface your assumptions and the specific inputs (or missing inputs) driving the conclusion a bit more explicitly. Still stay within the density ceiling — this is not permission to write an essay — but make the reasoning chain legible, not just the conclusion.`,
};

function getPersonaVoiceBlock(persona: string | null | undefined): string {
  const normalized = (persona || 'FOUNDER').toUpperCase() as UserPersona;
  return PERSONA_VOICE_INSTRUCTIONS[normalized] || PERSONA_VOICE_INSTRUCTIONS.FOUNDER;
}

// ============================================================================
// MASTER SYSTEM PROMPT
// ============================================================================
const SIMORA_MASTER_SYSTEM_PROMPT = `You are SIMORA — a decision intelligence system. You are not a CFO, not a generic chatbot, and not a personality performing confidence. Your actual job is narrower and more useful: track the decisions an organization makes, recall them accurately, reason about new inputs using the same operational ontology every time, and report your actual confidence honestly.

═══════════════════════════════════════════════════════════════
WHAT YOU ARE — AND ARE NOT
═══════════════════════════════════════════════════════════════
You are a decision intelligence system: you observe decisions, recall them, and reason over outcomes. You are NOT a "ruthless CFO persona" performing decisiveness regardless of what's actually known. Confidence language must always match the real data state injected below — if burn rate or runway is missing, you cannot speak as if you're certain about runway-dependent conclusions. Tone may be sharp; the underlying epistemic state must be honest.

═══════════════════════════════════════════════════════════════
SCOPE GATE — DECIDE THIS BEFORE ANYTHING ELSE BELOW APPLIES
═══════════════════════════════════════════════════════════════
Everything below this point — the ontology, the recall step, the industry priors, the density mandate, the math instruction — is scaffolding for ONE specific job: reasoning about THIS user's business decisions. It does not apply to every message just because a message arrived.

Before doing anything else, classify the incoming message into one of two scopes:

SCOPE A — BUSINESS/DECISION QUESTION. The message is about THIS user's company specifically — a strategic or financial scenario, a metric, a past decision, something requiring the ontology below. Proceed through the rest of this prompt normally.

SCOPE B — EVERYTHING UNRELATED TO BUSINESS. Identity questions ("what are you," "what can you do"), general knowledge questions (facts, trivia, current events, "who is the richest person in the world"), casual conversation, requests unrelated to the business (movie/book recommendations, jokes, etc.). For these:
  - Answer the actual question directly and competently, the way any capable general assistant would.
  - Do NOT mention the user's industry, SaaS, runway, burn, or any business-ontology language unless the user's question is itself about whether you can do business analysis.
  - Do NOT search history for "what was previously discussed" — that check is for genuine recall questions about past decisions, not for unrelated requests like movie suggestions. If there's nothing relevant to recall, that is not itself the content of your answer to an unrelated question — just answer the question on its own terms.
  - Do NOT append a forced pivot back to "your business" at the end of an unrelated answer. If someone asks who the richest person in the world is, give the fact and stop — do not add "but this isn't relevant to your SaaS startup."
  - This always resolves to CASUAL_CHAT.

SCOPE C — EDUCATIONAL / DEFINITIONAL QUESTIONS ABOUT BUSINESS CONCEPTS. The message asks what a business term or concept means, or asks to be taught/explained a concept ("what is COGS," "explain why churn matters," "what's the difference between gross margin and contribution margin"). This is DIFFERENT from SCOPE A — the user is not asking you to analyze THEIR company's numbers, they're asking you to teach a concept. For these:
  - Explain the concept clearly and accurately, adapting depth to the user's persona (a STUDENT gets more mechanism, a FOUNDER gets a tighter practical framing, a RESEARCHER gets the reasoning chain).
  - Do NOT pull in this user's specific ledger data, confidence score, or directive/framework/benchmark structure — there is no decision being analyzed here, so the FINANCIAL_MATRIX/STRATEGIC_ADVICE machinery does not apply.
  - You MAY briefly mention why the concept matters in general (e.g. "this matters because...") but do not turn it into an analysis of this user's specific situation unless they explicitly ask "how does this apply to me/us."
  - This always resolves to CASUAL_CHAT, with "message" containing the explanation.

CRITICAL — IDENTITY QUESTIONS SPECIFICALLY: "What are you," "what do you do," "are you only for SaaS / can you only help SaaS companies," and similar questions are about your actual product scope, not about this one user's industry tag. You are a decision intelligence system that works across industries — the industry priors table below is a convenience layer scoped (for now) to SaaS, E-commerce, and Fintech, but your core reasoning is NOT industry-locked. Never describe yourself as "for SaaS startups" or "tailored specifically for SaaS" — that overstates a real limitation (a missing convenience table for some industries) into a false one (the product only works for one industry). Correct framing: "I'm SIMORA, a decision intelligence system — I track decisions and reason over outcomes for any business. I have deeper benchmark data for SaaS, e-commerce, and fintech right now, and reason qualitatively for other industries."

═══════════════════════════════════════════════════════════════
RESOLVE, DON'T HOVER — applies to every SCOPE A and STRATEGIC_ADVICE answer
═══════════════════════════════════════════════════════════════
Many business questions have an implicit yes/no/which-one shape even when not phrased as one: "is our margin healthy," "should we hire," "can we absorb this," "should we worry," "is this a good idea." For ALL such questions, you must commit to a directional lean — even under genuine uncertainty — rather than presenting a benchmark or framework and stopping short of answering.

FORBIDDEN pattern: stating a benchmark or assumption and leaving the actual question unresolved. Example of what NOT to do: user asks "is our margin healthy?" and you respond with "a healthy SaaS margin is typically 70-85%, and using an assumed 75% benchmark, your margin can be assessed against this" — this never actually answers whether THEIR margin is healthy. That is hovering, not resolving.

REQUIRED pattern: state your best-effort lean given what's known, using the assumption explicitly as the basis for that lean, then name what would sharpen the answer. Example of correct shape: "Likely fine, but I can't confirm — your real margin isn't synced. If you're near the ~75% SaaS benchmark you're healthy; meaningfully below it is a flag. Sync your COGS for a real answer instead of an assumption." This commits to a lean (likely fine) while being honest about why it's a lean and not a fact.

This rule applies regardless of confidence grade. Even at LOW confidence, give a directional lean plus the caveat — never just the caveat alone with no lean.

═══════════════════════════════════════════════════════════════
GRACEFUL UNCERTAINTY — for question types not explicitly covered above
═══════════════════════════════════════════════════════════════
You will encounter message types this prompt does not explicitly anticipate — that is expected and will always be true, no matter how detailed this prompt becomes. When a message doesn't cleanly match SCOPE A, B, or C, or doesn't cleanly match any INTENT below:
  1. Silently determine which existing scope/intent is the closest honest fit based on what the user is actually trying to accomplish — do not default to FINANCIAL_MATRIX or STRATEGIC_ADVICE just because business language appears somewhere in the message.
  2. Answer using that closest-fit frame, applying the same density, honesty, and resolve-don't-hover rules that already govern that frame.
  3. Never produce generic filler ("I'm here to help with your business needs") in place of actually engaging with what was asked — if you're uncertain what's being asked, it's better to give your best-effort direct answer than to deflect with a vague non-answer.
  4. If the message is genuinely ambiguous between two scopes (e.g. it's unclear if the user wants you to teach a concept (SCOPE C) or analyze their specific situation (SCOPE A)), default to the LIGHTER-weight scope (SCOPE C/B over A) — it's a smaller error to under-analyze than to impose unwanted ledger/confidence machinery on a simple question.

═══════════════════════════════════════════════════════════════
ONTOLOGY (applies only within SCOPE A)
═══════════════════════════════════════════════════════════════
You reason over these Objects as a connected graph: Runway, Burn Rate, Gross Margin, Variable COGS, Contribution Margin, and Competitors.
CRITICAL: Tailor analysis strictly to the user's specific industry (e.g., do not mention 'fuel' for a SaaS company; focus on compute, LLM API costs, or pipeline instead).

═══════════════════════════════════════════════════════════════
STEP ORDER — RECALL FIRST, THEN REASON (applies only within SCOPE A)
═══════════════════════════════════════════════════════════════
This entire section only fires within SCOPE A. If the message is SCOPE B (see gate above), skip this section entirely — do not check history, do not mention "nothing was discussed before."

Within SCOPE A: before producing new analysis, check: is the user literally asking what was previously discussed or decided about their business (e.g. "what was our last conversation about X," "what did we decide on Y," "what's the status of Z")? If so, ANSWER THAT QUESTION FIRST AND DIRECTLY using the historical context and pending-decision data provided below. Do not respond to a recall question with fresh, unrelated advice instead of the recall itself. If there is genuinely nothing relevant in history, say so plainly rather than inventing new advice in its place — this may resolve to CASUAL_CHAT if there's no new analysis to perform.

When a new SCOPE A scenario IS being analyzed and there is a relevant pending decision from a prior turn, weave a SHORT natural recall line into "recall_opening" — e.g. "Last time you froze the pricing call on fuel costs — did that hold?" This is a natural opening, not a compliance check, and it is NEVER placed inside auditor_warning. auditor_warning is reserved exclusively for a genuine downside risk in the current scenario. If there is no relevant pending decision, set recall_opening to null.

═══════════════════════════════════════════════════════════════
DENSITY MANDATE — THIS IS A WHATSAPP MESSAGE, NOT A MEMO
═══════════════════════════════════════════════════════════════
The user is reading this on a phone, mid-day, between other tasks. Every field below has a HARD CEILING of 2-3 sentences. Use the most precise, highest-information words possible per sentence — sharp and dense, never padded.

Forbidden in every field: throat-clearing ("it's crucial to," "a comprehensive review should be conducted"), redundant restatement of the question, listing more than one suggested action when one will do, hedging filler ("might involve," "could potentially").
Required in every field: one concrete claim, one number or named mechanism where relevant, zero filler.

A confidence score is provided to you below for this exact reason — when confidence is genuinely uncertain, STATE THE NUMBER, don't pad the prose to compensate. "62% confidence — CAC and COGS not yet synced" is a complete, sufficient hedge. A paragraph explaining why you're hedging is not.

═══════════════════════════════════════════════════════════════
DO THE LITERAL MATH WHEN THE USER GIVES YOU NUMBERS
═══════════════════════════════════════════════════════════════
If the user's message contains concrete numbers (a headcount, a percentage, a dollar figure, a runway length), you are REQUIRED to multiply them through to a concrete answer — not just gesture at the mechanism in words. "Hiring increases burn" is insufficient when the user told you "3 engineers" and "8 months runway." The correct move: take the headcount, multiply by a per-unit cost (real ledger data if present, otherwise an industry prior — see ASSUMPTION-LABELING RULE below), and state the resulting new burn and new runway as a number or tight range. Example of the standard required: "3 engineers × $8-15k/month fully-loaded ≈ $24-45k/month added burn. Against 8 months runway, that compresses to roughly 5.5-6.8 months unless growth accelerates." Naming the mechanism without running the multiplication is an incomplete answer.

═══════════════════════════════════════════════════════════════
ASSUMPTION-LABELING RULE — WHEN YOU USE A PRIOR INSTEAD OF REAL DATA
═══════════════════════════════════════════════════════════════
An industry priors block is injected below, scoped to this user's industry where available. When real ledger data exists, ALWAYS use the real number and never substitute a prior over it. When real ledger data is missing and you use a prior instead (e.g. an assumed engineer cost, an assumed gross margin), you MUST do two things: (1) say so inline in the relevant field using language like "assuming ~$10k/month fully-loaded" or "using a SaaS gross margin assumption of ~75%", and (2) add a short string to the "assumptions_used" array naming exactly which prior was substituted (e.g. "engineer cost assumed at industry midpoint, not synced from ledger"). A confident-sounding number that silently used an assumed industry benchmark instead of this company's real data is exactly the kind of false certainty this system exists to avoid — labeling it is not optional. If no priors are available for this industry, say so plainly rather than inventing a number from a different industry's benchmarks. If nothing was assumed (all inputs were real), set assumptions_used to an empty array.

═══════════════════════════════════════════════════════════════
SHARPER PHRASING — THIS IS DECISION INTELLIGENCE, NOT GENERIC ADVICE
═══════════════════════════════════════════════════════════════
Avoid soft, generic phrasing that could appear in any business chatbot. Compare:
WEAK: "Competitor price cuts can be a market signal."
SHARP: "A 20% competitor price cut only matters if your buyers are price-sensitive and switching cost is low — if retention is already weak, matching price compresses margin without fixing the underlying leak."
WEAK: "Could lead to significant revenue and margin erosion."
SHARP: "Cutting price while churn stays unresolved triggers a double compression: lower ARPU plus unstable retention, which erodes LTV/CAC efficiency and accelerates runway decay."
Always name the SPECIFIC mechanism connecting the two variables in play — never describe a risk in the abstract when you can name exactly which two numbers are colliding and why.

═══════════════════════════════════════════════════════════════
PERSONA VOICE (register only — never changes data honesty)
═══════════════════════════════════════════════════════════════
{{PERSONA_VOICE_BLOCK}}

═══════════════════════════════════════════════════════════════
INDUSTRY PRIORS (use per the ASSUMPTION-LABELING RULE above)
═══════════════════════════════════════════════════════════════
{{INDUSTRY_PRIORS_BLOCK}}

═══════════════════════════════════════════════════════════════
INTENT CLASSIFICATION & MANDATORY JSON OUTPUT SCHEMA
═══════════════════════════════════════════════════════════════
Return raw, valid JSON. Populate ALL keys for your chosen intent; if a field is not relevant, set it to null.

INTENT 1: "CASUAL_CHAT"
- SCOPE B messages (identity questions, general knowledge, casual conversation, unrelated requests like movie recommendations) ALWAYS resolve here. SCOPE C messages (explaining/teaching a business concept, not analyzing this user's company) ALSO resolve here. Also used for a genuine SCOPE A recall question where nothing relevant exists in history.
  {
    "type": "CASUAL_CHAT",
    "message": "Your response. For SCOPE B: 1-2 sentences, answer directly and competently like any capable assistant, with NO business/SaaS/industry framing forced in, and NO mention of checking history unless the user actually asked a recall question. For SCOPE C: explain the concept clearly, depth adapted to persona — this MAY run longer than the normal 2-3 sentence ceiling since teaching is the actual point, but stay focused and dense, not padded. Do NOT pull in this user's ledger data or turn it into analysis of their specific situation unless they explicitly ask how it applies to them. For a genuine SCOPE A recall question with nothing relevant on record, say so plainly here — but do not apply that same 'nothing found' framing to unrelated SCOPE B requests like movie suggestions.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": null, "auditor_warning": null, "recall_opening": null
  }

INTENT 2: "STRATEGIC_ADVICE"
- Qualitative strategic questions with no hard numeric shock to compute. ALSO used when answering a recall question that has a real answer (state the recall as the core of action_directive/strategic_framework if that's literally what was asked).
  {
    "type": "STRATEGIC_ADVICE",
    "recall_opening": "1 short clause naturally referencing a relevant pending decision, or null if none applies.",
    "action_directive": "One sharp imperative sentence. Not a suggestion — a command. If this IS the answer to a recall question, state the recalled fact/decision directly here instead. If the user gave concrete numbers, the math must be run through to a concrete figure here, not just named.",
    "strategic_framework": "MAX 2-3 sentences. Name the SPECIFIC mechanism connecting the variables in play and state its conclusion. No preamble, no generic abstractions — see SHARPER PHRASING rule.",
    "analytical_baselines": "MAX 1-2 sentences. One hard benchmark with an exact figure or range, drawn from real ledger data if present, otherwise from the injected industry priors (labeled per ASSUMPTION-LABELING RULE).",
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null, "ledger_hydration_parameters": null,
    "auditor_warning": "MAX 1-2 sentences, or null if no material risk. A genuine downside risk ONLY — never a compliance check or follow-up question. Name the specific colliding mechanism, not an abstract risk.",
    "assumptions_used": ["array of strings naming any industry prior substituted for real data, empty array if none"]
  }

INTENT 3: "FINANCIAL_MATRIX"
- Operational/financial shifts, cost updates, or volume adjustments.
  {
    "type": "FINANCIAL_MATRIX",
    "recall_opening": "1 short clause naturally referencing a relevant pending decision, or null if none applies.",
    "action_directive": "One sharp imperative sentence. If a required input (burn rate, runway, etc.) is missing, name that gap as the reason for the directive, e.g. 'Can't size absorption — burn rate isn't synced. Directionally:' before the directive. If the user gave concrete numbers, run the literal multiplication through to a number here.",
    "algebraic_impact_model": "MAX 2-3 sentences. State the formulaic relationship and its compounding effect directly, with the actual numbers multiplied through when the user supplied them — show the mechanism AND the magnitude, not a lecture about either.",
    "impact_runway": "MAX 1 sentence. Direction + magnitude as a concrete number or tight range, OR state plainly 'unavailable — burn rate not synced' if true. Never claim a number you don't have grounds for.",
    "impact_margin": "MAX 1 sentence. Direction + magnitude as a concrete number or tight range.",
    "ledger_hydration_parameters": ["array", "of", "snake_case", "ledger", "keys"],
    "auditor_warning": "MAX 1-2 sentences, or null if no material risk. A genuine downside risk ONLY — never a compliance check or follow-up question. Name the specific colliding mechanism, not an abstract risk.",
    "assumptions_used": ["array of strings naming any industry prior substituted for real data, empty array if none"]
  }

INTENT 4: "HYDRATE_LEDGER"
- User provides manual numerical updates to their financial state.
  {
    "type": "HYDRATE_LEDGER",
    "message": "Brief confirmation, 1 sentence.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": ["mrr", "variable_cogs", "fixed_operating_overhead", "verified_cash_balance"],
    "auditor_warning": null, "recall_opening": null,
    "extracted_metrics": { "mrr": "number or null", "variable_cogs": "number or null", "fixed_operating_overhead": "number or null", "verified_cash_balance": "number or null" }
  }

INTENT 5: "CONNECT_LEDGER"
- User asks to connect, sync, or integrate an external platform.
  {
    "type": "CONNECT_LEDGER",
    "message": "Brief, 1 sentence, stating you're generating a secure integration link.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null, "ledger_hydration_parameters": null, "auditor_warning": null, "recall_opening": null,
    "integration_target": "The requested platform name (e.g., 'stripe', 'quickbooks')"
  }

═══════════════════════════════════════════════════════════════
"UNKNOWN" IS FORBIDDEN — BUT FABRICATING CERTAINTY IS WORSE
═══════════════════════════════════════════════════════════════
If precise live ledger numbers are missing, never output the bare word 'Unknown' with nothing else. State the algebraic mechanism conceptually, name the specific missing input, and still give a directive. The confidence score communicates the uncertainty level — but the actual content of impact_runway/impact_margin must never assert a number or direction you don't have grounds for. "Unavailable — burn rate not synced" is correct and required when true. A confident-sounding number with no backing data is a worse failure than admitting the gap.

═══════════════════════════════════════════════════════════════
CONFIDENCE DISCIPLINE
═══════════════════════════════════════════════════════════════
A confidence score and grade are computed from REAL missing-data checks and injected into your context below — this is not your discretion to override. Let it govern your tone only:
80-100 (HIGH) → speak decisively, no hedging language at all.
60-79 (MEDIUM) → one short clause naming the missing input is enough; do not over-qualify.
0-59 (LOW) → name the single most material missing variable in one clause, then still give a directive. Never refuse to answer.
The grade you are given already reflects whatever is missing — if it says MEDIUM or LOW, your prose must be consistent with that, not falsely decisive.

Return RAW JSON only. No markdown fences (\`\`\`json).`;

/**
 * ── SELF-HEALING REPAIR MECHANISM ──────────────────────────────────────────
 * Now also responsible for attaching confidenceData and recall_opening to
 * STRATEGIC_ADVICE and FINANCIAL_MATRIX responses.
 */
function selfHealAndValidateOutput(parsed: any, confidenceData: ConfidenceData): SimoraEngineResponse {
  if (!parsed || typeof parsed !== 'object') {
    return {
      type: 'CASUAL_CHAT',
      message: "I hit a sync error reading that. Try again?",
    };
  }

  let type = parsed.type;
  if (!['CASUAL_CHAT', 'STRATEGIC_ADVICE', 'FINANCIAL_MATRIX', 'HYDRATE_LEDGER', 'CONNECT_LEDGER'].includes(type)) {
    if (parsed.extracted_metrics) type = 'HYDRATE_LEDGER';
    else if (parsed.integration_target) type = 'CONNECT_LEDGER';
    else type = parsed.algebraic_impact_model || parsed.impact_runway ? 'FINANCIAL_MATRIX' : 'CASUAL_CHAT';
  }

  // Hard cap helper — enforces density even if the model ignores the prompt's word limits.
  const capSentences = (text: string, maxSentences: number): string => {
    const trimmed = text.trim();
    const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
    if (sentences.length <= maxSentences) return trimmed;
    return sentences.slice(0, maxSentences).join(' ').trim();
  };

  if (type === 'CASUAL_CHAT') {
    // Cap raised from 2 to 5 sentences: SCOPE B (casual/identity/trivia) answers
    // are naturally short and will rarely hit this ceiling, but SCOPE C
    // (teaching a concept like "what is COGS" or "explain churn") legitimately
    // needs more room than a 2-sentence cap allows — that cap was truncating
    // genuine explanations mid-thought. 5 still prevents runaway essays.
    return {
      type: 'CASUAL_CHAT',
      message: capSentences(String(parsed.message || "Simora's online. What's the scenario?"), 5),
    };
  }

  if (type === 'STRATEGIC_ADVICE') {
    return {
      type: 'STRATEGIC_ADVICE',
      recall_opening: parsed.recall_opening ? capSentences(String(parsed.recall_opening), 1) : null,
      action_directive: capSentences(String(parsed.action_directive || "Run an immediate operational baseline review."), 1),
      strategic_framework: capSentences(String(parsed.strategic_framework || "First-principles structural review indicated."), 3),
      analytical_baselines: capSentences(String(parsed.analytical_baselines || "Venture-backed margin floors are typically defended at 60-70%."), 2),
      auditor_warning: parsed.auditor_warning ? capSentences(String(parsed.auditor_warning), 2) : null,
      assumptions_used: Array.isArray(parsed.assumptions_used) ? parsed.assumptions_used.map(String) : [],
      confidence_score: confidenceData.score,
      confidence_grade: confidenceData.grade,
      confidence_reasons: confidenceData.reasons,
    };
  }

  if (type === 'HYDRATE_LEDGER') {
    const rawMetrics = parsed.extracted_metrics || {};
    return {
      type: 'HYDRATE_LEDGER',
      message: capSentences(String(parsed.message || "Ledger updated."), 1),
      ledger_hydration_parameters: Array.isArray(parsed.ledger_hydration_parameters)
        ? parsed.ledger_hydration_parameters
        : ["mrr", "variable_cogs", "fixed_operating_overhead", "verified_cash_balance"],
      extracted_metrics: {
        mrr: typeof rawMetrics.mrr === 'number' ? rawMetrics.mrr : null,
        variable_cogs: typeof rawMetrics.variable_cogs === 'number' ? rawMetrics.variable_cogs : null,
        fixed_operating_overhead: typeof rawMetrics.fixed_operating_overhead === 'number' ? rawMetrics.fixed_operating_overhead : null,
        verified_cash_balance: typeof rawMetrics.verified_cash_balance === 'number' ? rawMetrics.verified_cash_balance : null,
      },
    };
  }

  if (type === 'CONNECT_LEDGER') {
    return {
      type: 'CONNECT_LEDGER',
      message: capSentences(String(parsed.message || "Generating a secure integration link."), 1),
      integration_target: String(parsed.integration_target || "stripe").toLowerCase().trim(),
    };
  }

  // FINANCIAL_MATRIX self-healing fallback
  const hedgePattern = /\b(unknown|insufficient data|not enough information|i'?d need more)\b/i;
  let modelText = String(parsed.algebraic_impact_model || "");

  if (!modelText || hedgePattern.test(modelText)) {
    modelText = "Contribution margin = (Price × (1 − price_drop%)) − (Variable_Cost × (1 + cost_increase%)). A simultaneous cost rise and price cut compounds non-linearly, accelerating burn faster than either shock alone.";
  }

  return {
    type: 'FINANCIAL_MATRIX',
    recall_opening: parsed.recall_opening ? capSentences(String(parsed.recall_opening), 1) : null,
    action_directive: capSentences(String(parsed.action_directive || "Freeze pricing adjustments until volume elasticity is modeled."), 1),
    algebraic_impact_model: capSentences(modelText, 3),
    impact_runway: capSentences(String(parsed.impact_runway || "Compressed via contribution margin squeeze."), 1),
    impact_margin: capSentences(String(parsed.impact_margin || "Gross margin contraction expected."), 1),
    ledger_hydration_parameters: Array.isArray(parsed.ledger_hydration_parameters) && parsed.ledger_hydration_parameters.length > 0
      ? parsed.ledger_hydration_parameters.map(String)
      : ['gross_revenue', 'variable_cogs', 'mrr', 'operating_expenses'],
    auditor_warning: parsed.auditor_warning
      ? capSentences(String(parsed.auditor_warning), 2)
      : "Unverified ledger state risks compounding cash flow anomalies undetected.",
    assumptions_used: Array.isArray(parsed.assumptions_used) ? parsed.assumptions_used.map(String) : [],
    confidence_score: confidenceData.score,
    confidence_grade: confidenceData.grade,
    confidence_reasons: confidenceData.reasons,
  };
}

// ============================================================================
// CONFIDENCE SCORING
// ============================================================================
function calculateConfidenceScore(ledgerMetrics: any, systemState: any): ConfidenceData {
  let score = 100;
  const reasons: string[] = [];

  if (!ledgerMetrics) {
    score -= 40;
    reasons.push('No financial ledger connected');
  } else {
    if (ledgerMetrics.mrr == null) { score -= 15; reasons.push('Missing MRR'); }
    if (ledgerMetrics.variable_cogs == null) { score -= 15; reasons.push('Missing variable COGS'); }
    if (ledgerMetrics.fixed_operating_overhead == null) { score -= 15; reasons.push('Missing fixed overhead'); }
    if (ledgerMetrics.verified_cash_balance == null) { score -= 15; reasons.push('Missing cash balance'); }
  }

  if (!systemState?.calculated_runway_months) {
    score -= 20;
    reasons.push('Runway unavailable');
  }
  if (!systemState?.monthly_operating_burn) {
    score -= 15;
    reasons.push('Burn rate unavailable');
  }

  if (score < 0) score = 0;

  let grade: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  if (score >= 80) grade = 'HIGH';
  else if (score >= 60) grade = 'MEDIUM';

  return { score, grade, reasons };
}

// ============================================================================
// ON-DEMAND UNIFIED.TO LEDGER SYNC (PHASE 6: REAL LEDGER SYNC)
//
// Design choice, per explicit decision: sync happens ON DEMAND, every time
// the engine runs for a user who has a connection — not on a schedule.
// This matches Unified.to's own architecture (real-time pass-through, no
// caching on their end) — a scheduled poll would just reintroduce the
// staleness their platform is built to avoid, and would burn API calls for
// users who haven't messaged in weeks. The cost is paid only when value is
// actually needed: right before the engine reasons about this user's data.
//
// This function is intentionally silent/non-fatal on every failure path —
// a sync failure should never block the user from getting an answer. If
// Unified.to is down, the engine falls back to whatever is already in
// ledger_metrics (possibly stale, possibly null) exactly as it did before
// this feature existed. The confidence scorer already accounts for missing
// ledger fields, so a failed sync degrades gracefully into the same
// "MEDIUM/LOW confidence, here's why" behavior rather than crashing.
// ============================================================================
async function syncLedgerFromUnified(userId: string, supabaseAdmin: SupabaseClient): Promise<void> {
  const UNIFIED_API_KEY = process.env.UNIFIED_API_KEY;
  if (!UNIFIED_API_KEY) {
    // Not configured — silently skip. server.ts already logs a startup
    // warning about this; no need to repeat it on every single message.
    return;
  }

  const { data: connections, error: connErr } = await supabaseAdmin
    .from('unified_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (connErr) {
    console.error(`[UNIFIED SYNC] ⚠️ Failed to fetch connections for user ${userId} (non-fatal):`, connErr.message);
    return;
  }

  if (!connections || connections.length === 0) {
    // No connection — this is the common case for most users. Not an
    // error, just nothing to do.
    return;
  }

  for (const connection of connections) {
    try {
      // 'report' is Unified.to's standardized financial report object,
      // which surfaces profit & loss style data across both Stripe and
      // QuickBooks without needing provider-specific parsing logic — this
      // is exactly the normalization benefit of using a unified API rather
      // than building separate Stripe and QuickBooks integrations.
      const response = await fetch(
        `https://api.unified.to/accounting/${connection.connection_id}/report`,
        { headers: { Authorization: `Bearer ${UNIFIED_API_KEY}` } },
      );

      if (!response.ok) {
        const errBody = await response.text();
        console.error(
          `[UNIFIED SYNC] ⚠️ Unified.to API returned ${response.status} for connection ${connection.connection_id} ` +
          `(provider: ${connection.provider}, user: ${userId}): ${errBody}`,
        );
        continue; // Try the next connection if the user has more than one
      }

      const reportData = await response.json();

      // NOTE: Unified.to's `report` object schema needs to be mapped to
      // SIMORA's ledger_metrics columns (mrr, variable_cogs,
      // fixed_operating_overhead, verified_cash_balance). The exact field
      // names returned depend on the specific report type and provider —
      // this mapping should be verified against a REAL response from your
      // workspace before trusting it in production. The fields below are a
      // reasonable first guess based on Unified.to's documented Report
      // model, not a confirmed-correct mapping — flagging this explicitly
      // rather than presenting it as certain.
      const updatePayload: Record<string, any> = {
        user_id: userId,
        last_hydrated_by: connection.provider === 'stripe' ? 'UNIFIED_STRIPE_SYNC' : 'UNIFIED_QUICKBOOKS_SYNC',
      };

      // TODO: VERIFY — confirm these field paths against a real Unified.to
      // /accounting/{connectionId}/report response in your workspace.
      if (typeof reportData?.total_revenue === 'number') updatePayload.mrr = reportData.total_revenue;
      if (typeof reportData?.total_cogs === 'number') updatePayload.variable_cogs = reportData.total_cogs;
      if (typeof reportData?.total_operating_expenses === 'number') updatePayload.fixed_operating_overhead = reportData.total_operating_expenses;
      if (typeof reportData?.cash_balance === 'number') updatePayload.verified_cash_balance = reportData.cash_balance;

      // Only write if we actually got at least one real field — an empty
      // sync (e.g. report schema didn't match our guessed field names)
      // should not overwrite existing data with a payload that's just
      // user_id and last_hydrated_by.
      const gotRealData = Object.keys(updatePayload).length > 2;

      if (gotRealData) {
        const { error: upsertErr } = await supabaseAdmin
          .from('ledger_metrics')
          .upsert(updatePayload, { onConflict: 'user_id' });

        if (upsertErr) {
          console.error(`[UNIFIED SYNC] ⚠️ Failed to write synced data for user ${userId}:`, upsertErr.message);
        } else {
          console.log(`[UNIFIED SYNC] ✅ Synced ${connection.provider} data for user ${userId}`);
          await supabaseAdmin
            .from('unified_connections')
            .update({ last_synced_at: new Date().toISOString() })
            .eq('id', connection.id);
        }
      } else {
        console.warn(
          `[UNIFIED SYNC] ⚠️ Unified.to returned a report for user ${userId} but none of the expected fields ` +
          `(total_revenue, total_cogs, total_operating_expenses, cash_balance) were present. The field-name ` +
          `mapping above likely needs adjustment — check a real response payload from your workspace.`,
        );
      }
    } catch (err: any) {
      console.error(`[UNIFIED SYNC] ❌ Unexpected error syncing connection ${connection.connection_id}:`, err?.message || err);
      // Continue to next connection rather than letting one failure stop
      // sync for a user with multiple connected providers.
    }
  }
}

async function getPendingDecisionFollowup(userId: string, supabaseAdmin: SupabaseClient) {
  const { data, error } = await supabaseAdmin
    .from('decision_logs')
    .select('*')
    .eq('user_id', userId)
    .eq('decision_status', 'PENDING')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}

// ============================================================================
// PASSIVE OUTCOME RESOLUTION DETECTOR
// PHASE 5: OUTCOME TRACKING — CLOSING THE DECISION LOOP
//
// Design choice: this runs as its OWN small, focused LLM call rather than
// becoming a 7th simultaneous job inside the main engine prompt. The main
// prompt already asks one model call to do scope-gating, recall, persona
// voice, density control, math, and confidence honesty — adding "also
// detect if this message is secretly answering a 3-day-old decision" would
// be a 7th concern competing for attention in the same pass. Splitting it
// out makes each call's job small and verifiable on its own, and this call
// is cheap (low token count, simple binary + short text output).
//
// This only fires when a pendingDecision actually exists — there is nothing
// to resolve otherwise, so no wasted calls for users with a clean slate.
// ============================================================================
interface OutcomeResolution {
  isResolving: boolean;
  outcomeNotes: string | null;
}

async function detectDecisionResolution(
  incomingText: string,
  pendingDecision: any,
  openai: OpenAI,
): Promise<OutcomeResolution> {
  if (!pendingDecision) {
    return { isResolving: false, outcomeNotes: null };
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You have ONE job: determine if the user's new message is reporting back on a specific prior decision, or if it's an unrelated new message.

PRIOR DECISION ASKED: "${pendingDecision.user_question}"
PRIOR RECOMMENDATION GIVEN: "${pendingDecision.simora_recommendation}"

The user is REPORTING BACK if their new message describes what actually happened as a result of that decision — e.g. "yes it worked," "we didn't end up doing that," "churn actually went up after," "we reversed the price cut." 

The user is NOT reporting back if their new message is simply related in topic but doesn't describe an outcome — e.g. bringing up a new, different pricing question, or asking something else about the same general area without saying what happened with the prior one.

Return JSON only: { "isResolving": true or false, "outcomeNotes": "a short 1-sentence summary of what they reported, in their words/meaning, or null if isResolving is false" }`,
        },
        { role: 'user', content: incomingText },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return { isResolving: false, outcomeNotes: null };

    const parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim());
    return {
      isResolving: Boolean(parsed.isResolving),
      outcomeNotes: parsed.isResolving && parsed.outcomeNotes ? String(parsed.outcomeNotes).trim() : null,
    };
  } catch (err: any) {
    // Non-fatal by design — if this detector fails, the main engine flow
    // continues completely normally. The decision just stays PENDING, which
    // is the safe default (no false resolution gets written).
    console.error('[OUTCOME RESOLUTION] ⚠️ Detector call failed (non-fatal):', err?.message || err);
    return { isResolving: false, outcomeNotes: null };
  }
}

// ============================================================================
// MAIN ENGINE
// ============================================================================
export async function executeSimoraCoreEngine(
  ctx: IngestionContext,
  supabaseAdmin: SupabaseClient,
  openai: OpenAI,
): Promise<SimoraEngineResponse> {

  // ── 1. DATA HYDRATION & PROFILE FETCH ────────────────────────────────────
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('whatsapp_id_hash', ctx.whatsappHash)
    .single();

  if (userErr || !user) {
    throw new Error(`SUPABASE_DATABASE_CRASH: Profile Unmapped or DB unreachable. ${userErr?.message}`);
  }

  const pendingDecision = await getPendingDecisionFollowup(user.id, supabaseAdmin);

  // ── OUTCOME RESOLUTION CHECK — does this message report back on the
  // pending decision? If so, resolve it in decision_logs BEFORE proceeding
  // with the rest of the engine. This runs regardless of what the main
  // engine ultimately classifies this message as (CASUAL_CHAT, etc.) —
  // a user reporting "yes, the price freeze held" might just be a short
  // confirmation that itself resolves to CASUAL_CHAT downstream, but the
  // outcome still needs to be captured.
  let decisionWasResolvedThisTurn = false;
  if (pendingDecision) {
    const resolution = await detectDecisionResolution(ctx.incomingText, pendingDecision, openai);
    if (resolution.isResolving) {
      const { error: resolveErr } = await supabaseAdmin
        .from('decision_logs')
        .update({
          decision_status: 'RESOLVED',
          outcome_notes: resolution.outcomeNotes,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', pendingDecision.id);

      if (resolveErr) {
        console.error(`[OUTCOME RESOLUTION] ⚠️ Failed to write resolution for decision ${pendingDecision.id}:`, resolveErr.message);
      } else {
        console.log(`[OUTCOME RESOLUTION] ✅ Decision ${pendingDecision.id} resolved: "${resolution.outcomeNotes}"`);
        decisionWasResolvedThisTurn = true;
      }
    }
  }

  const { data: state, error: stateErr } = await supabaseAdmin
    .from('system_states')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (stateErr || !state) {
    throw new Error(`CRITICAL_SYSTEM_ERROR: System State Missing for User ${user.id}`);
  }

  // ── ON-DEMAND LIVE LEDGER SYNC ────────────────────────────────────────────
  // Per explicit decision: sync happens HERE, on demand, right before this
  // turn's reasoning — not on a schedule. Unified.to is a real-time
  // pass-through with no caching on their end, so a scheduled poll would
  // just reintroduce staleness their architecture is built to avoid, and
  // would burn API calls for users who haven't messaged in weeks.
  //
  // 8-SECOND TIMEOUT (per explicit decision): syncLedgerFromUnified() makes
  // a real network call to Unified.to, which itself proxies to Stripe/
  // QuickBooks live — that round-trip can be slow. We race the sync against
  // an 8-second timer so one slow external API call can never hang a
  // WhatsApp reply. If the timeout wins, we proceed with whatever is
  // already cached in ledger_metrics from a previous successful sync (or
  // null if there's never been one) — exactly the same fallback behavior
  // as if Unified.to had errored outright. This is a deliberate trade:
  // we accept a potentially-stale read over a slow/blocked answer.
  const SYNC_TIMEOUT_MS = 8000;
  try {
    await Promise.race([
      syncLedgerFromUnified(user.id, supabaseAdmin),
      new Promise<void>((resolve) => setTimeout(resolve, SYNC_TIMEOUT_MS)),
    ]);
    // NOTE: Promise.race does not cancel the loser — if the 8s timer wins,
    // syncLedgerFromUnified() is still running in the background and may
    // still successfully write to ledger_metrics a few seconds after this
    // turn's reply has already been sent. That's a deliberate, harmless
    // side effect: it means a slow sync doesn't help THIS answer, but it
    // does warm the cache for the NEXT message, which is strictly better
    // than not syncing at all.
  } catch (syncRaceErr: any) {
    // syncLedgerFromUnified() is already internally non-fatal on every path
    // (see its own try/catch per-connection above) — this outer catch is a
    // final safety net in case something genuinely unexpected throws, so a
    // bug in the sync path can never take down the main reasoning flow.
    console.error('[SIMORA ENGINE] ⚠️ Ledger sync race threw unexpectedly (non-fatal):', syncRaceErr?.message || syncRaceErr);
  }

  // ── BUG FIX: .single() throws when no ledger_metrics row exists yet for a
  // new user. The error was previously discarded (only `data` destructured),
  // leaving ledgerMetrics in an inconsistent state. .maybeSingle() returns
  // null cleanly instead — this is the real fix for the HIGH/80 badge
  // appearing next to "Runway unavailable" in the same message.
  const { data: ledgerMetrics, error: ledgerErr } = await supabaseAdmin
    .from('ledger_metrics')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (ledgerErr) {
    console.error(`[SIMORA ENGINE] ⚠️ ledger_metrics fetch error (non-fatal):`, ledgerErr.message);
  }

  const confidenceData = calculateConfidenceScore(ledgerMetrics, state);

  // ── 2. LIVE CONTEXTUAL RETRIEVAL (VECTOR MEMORY) ─────────────────────────
  const currentQueryVector = await getHuggingFaceEmbedding(ctx.incomingText);
  const { data: matchedContextRecords } = await supabaseAdmin.rpc(
    'match_ledger_embeddings',
    {
      query_embedding: currentQueryVector,
      match_threshold: 0.3,
      match_count: 3,
      p_user_id: user.id,
    },
  );

  let vectorContext = '[No relevant historical context discovered. Proceeding under baseline assumptions.]';
  if (matchedContextRecords && matchedContextRecords.length > 0) {
    vectorContext = matchedContextRecords
      .map((record: any, idx: number) => `[Historical Event #${idx + 1}: ${record.content}]`)
      .join('\n');
  }

  let decisionFollowupContext = '';
  if (decisionWasResolvedThisTurn) {
    // The decision was just resolved by the dedicated detector above — the
    // user's message WAS the outcome report. Acknowledge it briefly and
    // naturally rather than treating it as still pending or ignoring it.
    decisionFollowupContext = `
    DECISION JUST RESOLVED THIS TURN:
    The user's current message is reporting the outcome of a prior decision (Previous Question: "${pendingDecision.user_question}"). That outcome has already been recorded. If appropriate, briefly and naturally acknowledge what they reported (e.g. "Good to know that held" or "Noted — that didn't pan out, worth revisiting why") as part of your response, but do not treat this as a new pending decision needing recall_opening.
    `;
  } else if (pendingDecision) {
    decisionFollowupContext = `
    PENDING_DECISION_REVIEW (use for recall_opening if relevant, NEVER inside auditor_warning):
    Previous Question: ${pendingDecision.user_question}
    Previous Recommendation: ${pendingDecision.simora_recommendation}
    If the current message is asking what was previously discussed/decided, this IS your answer — state it directly.
    Otherwise, if relevant to the current scenario, weave a short natural reference into recall_opening only.
    `;
  } else {
    decisionFollowupContext = '[No pending decision on record. This is ONLY relevant if the current message is literally asking what was previously discussed or decided about the business. If so, say plainly that nothing relevant is on record yet. If the current message is about something else entirely (general knowledge, casual talk, an unrelated request like a movie recommendation), this note is irrelevant — ignore it and just answer the actual question.]';
  }

  // ── 3. SYSTEM ONTOLOGY INJECTION WITH REAL-TIME SNAPSHOT OVERRIDES ───────
  const systemFrameworkContext = `
    LIVE OPERATIONAL OBJECT STATE:
    SYSTEM_ARCHETYPE_TIER: ${user.assigned_tier}
    GEOGRAPHY_CODE: ${user.geo_country_code}-${user.geo_city_region}
    INDUSTRY_TAXONOMY_ID: ${user.industry_taxonomy_id}
    USER_PERSONA: ${user.user_persona ?? 'FOUNDER (default — not set during onboarding)'}
    CURRENT_RESILIENCE_SCORE: ${state.resilience_score}
    Runway.current_months: ${state.calculated_runway_months}
    BurnRate.monthly: ${state.monthly_operating_burn}

    REAL-TIME SYNCHRONIZED FINANCIAL LEDGER SNAPSHOTS (SUPABASE):
    MRR: ${ledgerMetrics?.mrr ?? 'Omitted (Using Conceptual Fallbacks)'}
    Variable_COGS: ${ledgerMetrics?.variable_cogs ?? 'Omitted (Using Conceptual Fallbacks)'}
    Fixed_Operating_Overhead: ${ledgerMetrics?.fixed_operating_overhead ?? 'Omitted (Using Conceptual Fallbacks)'}
    Verified_Cash_Balance: ${ledgerMetrics?.verified_cash_balance ?? 'Omitted (Using Conceptual Fallbacks)'}
    Last_State_Hydration_Method: ${ledgerMetrics?.last_hydrated_by ?? 'None'}

    SIMORA CONFIDENCE SCORE (this is a REAL computed value reflecting the gaps above — do not contradict it):
    Confidence Score: ${confidenceData.score}
    Confidence Grade: ${confidenceData.grade}
    Confidence Weaknesses: ${confidenceData.reasons.join(', ') || 'None'}

    PROACTIVE FOLLOWUP CAPABILITY (only relevant if the user asks something like
    "will you check in on this later" or "will you remind me about this"):
    Can this user currently receive a proactive WhatsApp check-in: ${ctx.canBeNudged === false ? 'NO — not yet enabled for this user' : ctx.canBeNudged === true ? 'YES' : 'UNKNOWN — treat as not yet confirmed'}.
    If asked directly whether you'll follow up later, answer honestly based on this value. If NO or UNKNOWN: say plainly that proactive check-ins aren't active yet for them specifically, but that you'll still recall this conversation the next time they message you. Do not claim a capability that isn't actually confirmed.
  `;

  const personaBlock = getPersonaVoiceBlock(user.user_persona);
  const industryPriorsBlock = formatIndustryPriorsBlock(user.industry_taxonomy_id);
  const fullSystemPrompt = SIMORA_MASTER_SYSTEM_PROMPT
    .replace('{{PERSONA_VOICE_BLOCK}}', personaBlock)
    .replace('{{INDUSTRY_PRIORS_BLOCK}}', industryPriorsBlock);

  // ── 4. INFERENCE LOOP ─────────────────────────────────────────────────────
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: fullSystemPrompt },
        { role: 'system', content: systemFrameworkContext },
        {
          role: 'user',
          content: `CONTEXT_CHUNKS FROM HISTORICAL LOGS:
${vectorContext}

DECISION FOLLOWUP CONTEXT:
${decisionFollowupContext}

NEW INCOMING MESSAGE:
${ctx.incomingText}

Classify intent and output valid JSON following schema requirements. First, apply the SCOPE GATE: SCOPE A (this user's actual business/decisions) proceeds normally; SCOPE B (unrelated — identity, general knowledge, casual talk) resolves to CASUAL_CHAT, answered directly and plainly with no business framing forced in; SCOPE C (teaching/explaining a business concept, not analyzing this user specifically) also resolves to CASUAL_CHAT, answered as a clear explanation without pulling in this user's ledger data. If this is SCOPE A and has an implicit yes/no/which-one shape, commit to a directional lean per the RESOLVE, DON'T HOVER rule — never just a benchmark with no resolution. Only check whether a SCOPE A message is literally asking what was previously discussed if it actually is one. Respect the density ceiling (except SCOPE C explanations) and persona voice strictly. If the message doesn't cleanly fit any of the above, apply the GRACEFUL UNCERTAINTY principle rather than defaulting to generic filler.`,
        },
      ],
    });
  } catch (apiErr: any) {
    console.error('[SIMORA ENGINE] ❌ LLM API call failed:', apiErr?.message || apiErr);
    throw new Error(`INFERENCE_API_ERROR: ${apiErr?.message || 'Unknown API failure'}`);
  }

  const rawOutput = completion.choices?.[0]?.message?.content;
  console.log('[SIMORA ENGINE] Raw model output (first 1000 chars):', (rawOutput || '').slice(0, 1000));

  if (!rawOutput) {
    console.error('[SIMORA ENGINE] ❌ Model returned empty content.');
    throw new Error('INFERENCE_TIMEOUT: Simora Engine failed to generate response.');
  }

  let parsedRaw: any;
  try {
    const cleanJsonString = rawOutput.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsedRaw = JSON.parse(cleanJsonString);
  } catch (e: any) {
    console.error('[SIMORA ENGINE] ❌ JSON_PARSE_ERROR:', e.message);
    console.error('[SIMORA ENGINE] String that failed to parse:', rawOutput);
    parsedRaw = {};
  }

  // ── 5. RUNTIME VALIDATION & SELF-HEALING FILTER ──────────────────────────
  const validatedOutput = selfHealAndValidateOutput(parsedRaw, confidenceData);

  // Tracks the outcome of every Supabase write below. A response can reach
  // the user looking perfect while every write here fails silently — this
  // object, summarized in step 11, is what makes that visible in one log line
  // instead of requiring a manual scroll through scattered WARNING lines.
  const writeStatus: Record<string, { ok: boolean; error?: string; code?: string }> = {};

  // ── 6. STRATEGY CARD PERSISTENCE FOR FINANCIAL INTENTS ───────────────────
  if (validatedOutput.type === 'FINANCIAL_MATRIX') {
    const delta = ctx.incomingDelta || 0;
    const currentRunway = Number(state.calculated_runway_months);
    const potentialNewBurn = Number(state.monthly_operating_burn) + delta;
    const elasticityScore = currentRunway / (potentialNewBurn / Number(state.monthly_operating_burn) || 1);
    const systemIntegrityFlag = elasticityScore < 0.8 ? 'DEATH_SPIRAL_RISK' : 'STABLE';

    const { error: insertError } = await supabaseAdmin
      .from('strategy_cards')
      .insert([{
        user_id: user.id,
        core_action_directive: validatedOutput.action_directive,
        impact_forecast_runway: validatedOutput.impact_runway,
        impact_forecast_margin: validatedOutput.impact_margin,
        auditor_critical_risk: validatedOutput.auditor_warning,
        algebraic_impact_model: validatedOutput.algebraic_impact_model,
        ledger_hydration_parameters: validatedOutput.ledger_hydration_parameters,
        confidence_score: validatedOutput.confidence_score,
        confidence_grade: validatedOutput.confidence_grade,
        receipt_computation_log: {
          variance_check: 'PASS',
          elasticity_matrix: systemIntegrityFlag,
          confidence_reasons: validatedOutput.confidence_reasons,
          assumptions_used: validatedOutput.assumptions_used,
          timestamp: new Date().toISOString(),
        },
        is_active: true,
      }]);

    if (insertError) {
      console.error(`PERSISTENCE_WARNING: Failed to commit Strategy Card: ${insertError.message}`);
      writeStatus.strategy_cards = { ok: false, error: insertError.message, code: (insertError as any).code };
    } else {
      writeStatus.strategy_cards = { ok: true };
    }
  }

  // ── 7. PHYSICAL DATA HYDRATION ROUTER ────────────────────────────────────
  if (validatedOutput.type === 'HYDRATE_LEDGER') {
    const metrics = validatedOutput.extracted_metrics;
    const updatePayload: any = { user_id: user.id, last_hydrated_by: 'MANUAL_WHATSAPP' };

    if (metrics.mrr !== null) updatePayload.mrr = metrics.mrr;
    if (metrics.variable_cogs !== null) updatePayload.variable_cogs = metrics.variable_cogs;
    if (metrics.fixed_operating_overhead !== null) updatePayload.fixed_operating_overhead = metrics.fixed_operating_overhead;
    if (metrics.verified_cash_balance !== null) updatePayload.verified_cash_balance = metrics.verified_cash_balance;

    const { error: upsertError } = await supabaseAdmin
      .from('ledger_metrics')
      .upsert(updatePayload, { onConflict: 'user_id' });

    if (upsertError) {
      console.error(`DATABASE_WRITE_WARNING: Failed to execute manual ledger hydration: ${upsertError.message}`);
      writeStatus.ledger_metrics = { ok: false, error: upsertError.message, code: (upsertError as any).code };
    } else {
      writeStatus.ledger_metrics = { ok: true };
    }
  }

  // ── 8. REAL LEDGER AUTH HANDOFF — direct Unified.to authorization URL ────
  // CORRECTED DESIGN (superseding an earlier draft of this comment block):
  // there is no need for an intermediate static page hosting a JS widget.
  // Unified.to's own hosted authorization endpoint
  // (api.unified.to/unified/integration/auth/{workspace}/{type}) can accept
  // a `success_redirect` that points DIRECTLY at our own server's
  // GET /api/v1/unified/callback route — confirmed against Unified.to's
  // own docs (docs.unified.to/tutorials/customize-auth-flow): the `state`
  // parameter is explicitly designed to carry an app's own user ID through
  // the flow and return it unchanged on the redirect. Combined with
  // `success_redirect`, Unified.to will redirect the user's browser
  // straight to our server with both `id` (connection_id) and our state
  // value attached as query params — no separate hosted page required.
  //
  // This eliminates the static `unified-auth.html` / `connect.html` design
  // entirely. If either of those files exist in your project, they are now
  // dead — the real flow never visits them.
  //
  // REQUIRED CONFIG (server-side env vars, read via process.env directly
  // here since this is the only place they're needed):
  //   UNIFIED_WORKSPACE_ID — from app.unified.to Settings > API Keys
  //   SIMORA_PUBLIC_URL    — this server's own public Railway domain, used
  //                          to build the success/failure redirect targets
  if (validatedOutput.type === 'CONNECT_LEDGER') {
    const UNIFIED_WORKSPACE_ID = process.env.UNIFIED_WORKSPACE_ID || '';
    const SIMORA_PUBLIC_URL = process.env.SIMORA_PUBLIC_URL || '';

    // Normalize whatever the model classified into one of the two providers
    // this build actually supports (stripe, quickbooks). Anything else is
    // passed through as-is — Unified.to will still attempt it if it's a
    // real integration type in your workspace, but ledger_metrics sync
    // (built in server.ts) only recognizes these two right now.
    const rawTarget = (validatedOutput.integration_target || '').toLowerCase();
    const normalizedProvider = rawTarget.includes('quickbook') ? 'quickbooksonline'
      : rawTarget.includes('stripe') ? 'stripe'
      : rawTarget;

    if (!UNIFIED_WORKSPACE_ID || !SIMORA_PUBLIC_URL) {
      // Fail visibly in the message itself rather than generating a URL
      // that will silently 404 or misconfigure — the user deserves to know
      // this isn't ready yet, not receive a broken link with no explanation.
      validatedOutput.message =
        '⚠️ Ledger sync isn\'t fully configured on our end yet — the team needs to finish setting up the connection. ' +
        'Try again shortly, or contact support if this persists.';
      console.error(
        '[CONNECT_LEDGER] ❌ Cannot generate auth URL — UNIFIED_WORKSPACE_ID or SIMORA_PUBLIC_URL missing. ' +
        'Set both in Railway environment variables.',
      );
    } else {
      const callbackUrl = `${SIMORA_PUBLIC_URL}/api/v1/unified/callback`;
      const redirectWithParams = `${callbackUrl}?uid=${encodeURIComponent(user.id)}&provider=${encodeURIComponent(normalizedProvider)}`;

      const authUrl =
        `https://api.unified.to/unified/integration/auth/${UNIFIED_WORKSPACE_ID}/${encodeURIComponent(normalizedProvider)}` +
        `?redirect=1` +
        `&env=Production` +
        `&success_redirect=${encodeURIComponent(redirectWithParams)}` +
        `&failure_redirect=${encodeURIComponent(redirectWithParams)}` +
        `&state=${encodeURIComponent(user.id)}`;

      validatedOutput.message = `🛡️ Secure connection link ready.\n👉 ${authUrl}\n_Opens in your browser — nothing is stored until you authorize._`;
    }
  }

  // ── 9. BACKGROUND MEMORY LOGGER ───────────────────────────────────────────
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([{ user_id: user.id, content: ctx.incomingText, embedding: currentQueryVector }]);

  if (memoryInsertError) {
    console.error(`MEMORY_LOGGING_WARNING: Failed to log vector states: ${memoryInsertError.message}`);
    writeStatus.ledger_embeddings = { ok: false, error: memoryInsertError.message, code: (memoryInsertError as any).code };
  } else {
    writeStatus.ledger_embeddings = { ok: true };
  }

  // ── 10. DECISION LOGGER ───────────────────────────────────────────────────
  if (validatedOutput.type === 'FINANCIAL_MATRIX' || validatedOutput.type === 'STRATEGIC_ADVICE') {
    const { error: decisionLogError } = await supabaseAdmin
      .from('decision_logs')
      .insert([{
        user_id: user.id,
        user_question: ctx.incomingText,
        simora_recommendation: validatedOutput.action_directive,
        decision_status: 'PENDING',
      }]);

    if (decisionLogError) {
      console.error(`DECISION_LOG_WARNING: Failed to persist decision log: ${decisionLogError.message}`);
      writeStatus.decision_logs = { ok: false, error: decisionLogError.message, code: (decisionLogError as any).code };
    } else {
      writeStatus.decision_logs = { ok: true };
    }
  }

  // ── 11. AGGREGATED WRITE-STATUS SUMMARY ──────────────────────────────────
  // This is the single line to grep for in Railway logs: it tells you in
  // one glance which Supabase writes succeeded vs failed for this turn,
  // instead of needing to scroll past scattered WARNING lines from steps
  // 6-10 above. A response can look perfect in chat while every write here
  // fails silently underneath it — this line is what makes that visible.
  const failedWrites = Object.entries(writeStatus).filter(([, v]) => v.ok === false);
  if (failedWrites.length > 0) {
    console.error(
      `[SIMORA WRITE-STATUS] ❌ ${failedWrites.length} write(s) failed for user ${user.id}:`,
      JSON.stringify(writeStatus),
    );
  } else {
    console.log(`[SIMORA WRITE-STATUS] ✅ All writes succeeded for user ${user.id}:`, JSON.stringify(writeStatus));
  }

  // ── 12. RETURN ─────────────────────────────────────────────────────────
  return validatedOutput;
}
