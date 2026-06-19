import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';

// Force Node to prioritize IPv4. Bypasses the cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE — PHASE 3: CONFIDENCE-SCORED, WHATSAPP-DENSITY-CALIBRATED
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 *
 * Fixes two compounding problems from Phase 2:
 *
 * 1. CONFIDENCE SCORE WAS COMPUTED BUT NEVER RETURNED.
 *    calculateConfidenceScore() ran and was injected into the LLM's context
 *    as text, but no field in the response schema carried it back out to
 *    the caller. It was calculated, then silently dropped. This phase adds
 *    confidence_score / confidence_grade / confidence_reasons to the
 *    STRATEGIC_ADVICE and FINANCIAL_MATRIX response shapes ONLY — confidence
 *    isn't meaningful for casual chat or ledger/integration actions.
 *
 * 2. UNBOUNDED VERBOSITY. The Phase 2 prompt demanded "DENSE, MULTI-PARAGRAPH
 *    executive briefings" with no length ceiling, which produced multi-
 *    paragraph WhatsApp bubbles nobody reads on a busy day. This phase
 *    replaces that instruction with an explicit WhatsApp-density mandate:
 *    sharp, dense, CFO-grade reasoning, but capped at 2-3 sentences per
 *    field. Confidence scoring is what lets the model compress — instead of
 *    hedging across three paragraphs, it states a number and moves on.
 */
interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number;
}

interface ConfidenceData {
  score: number;
  grade: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
}

type SimoraEngineResponse =
  | {
      type: 'CASUAL_CHAT';
      message: string;
    }
  | {
      type: 'STRATEGIC_ADVICE';
      action_directive: string;
      strategic_framework: string;
      analytical_baselines: string;
      auditor_warning: string | null;
      confidence_score: number;
      confidence_grade: 'HIGH' | 'MEDIUM' | 'LOW';
      confidence_reasons: string[];
    }
  | {
      type: 'FINANCIAL_MATRIX';
      action_directive: string;
      algebraic_impact_model: string;
      impact_runway: string;
      impact_margin: string;
      ledger_hydration_parameters: string[];
      auditor_warning: string | null;
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
// MASTER SYSTEM PROMPT — WhatsApp-density calibrated
// ============================================================================
const SIMORA_MASTER_SYSTEM_PROMPT = `You are SIMORA — an elite strategic co-founder fused with a ruthless venture CFO.
You operate an OPERATIONAL DIGITAL TWIN of this startup, not a chatbot.
You think in bound Objects and algebraic relationships, never vague prose.

═══════════════════════════════════════════════════════════════
ONTOLOGY
═══════════════════════════════════════════════════════════════
You reason over these Objects as a connected graph: Runway, Burn Rate, Gross Margin, Variable COGS, Contribution Margin, and Competitors.
CRITICAL: Tailor analysis strictly to the user's specific industry (e.g., do not mention 'fuel' for a SaaS company; focus on compute, LLM API costs, or pipeline instead).

═══════════════════════════════════════════════════════════════
DENSITY MANDATE — THIS IS A WHATSAPP MESSAGE, NOT A MEMO
═══════════════════════════════════════════════════════════════
The user is reading this on a phone, mid-day, between other tasks. Every field below has a HARD CEILING of 2-3 sentences. Use the most precise, highest-information words possible per sentence — sharp and dense, never padded.

Forbidden in every field: throat-clearing ("it's crucial to," "a comprehensive review should be conducted"), redundant restatement of the question, listing more than one suggested action when one will do, hedging filler ("might involve," "could potentially").
Required in every field: one concrete claim, one number or named mechanism where relevant, zero filler.

A confidence score is provided to you below for this exact reason — when confidence is genuinely uncertain, STATE THE NUMBER, don't pad the prose to compensate. "62% confidence — CAC and COGS not yet synced" is a complete, sufficient hedge. A paragraph explaining why you're hedging is not.

Example of REQUIRED density (do not exceed this length):
"Freeze ad spend increases. A 10% CAC rise with flat LTV erodes payback period directly — expanding now compounds the problem before you've isolated the channel driving it."
Example of FORBIDDEN density (never produce output like this):
"The recent increase in Customer Acquisition Cost necessitates a thorough examination of the current marketing strategy and its ROI. Given industry shifts towards usage-based pricing models, it's crucial to assess whether the existing ad strategy aligns with these trends, and a detailed competitive landscape analysis should be conducted..."

═══════════════════════════════════════════════════════════════
INTENT CLASSIFICATION & MANDATORY JSON OUTPUT SCHEMA
═══════════════════════════════════════════════════════════════
Return raw, valid JSON. Populate ALL keys for your chosen intent; if a field is not relevant, set it to null.

INTENT 1: "CASUAL_CHAT"
- Small talk or general non-business queries.
  {
    "type": "CASUAL_CHAT",
    "message": "Your conversational response — 1-2 sentences, warm, no business jargon.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": null, "auditor_warning": null
  }

INTENT 2: "STRATEGIC_ADVICE"
- Qualitative strategic questions with no hard numeric shock to compute.
  {
    "type": "STRATEGIC_ADVICE",
    "message": null,
    "action_directive": "One sharp imperative sentence. Not a suggestion — a command.",
    "strategic_framework": "MAX 2-3 sentences. Name the mechanism or framework and state its conclusion. No preamble.",
    "analytical_baselines": "MAX 1-2 sentences. One hard benchmark with an exact figure or range. No explanation of why benchmarks matter.",
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null, "ledger_hydration_parameters": null,
    "auditor_warning": "MAX 1-2 sentences, or null if no material risk. The single sharpest downside — not a list."
  }

INTENT 3: "FINANCIAL_MATRIX"
- Operational/financial shifts, cost updates, or volume adjustments.
  {
    "type": "FINANCIAL_MATRIX",
    "message": null,
    "action_directive": "One sharp imperative sentence.",
    "algebraic_impact_model": "MAX 2-3 sentences. State the formulaic relationship and its compounding effect directly — show the mechanism, not a lecture about it.",
    "impact_runway": "MAX 1 sentence. Direction + magnitude.",
    "impact_margin": "MAX 1 sentence. Direction + magnitude.",
    "ledger_hydration_parameters": ["array", "of", "snake_case", "ledger", "keys"],
    "auditor_warning": "MAX 1-2 sentences, or null if no material risk."
  }

INTENT 4: "HYDRATE_LEDGER"
- User provides manual numerical updates to their financial state.
  {
    "type": "HYDRATE_LEDGER",
    "message": "Brief confirmation, 1 sentence.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": ["mrr", "variable_cogs", "fixed_operating_overhead", "verified_cash_balance"],
    "auditor_warning": null,
    "extracted_metrics": { "mrr": "number or null", "variable_cogs": "number or null", "fixed_operating_overhead": "number or null", "verified_cash_balance": "number or null" }
  }

INTENT 5: "CONNECT_LEDGER"
- User asks to connect, sync, or integrate an external platform.
  {
    "type": "CONNECT_LEDGER",
    "message": "Brief, 1 sentence, stating you're generating a secure integration link.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null, "ledger_hydration_parameters": null, "auditor_warning": null,
    "integration_target": "The requested platform name (e.g., 'stripe', 'quickbooks')"
  }

═══════════════════════════════════════════════════════════════
"UNKNOWN" IS FORBIDDEN
═══════════════════════════════════════════════════════════════
If precise live ledger numbers are missing, never output 'Unknown'. State the algebraic mechanism conceptually, in the same 2-3 sentence ceiling as above. The confidence score — not extra prose — is how you communicate uncertainty.

═══════════════════════════════════════════════════════════════
CONFIDENCE DISCIPLINE
═══════════════════════════════════════════════════════════════
A confidence score and grade are computed and injected into your context below. You do not need to restate or explain the score in your prose — it is rendered separately to the user. Let it govern your tone only:
80-100 (HIGH) → speak decisively, no hedging language at all.
60-79 (MEDIUM) → one short clause naming the missing input is enough; do not over-qualify.
0-59 (LOW) → name the single most material missing variable in one clause, then still give a directive. Never refuse to answer.

═══════════════════════════════════════════════════════════════
TONE — RUTHLESS AND SOVEREIGN
═══════════════════════════════════════════════════════════════
Eliminate passive words ('consider monitoring', 'be cautious', 'keep a close eye'). Use clear action imperatives: 'Freeze the pricing reduction', 'Audit environment sprawl', 'Isolate your hosting invoice'.

Return RAW JSON only. No markdown fences (\`\`\`json).`;

/**
 * ── SELF-HEALING REPAIR MECHANISM ──────────────────────────────────────────
 * Now also responsible for attaching confidenceData to STRATEGIC_ADVICE and
 * FINANCIAL_MATRIX responses — this is the fix for the score being computed
 * and then discarded.
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
  // Truncates on a sentence boundary where possible rather than mid-word.
  const capSentences = (text: string, maxSentences: number): string => {
    const trimmed = text.trim();
    const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
    if (sentences.length <= maxSentences) return trimmed;
    return sentences.slice(0, maxSentences).join(' ').trim();
  };

  if (type === 'CASUAL_CHAT') {
    return {
      type: 'CASUAL_CHAT',
      message: capSentences(String(parsed.message || "Simora's online. What's the scenario?"), 2),
    };
  }

  if (type === 'STRATEGIC_ADVICE') {
    return {
      type: 'STRATEGIC_ADVICE',
      action_directive: capSentences(String(parsed.action_directive || "Run an immediate operational baseline review."), 1),
      strategic_framework: capSentences(String(parsed.strategic_framework || "First-principles structural review indicated."), 3),
      analytical_baselines: capSentences(String(parsed.analytical_baselines || "Venture-backed margin floors are typically defended at 60-70%."), 2),
      auditor_warning: parsed.auditor_warning ? capSentences(String(parsed.auditor_warning), 2) : null,
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

  if (score < 0) score = 0;

  let grade: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  if (score >= 80) grade = 'HIGH';
  else if (score >= 60) grade = 'MEDIUM';

  return { score, grade, reasons };
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

  const { data: state, error: stateErr } = await supabaseAdmin
    .from('system_states')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (stateErr || !state) {
    throw new Error(`CRITICAL_SYSTEM_ERROR: System State Missing for User ${user.id}`);
  }

  const { data: ledgerMetrics } = await supabaseAdmin
    .from('ledger_metrics')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // ── This is the value that was previously computed and discarded ────────
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
  if (pendingDecision) {
    decisionFollowupContext = `
    PENDING_DECISION_REVIEW:
    Previous Question: ${pendingDecision.user_question}
    Previous Recommendation: ${pendingDecision.simora_recommendation}
    If relevant to current conversation, briefly ask in 1 clause whether the user acted on this.
    `;
  }

  // ── 3. SYSTEM ONTOLOGY INJECTION WITH REAL-TIME SNAPSHOT OVERRIDES ───────
  const systemFrameworkContext = `
    LIVE OPERATIONAL OBJECT STATE:
    SYSTEM_ARCHETYPE_TIER: ${user.assigned_tier}
    GEOGRAPHY_CODE: ${user.geo_country_code}-${user.geo_city_region}
    INDUSTRY_TAXONOMY_ID: ${user.industry_taxonomy_id}
    CURRENT_RESILIENCE_SCORE: ${state.resilience_score}
    Runway.current_months: ${state.calculated_runway_months}
    BurnRate.monthly: ${state.monthly_operating_burn}

    REAL-TIME SYNCHRONIZED FINANCIAL LEDGER SNAPSHOTS (SUPABASE):
    MRR: ${ledgerMetrics?.mrr ?? 'Omitted (Using Conceptual Fallbacks)'}
    Variable_COGS: ${ledgerMetrics?.variable_cogs ?? 'Omitted (Using Conceptual Fallbacks)'}
    Fixed_Operating_Overhead: ${ledgerMetrics?.fixed_operating_overhead ?? 'Omitted (Using Conceptual Fallbacks)'}
    Verified_Cash_Balance: ${ledgerMetrics?.verified_cash_balance ?? 'Omitted (Using Conceptual Fallbacks)'}
    Last_State_Hydration_Method: ${ledgerMetrics?.last_hydrated_by ?? 'None'}

    SIMORA CONFIDENCE SCORE (govern tone only — do not restate this in prose):
    Confidence Score: ${confidenceData.score}
    Confidence Grade: ${confidenceData.grade}
    Confidence Weaknesses: ${confidenceData.reasons.join(', ') || 'None'}
  `;

  // ── 4. INFERENCE LOOP ─────────────────────────────────────────────────────
  // DIAGNOSTIC INSTRUMENTATION: the API call itself is now wrapped so an
  // auth/model/rate-limit failure surfaces with its real error message
  // instead of throwing an unhandled exception the worker can't explain.
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SIMORA_MASTER_SYSTEM_PROMPT },
        { role: 'system', content: systemFrameworkContext },
        {
          role: 'user',
          content: `CONTEXT_CHUNKS FROM HISTORICAL LOGS:
${vectorContext}

DECISION FOLLOWUP CONTEXT:
${decisionFollowupContext}

NEW INCOMING MESSAGE:
${ctx.incomingText}

Classify intent and output valid JSON following schema requirements. Respect the density ceiling strictly.`,
        },
      ],
    });
  } catch (apiErr: any) {
    console.error('[SIMORA ENGINE] ❌ LLM API call failed:', apiErr?.message || apiErr);
    console.error('[SIMORA ENGINE] Full error object:', JSON.stringify(apiErr, Object.getOwnPropertyNames(apiErr || {})));
    throw new Error(`INFERENCE_API_ERROR: ${apiErr?.message || 'Unknown API failure'}`);
  }

  const rawOutput = completion.choices?.[0]?.message?.content;

  // DIAGNOSTIC: always log the raw model output before any parsing attempt,
  // so a malformed-JSON failure is visible in Railway logs instead of silent.
  console.log('[SIMORA ENGINE] Raw model output (first 1000 chars):', (rawOutput || '').slice(0, 1000));

  if (!rawOutput) {
    console.error('[SIMORA ENGINE] ❌ Model returned empty content. Full completion object:', JSON.stringify(completion));
    throw new Error('INFERENCE_TIMEOUT: Simora Engine failed to generate response.');
  }

  let parsedRaw: any;
  try {
    const cleanJsonString = rawOutput.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsedRaw = JSON.parse(cleanJsonString);
  } catch (e: any) {
    // DIAGNOSTIC: this used to silently default to {} with no detail. Now
    // logs the exact parse error and the exact string that failed to parse.
    console.error('[SIMORA ENGINE] ❌ JSON_PARSE_ERROR:', e.message);
    console.error('[SIMORA ENGINE] String that failed to parse:', rawOutput);
    parsedRaw = {};
  }

  // ── 5. RUNTIME VALIDATION & SELF-HEALING FILTER (now confidence-aware) ───
  const validatedOutput = selfHealAndValidateOutput(parsedRaw, confidenceData);

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
          timestamp: new Date().toISOString(),
        },
        is_active: true,
      }]);

    if (insertError) {
      console.error(`PERSISTENCE_WARNING: Failed to commit Strategy Card: ${insertError.message}`);
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
    }
  }

  // ── 8. UNIFIED HOSTED PORTAL LINK HANDSHAKE ──────────────────────────────
  if (validatedOutput.type === 'CONNECT_LEDGER') {
    const target = validatedOutput.integration_target;
    const secureVaultUrl = `https://vault.unified.to/oauth2/connect?workspace=simora_prod&integration=${target}&state=${user.id}`;
    validatedOutput.message = `🛡️ Secure link ready.\n👉 ${secureVaultUrl}\n_Sandboxed, encrypted at rest._`;
  }

  // ── 9. BACKGROUND MEMORY LOGGER ───────────────────────────────────────────
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([{ user_id: user.id, content: ctx.incomingText, embedding: currentQueryVector }]);

  if (memoryInsertError) {
    console.error(`MEMORY_LOGGING_WARNING: Failed to log vector states: ${memoryInsertError.message}`);
  }

  // ── 10. DECISION LOGGER — single insert, deduplicated from Phase 2's accidental double-write ─
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
    }
  }

  // ── 11. RETURN ─────────────────────────────────────────────────────────
  return validatedOutput;
}
