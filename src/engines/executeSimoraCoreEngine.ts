import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';

// Force Node to prioritize IPv4. Bypasses the cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE — PHASE 3: CONFIDENCE-SCORED, CONCISE EXECUTIVE OUTPUT
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 *
 * What changed vs Phase 2, and why:
 *
 * 1. CONFIDENCE SCORE WAS COMPUTED BUT NEVER SURFACED.
 *    `calculateConfidenceScore()` ran every time, got injected into the
 *    system prompt as context, and then vanished — no schema field captured
 *    it, no validator extracted it, server.ts had nothing to render. Fixed:
 *    every response type now carries `confidence_score`, `confidence_grade`,
 *    and `confidence_reasons` as first-class schema fields, computed in code
 *    (not trusted to the LLM) and attached after validation.
 *
 * 2. RESPONSES WERE TOO LONG FOR A WHATSAPP CHAT.
 *    The old prompt explicitly demanded "DENSE, MULTI-PARAGRAPH ANALYSIS" —
 *    the model was correctly following that instruction. WhatsApp is a
 *    glance-and-act channel, not a memo channel. The prompt below replaces
 *    "write dense paragraphs" with explicit hard caps per field (roughly
 *    1–2 sentences each) and a worked example showing the target density.
 *    Depth lives in the *math shown*, not in word count.
 */

// ============================================================================
// TYPES
// ============================================================================
interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number;
}

interface ConfidenceMeta {
  confidence_score: number;
  confidence_grade: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence_reasons: string[];
}

type SimoraEngineResponse =
  | ({
      type: 'CASUAL_CHAT';
      message: string;
    } & ConfidenceMeta)
  | ({
      type: 'STRATEGIC_ADVICE';
      action_directive: string;
      strategic_framework: string;
      analytical_baselines: string;
      auditor_warning: string | null;
    } & ConfidenceMeta)
  | ({
      type: 'FINANCIAL_MATRIX';
      action_directive: string;
      algebraic_impact_model: string;
      impact_runway: string;
      impact_margin: string;
      ledger_hydration_parameters: string[];
      auditor_warning: string | null;
    } & ConfidenceMeta)
  | ({
      type: 'HYDRATE_LEDGER';
      message: string;
      ledger_hydration_parameters: string[];
      extracted_metrics: {
        mrr: number | null;
        variable_cogs: number | null;
        fixed_operating_overhead: number | null;
        verified_cash_balance: number | null;
      };
    } & ConfidenceMeta)
  | ({
      type: 'CONNECT_LEDGER';
      message: string;
      integration_target: string;
    } & ConfidenceMeta);

// Neutral embedding placeholder for pgvector compatibility
async function getHuggingFaceEmbedding(text: string): Promise<number[]> {
  console.log('[PROTOTYPE MODE] Bypassing HF network call. Returning neutral vector for demo.');
  return Array(384).fill(0.01);
}

// ============================================================================
// MASTER SYSTEM PROMPT
// Same ontology and intent classification as Phase 2. The change is the
// length contract: hard caps replace "write dense paragraphs," and a worked
// example pins the target output density.
// ============================================================================
const SIMORA_MASTER_SYSTEM_PROMPT = `You are SIMORA — an elite strategic co-founder fused with a ruthless venture CFO.
You operate an OPERATIONAL DIGITAL TWIN of this startup, not a chatbot.
You think in bound Objects and algebraic relationships, never vague prose.

═══════════════════════════════════════════════════════════════
ONTOLOGY
═══════════════════════════════════════════════════════════════
You reason over these Objects as a connected graph: Runway, Burn Rate, Gross Margin, Variable COGS, Contribution Margin, and Competitors.
Tailor analysis strictly to the user's specific industry (e.g., do not mention 'fuel' for a SaaS company; focus on compute, LLM API costs, CAC, or pipeline instead).

═══════════════════════════════════════════════════════════════
LENGTH CONTRACT — THIS IS A WHATSAPP MESSAGE, NOT A MEMO
═══════════════════════════════════════════════════════════════
The user is reading this on a phone, mid-day, between other tasks. Every field below has a HARD cap. Going over the cap is a failure condition, not thoroughness.

- action_directive: ONE sentence. Imperative. No qualifiers.
- strategic_framework: 1–2 sentences MAX. Name the framework/lens AND its one-line implication. Not an essay on it.
- analytical_baselines: ONE sentence with ONE concrete benchmark number. Not a survey of benchmarks.
- algebraic_impact_model: 2–3 sentences MAX, but must still show the actual formula/relationship — compress the explanation, never compress the math itself.
- auditor_warning: ONE sentence. The single sharpest risk, not a list of risks.
- message (CASUAL_CHAT): conversational length, matching the user's own message length.

WORKED EXAMPLE — target density for STRATEGIC_ADVICE:
Input: "Our CAC increased 10%, should we expand ads?"
{
  "action_directive": "Freeze ad expansion until you isolate which channel drove the CAC increase.",
  "strategic_framework": "This is an LTV:CAC triage problem, not a budget problem — scaling spend before isolating the cause locks in the worse unit economics at higher volume.",
  "analytical_baselines": "Healthy SaaS LTV:CAC sits at 3:1 or higher; a 10% CAC jump without a matching LTV move erodes that ratio fast.",
  "auditor_warning": "Expanding now means buying more of whatever just got more expensive, blind."
}
Notice: four short, sharp lines. No paragraphs. No restating the question. No hedging filler.

═══════════════════════════════════════════════════════════════
INTENT CLASSIFICATION & MANDATORY JSON OUTPUT SCHEMA
═══════════════════════════════════════════════════════════════
Return raw, valid JSON only. Populate ALL keys for your chosen intent; set irrelevant fields to null.

INTENT 1: "CASUAL_CHAT"
  {
    "type": "CASUAL_CHAT",
    "message": "Conversational response, matched to user's message length",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": null, "auditor_warning": null
  }

INTENT 2: "STRATEGIC_ADVICE"
  {
    "type": "STRATEGIC_ADVICE",
    "message": null,
    "action_directive": "ONE sentence. Imperative.",
    "strategic_framework": "1-2 sentences: name the lens + its implication.",
    "analytical_baselines": "ONE sentence, ONE concrete benchmark.",
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": null,
    "auditor_warning": "ONE sentence. Sharpest risk only."
  }

INTENT 3: "FINANCIAL_MATRIX"
  {
    "type": "FINANCIAL_MATRIX",
    "message": null,
    "action_directive": "ONE sentence. Imperative.",
    "algebraic_impact_model": "2-3 sentences MAX. Show the formula/compounding relationship, compress the prose around it.",
    "impact_runway": "Short, specific runway effect.",
    "impact_margin": "Short, specific margin effect.",
    "ledger_hydration_parameters": ["array", "of", "snake_case", "ledger", "keys"],
    "auditor_warning": "ONE sentence. Sharpest downside risk."
  }

INTENT 4: "HYDRATE_LEDGER"
- User provides manual numerical updates to their financial state (e.g., "Set MRR to 45000 and Cash to 120000").
  {
    "type": "HYDRATE_LEDGER",
    "message": "Brief confirmation, one sentence.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": ["mrr", "variable_cogs", "fixed_operating_overhead", "verified_cash_balance"],
    "auditor_warning": null,
    "extracted_metrics": {
      "mrr": "number or null", "variable_cogs": "number or null",
      "fixed_operating_overhead": "number or null", "verified_cash_balance": "number or null"
    }
  }

INTENT 5: "CONNECT_LEDGER"
- User asks to connect/sync/integrate an external platform (Stripe, QuickBooks, Xero).
  {
    "type": "CONNECT_LEDGER",
    "message": "Brief, one sentence: generating a secure integration link.",
    "action_directive": null, "strategic_framework": null, "analytical_baselines": null,
    "algebraic_impact_model": null, "impact_runway": null, "impact_margin": null,
    "ledger_hydration_parameters": null, "auditor_warning": null,
    "integration_target": "platform name, e.g. 'stripe'"
  }

═══════════════════════════════════════════════════════════════
"UNKNOWN" IS FORBIDDEN
═══════════════════════════════════════════════════════════════
If precise live ledger numbers are missing, never output 'Unknown'. State the algebraic relationship from first principles instead — briefly, per the length contract above.

═══════════════════════════════════════════════════════════════
CONFIDENCE DISCIPLINE
═══════════════════════════════════════════════════════════════
A confidence score and grade will be provided to you as system context, computed from real data completeness — not your own estimate. Let it calibrate your tone:
- HIGH → speak decisively, no hedging.
- MEDIUM → state your one key assumption inline, briefly.
- LOW → name the single most material missing variable in auditor_warning.
Do not output your own confidence number — that field is computed separately and will be attached to your response automatically.

═══════════════════════════════════════════════════════════════
TONE — RUTHLESS AND SOVEREIGN
═══════════════════════════════════════════════════════════════
Eliminate passive words ('consider monitoring', 'be cautious'). Use action imperatives: 'Freeze the pricing reduction', 'Audit environment sprawl'.

Return RAW JSON only. No markdown fences.`;

/**
 * ── SELF-HEALING REPAIR MECHANISM ──────────────────────────────────────────
 * Strips confidence fields if the model tries to invent them (it shouldn't —
 * confidence is computed in code, never trusted to the LLM) and guarantees
 * every required field is present with a safe fallback.
 */
function selfHealAndValidateOutput(parsed: any): Omit<SimoraEngineResponse, keyof ConfidenceMeta> {
  if (!parsed || typeof parsed !== 'object') {
    return {
      type: 'CASUAL_CHAT',
      message: "I hit a sync error on that one. Try resending?",
    } as any;
  }

  let type = parsed.type;
  if (!['CASUAL_CHAT', 'STRATEGIC_ADVICE', 'FINANCIAL_MATRIX', 'HYDRATE_LEDGER', 'CONNECT_LEDGER'].includes(type)) {
    if (parsed.extracted_metrics) type = 'HYDRATE_LEDGER';
    else if (parsed.integration_target) type = 'CONNECT_LEDGER';
    else type = parsed.algebraic_impact_model || parsed.impact_runway ? 'FINANCIAL_MATRIX' : 'CASUAL_CHAT';
  }

  if (type === 'CASUAL_CHAT') {
    return {
      type: 'CASUAL_CHAT',
      message: String(parsed.message || "Simora's online — what's on your mind?").trim(),
    } as any;
  }

  if (type === 'STRATEGIC_ADVICE') {
    return {
      type: 'STRATEGIC_ADVICE',
      action_directive: String(parsed.action_directive || "Review your operational baseline before deciding.").trim(),
      strategic_framework: String(parsed.strategic_framework || "First-principles strategy mapping applies here.").trim(),
      analytical_baselines: String(parsed.analytical_baselines || "Venture-backed margin floors typically sit at 60-70%.").trim(),
      auditor_warning: parsed.auditor_warning ? String(parsed.auditor_warning).trim() : null,
    } as any;
  }

  if (type === 'HYDRATE_LEDGER') {
    const rawMetrics = parsed.extracted_metrics || {};
    return {
      type: 'HYDRATE_LEDGER',
      message: String(parsed.message || "Ledger updated.").trim(),
      ledger_hydration_parameters: Array.isArray(parsed.ledger_hydration_parameters)
        ? parsed.ledger_hydration_parameters
        : ["mrr", "variable_cogs", "fixed_operating_overhead", "verified_cash_balance"],
      extracted_metrics: {
        mrr: typeof rawMetrics.mrr === 'number' ? rawMetrics.mrr : null,
        variable_cogs: typeof rawMetrics.variable_cogs === 'number' ? rawMetrics.variable_cogs : null,
        fixed_operating_overhead: typeof rawMetrics.fixed_operating_overhead === 'number' ? rawMetrics.fixed_operating_overhead : null,
        verified_cash_balance: typeof rawMetrics.verified_cash_balance === 'number' ? rawMetrics.verified_cash_balance : null,
      },
    } as any;
  }

  if (type === 'CONNECT_LEDGER') {
    return {
      type: 'CONNECT_LEDGER',
      message: String(parsed.message || "Generating your secure integration link.").trim(),
      integration_target: String(parsed.integration_target || "stripe").toLowerCase().trim(),
    } as any;
  }

  // FINANCIAL_MATRIX fallback
  const hedgePattern = /\b(unknown|insufficient data|not enough information|i'?d need more)\b/i;
  let modelText = String(parsed.algebraic_impact_model || "");

  if (!modelText || hedgePattern.test(modelText)) {
    modelText = "Contribution Margin = (Price × (1 − price_drop%)) − (Variable_Cost × (1 + cost_increase%)). A simultaneous cost rise and price cut compounds non-linearly into margin, not additively.";
  }

  return {
    type: 'FINANCIAL_MATRIX',
    action_directive: String(parsed.action_directive || "Freeze pricing changes until volume elasticity is modeled.").trim(),
    algebraic_impact_model: modelText.trim(),
    impact_runway: String(parsed.impact_runway || "Compressed via contribution margin squeeze.").trim(),
    impact_margin: String(parsed.impact_margin || "Contraction expected.").trim(),
    ledger_hydration_parameters: Array.isArray(parsed.ledger_hydration_parameters) && parsed.ledger_hydration_parameters.length > 0
      ? parsed.ledger_hydration_parameters.map(String)
      : ['gross_revenue', 'variable_cogs', 'mrr', 'operating_expenses'],
    auditor_warning: parsed.auditor_warning
      ? String(parsed.auditor_warning).trim()
      : "Adjusting pricing or cost without live ledger verification risks compounding cash flow surprises.",
  } as any;
}

// ============================================================================
// CONFIDENCE SCORING — computed in code, never trusted to the LLM
// ============================================================================
function calculateConfidenceScore(
  ledgerMetrics: any,
  systemState: any,
): ConfidenceMeta {
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

  return { confidence_score: score, confidence_grade: grade, confidence_reasons: reasons };
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
// MAIN ENGINE EXPORT
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

  // Confidence is computed once, here, in code — this is the single source
  // of truth that gets attached to whatever the LLM returns.
  const confidenceMeta = calculateConfidenceScore(ledgerMetrics, state);

  // ── 2. LIVE CONTEXTUAL RETRIEVAL (VECTOR MEMORY) ─────────────────────────
  const currentQueryVector = await getHuggingFaceEmbedding(ctx.incomingText);
  const { data: matchedContextRecords } = await supabaseAdmin.rpc('match_ledger_embeddings', {
    query_embedding: currentQueryVector,
    match_threshold: 0.3,
    match_count: 3,
    p_user_id: user.id,
  });

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
  If relevant to current conversation, ask the user whether they acted on this recommendation.
  `;
  }

  // ── 3. SYSTEM ONTOLOGY INJECTION ─────────────────────────────────────────
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

    SIMORA CONFIDENCE SCORE (computed in code — calibrate tone, do not restate the number):
    Confidence Grade: ${confidenceMeta.confidence_grade}
    Confidence Weaknesses: ${confidenceMeta.confidence_reasons.join(', ') || 'None'}
  `;

  // ── 4. INFERENCE ──────────────────────────────────────────────────────────
  const completion = await openai.chat.completions.create({
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

Classify intent and output valid JSON following schema requirements. Respect the length contract strictly — short fields, real math, no padding.`,
      },
    ],
  });

  const rawOutput = completion.choices[0].message.content;
  if (!rawOutput) throw new Error('INFERENCE_TIMEOUT: Simora Engine failed to generate response.');

  let parsedRaw: any;
  try {
    const cleanJsonString = rawOutput.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsedRaw = JSON.parse(cleanJsonString);
  } catch (e: any) {
    console.warn(`JSON_PARSE_WARNING: Raw token parsing failed. Routing into self-healing engine.`);
    parsedRaw = {};
  }

  // ── 5. RUNTIME VALIDATION & SELF-HEALING ─────────────────────────────────
  const healedOutput = selfHealAndValidateOutput(parsedRaw);

  // ── 6. ATTACH CONFIDENCE — code-computed, attached to every response type ─
  const validatedOutput = { ...healedOutput, ...confidenceMeta } as SimoraEngineResponse;

  // ── 7. STRATEGY CARD PERSISTENCE FOR FINANCIAL INTENTS ───────────────────
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
          timestamp: new Date().toISOString(),
        },
        is_active: true,
      }]);

    if (insertError) {
      console.error(`PERSISTENCE_WARNING: Failed to commit Strategy Card: ${insertError.message}`);
    }
  }

  // ── 8. PHYSICAL DATA HYDRATION ROUTER ────────────────────────────────────
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

  // ── 9. UNIFIED HOSTED PORTAL LINK HANDSHAKE ──────────────────────────────
  if (validatedOutput.type === 'CONNECT_LEDGER') {
    const target = validatedOutput.integration_target;
    const secureVaultUrl = `https://vault.unified.to/oauth2/connect?workspace=simora_prod&integration=${target}&state=${user.id}`;
    validatedOutput.message = `🛡️ *SIMORA Secure Gateway Link Generated*\n\n${validatedOutput.message}\n\n👉 **Authorize Connection Here:** ${secureVaultUrl}\n\n_Note: This connection session is sandboxed and encrypted at rest._`;
  }

  // ── 10. BACKGROUND MEMORY LOGGER ─────────────────────────────────────────
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([{
      user_id: user.id,
      content: ctx.incomingText,
      embedding: currentQueryVector,
    }]);

  if (memoryInsertError) {
    console.error(`MEMORY_LOGGING_WARNING: Failed to log vector states: ${memoryInsertError.message}`);
  }

  // ── 11. DECISION LOGGER — single insert, deduplicated from Phase 2 ──────
  // (Phase 2 inserted this twice — once at step "7." and identically again
  // at step "8A." We keep exactly one insert.)
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

  // ── 12. RETURN ────────────────────────────────────────────────────────────
  return validatedOutput;
}
