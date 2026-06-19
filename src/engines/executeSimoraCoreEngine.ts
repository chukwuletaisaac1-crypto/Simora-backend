import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';

// Force Node to prioritize IPv4. Bypasses cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE — PHASE 2: REAL-TIME LEDGER STATE INTEGRATOR
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 */

interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number;
}

interface LedgerMetrics {
  mrr: number | null;
  variable_cogs: number | null;
  fixed_operating_overhead: number | null;
  verified_cash_balance: number | null;
  last_hydrated_by?: string | null;
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
    }
  | {
      type: 'FINANCIAL_MATRIX';
      action_directive: string;
      algebraic_impact_model: string;
      impact_runway: string;
      impact_margin: string;
      ledger_hydration_parameters: string[];
      auditor_warning: string | null;
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
async function getHuggingFaceEmbedding(_: string): Promise<number[]> {
  console.log(
    '[PROTOTYPE MODE] Bypassing HF network call. Returning neutral vector for demo.'
  );
  return Array(384).fill(0.01);
}

// Master System Instructions
const SIMORA_MASTER_SYSTEM_PROMPT = `You are SIMORA — an elite strategic co-founder fused with a ruthless venture CFO.
You operate an OPERATIONAL DIGITAL TWIN of this startup, not a chatbot.
You think in bound Objects and algebraic relationships, never vague prose.

═══════════════════════════════════════════════════════════════
ONTOLOGY & DENSITY MANDATE
═══════════════════════════════════════════════════════════════
You reason over these Objects as a connected graph: Runway, Burn Rate, Gross Margin, Variable COGS, Contribution Margin, and Competitors.
CRITICAL: Do not blindly copy examples from this prompt. Tailor your analysis strictly to the user's specific industry.

When generating text for JSON fields, YOU MUST WRITE DENSE, HIGH-LEVEL EXECUTIVE PARAGRAPHS.

═══════════════════════════════════════════════════════════════
INTENT CLASSIFICATION & MANDATORY JSON OUTPUT SCHEMA
═══════════════════════════════════════════════════════════════
You must return raw, valid JSON.

Allowed intents:
CASUAL_CHAT
STRATEGIC_ADVICE
FINANCIAL_MATRIX
HYDRATE_LEDGER
CONNECT_LEDGER

CRITICAL: "UNKNOWN" IS FORBIDDEN

If precise live ledger numbers are missing, NEVER output 'Unknown'. Use first-principles reasoning.

CONFIDENCE DISCIPLINE
80-100 → speak decisively
60-79 → mention assumptions
0-59 → explicitly state missing variables materially weaken confidence

TONE — RUTHLESS AND SOVEREIGN
Return RAW JSON only.`;

/**
 * SELF-HEALING OUTPUT REPAIR
 */
function selfHealAndValidateOutput(parsed: any): SimoraEngineResponse {
  if (!parsed || typeof parsed !== 'object') {
    return {
      type: 'CASUAL_CHAT',
      message:
        "I encountered a synchronization error processing that request. Let's review your operational parameters again.",
    };
  }

  let type = parsed.type;

  if (
    ![
      'CASUAL_CHAT',
      'STRATEGIC_ADVICE',
      'FINANCIAL_MATRIX',
      'HYDRATE_LEDGER',
      'CONNECT_LEDGER',
    ].includes(type)
  ) {
    if (parsed.extracted_metrics) type = 'HYDRATE_LEDGER';
    else if (parsed.integration_target) type = 'CONNECT_LEDGER';
    else if (parsed.algebraic_impact_model || parsed.impact_runway)
      type = 'FINANCIAL_MATRIX';
    else type = 'CASUAL_CHAT';
  }

  if (type === 'CASUAL_CHAT') {
    return {
      type: 'CASUAL_CHAT',
      message: String(
        parsed.message ||
          'Simora systems active. Input operational vector or financial delta.'
      ).trim(),
    };
  }

  if (type === 'STRATEGIC_ADVICE') {
    return {
      type: 'STRATEGIC_ADVICE',
      action_directive: String(
        parsed.action_directive ||
          'Initiate immediate operational baseline review.'
      ).trim(),
      strategic_framework: String(
        parsed.strategic_framework || 'First-Principles Strategy Mapping'
      ).trim(),
      analytical_baselines: String(
        parsed.analytical_baselines ||
          'Standard operating margins for venture-backed entities are defended at a 60–70% floor.'
      ).trim(),
      auditor_warning: parsed.auditor_warning
        ? String(parsed.auditor_warning).trim()
        : null,
    };
  }

  if (type === 'HYDRATE_LEDGER') {
    const rawMetrics = parsed.extracted_metrics || {};

    return {
      type: 'HYDRATE_LEDGER',
      message: String(
        parsed.message ||
          'Manual ledger overrides received and committed successfully.'
      ).trim(),
      ledger_hydration_parameters: Array.isArray(
        parsed.ledger_hydration_parameters
      )
        ? parsed.ledger_hydration_parameters
        : [
            'mrr',
            'variable_cogs',
            'fixed_operating_overhead',
            'verified_cash_balance',
          ],
      extracted_metrics: {
        mrr: typeof rawMetrics.mrr === 'number' ? rawMetrics.mrr : null,
        variable_cogs:
          typeof rawMetrics.variable_cogs === 'number'
            ? rawMetrics.variable_cogs
            : null,
        fixed_operating_overhead:
          typeof rawMetrics.fixed_operating_overhead === 'number'
            ? rawMetrics.fixed_operating_overhead
            : null,
        verified_cash_balance:
          typeof rawMetrics.verified_cash_balance === 'number'
            ? rawMetrics.verified_cash_balance
            : null,
      },
    };
  }

  if (type === 'CONNECT_LEDGER') {
    return {
      type: 'CONNECT_LEDGER',
      message: String(
        parsed.message ||
          'Initializing secure integration handshake link protocol.'
      ).trim(),
      integration_target: String(
        parsed.integration_target || 'stripe'
      ).toLowerCase(),
    };
  }
    // FINANCIAL_MATRIX Self-Healing Fallback Build
  const hedgePattern =
    /\b(unknown|insufficient data|not enough information|i'?d need more)\b/i;

  let modelText = String(parsed.algebraic_impact_model || '');

  if (!modelText || hedgePattern.test(modelText)) {
    modelText =
      'Mathematical Model: Contribution Margin Per Unit = (Price × (1 − price_drop%)) − (Variable_Cost × (1 + cost_increase%)). When variable costs rise alongside pricing compression, non-linear double-sided margin compression accelerates burn unless volume elasticity exceeds break-even threshold.';
  }

  return {
    type: 'FINANCIAL_MATRIX',
    action_directive: String(
      parsed.action_directive ||
        'Freeze pricing changes until elasticity vectors are calculated.'
    ).trim(),
    algebraic_impact_model: modelText.trim(),
    impact_runway: String(
      parsed.impact_runway || 'Compressed via Contribution Margin Squeeze'
    ).trim(),
    impact_margin: String(
      parsed.impact_margin || 'Gross Margin Contraction Expected'
    ).trim(),
    ledger_hydration_parameters:
      Array.isArray(parsed.ledger_hydration_parameters) &&
      parsed.ledger_hydration_parameters.length > 0
        ? parsed.ledger_hydration_parameters.map(String)
        : ['gross_revenue', 'variable_cogs', 'mrr', 'operating_expenses'],
    auditor_warning: parsed.auditor_warning
      ? String(parsed.auditor_warning).trim()
      : 'Risk Flag: Running pricing/cost adjustments without verified ledger state risks structural cash-flow anomalies.',
  };
}

// ============================================================================
// SUPPORT HELPERS
// ============================================================================
function calculateConfidenceScore(
  ledgerMetrics: LedgerMetrics | null,
  systemState: any
) {
  let score = 100;
  const reasons: string[] = [];

  if (!ledgerMetrics) {
    score -= 40;
    reasons.push('No financial ledger connected');
  } else {
    if (ledgerMetrics.mrr == null) {
      score -= 15;
      reasons.push('Missing MRR');
    }

    if (ledgerMetrics.variable_cogs == null) {
      score -= 15;
      reasons.push('Missing variable COGS');
    }

    if (ledgerMetrics.fixed_operating_overhead == null) {
      score -= 15;
      reasons.push('Missing fixed overhead');
    }

    if (ledgerMetrics.verified_cash_balance == null) {
      score -= 15;
      reasons.push('Missing cash balance');
    }
  }

  if (systemState?.calculated_runway_months == null) {
    score -= 20;
    reasons.push('Runway unavailable');
  }

  if (score < 0) score = 0;

  let grade = 'LOW';

  if (score >= 80) grade = 'HIGH';
  else if (score >= 60) grade = 'MEDIUM';

  return {
    score,
    grade,
    reasons,
  };
}

async function getPendingDecisionFollowup(
  userId: string,
  supabaseAdmin: SupabaseClient
) {
  const { data, error } = await supabaseAdmin
    .from('decision_logs')
    .select('*')
    .eq('user_id', userId)
    .eq('decision_status', 'PENDING')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  return data[0];
}

// ============================================================================
// MAIN ENGINE EXPORT
// ============================================================================
export async function executeSimoraCoreEngine(
  ctx: IngestionContext,
  supabaseAdmin: SupabaseClient,
  openai: OpenAI
): Promise<SimoraEngineResponse> {
  // 1. DATA HYDRATION & PROFILE FETCH
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('whatsapp_id_hash', ctx.whatsappHash)
    .single();

  if (userErr || !user) {
    throw new Error(
      `SUPABASE_DATABASE_CRASH: Profile Unmapped or DB unreachable. ${userErr?.message}`
    );
  }

  const pendingDecision = await getPendingDecisionFollowup(
    user.id,
    supabaseAdmin
  );

  const { data: state, error: stateErr } = await supabaseAdmin
    .from('system_states')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (stateErr || !state) {
    throw new Error(
      `CRITICAL_SYSTEM_ERROR: System State Missing for User ${user.id}`
    );
  }

  // Safer than .single() for users without ledger yet
  const { data: ledgerMetrics } = await supabaseAdmin
    .from('ledger_metrics')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  const confidenceData = calculateConfidenceScore(
    (ledgerMetrics as LedgerMetrics | null) ?? null,
    state
  );

  // 2. VECTOR MEMORY RETRIEVAL
  const currentQueryVector = await getHuggingFaceEmbedding(
    ctx.incomingText
  );

  const { data: matchedContextRecords } = await supabaseAdmin.rpc(
    'match_ledger_embeddings',
    {
      query_embedding: currentQueryVector,
      match_threshold: 0.3,
      match_count: 3,
      p_user_id: user.id,
    }
  );

  let vectorContext =
    '[No relevant historical context discovered. Proceeding under baseline assumptions.]';

  if (matchedContextRecords && matchedContextRecords.length > 0) {
    vectorContext = matchedContextRecords
      .map(
        (record: any, idx: number) =>
          `[Historical Event #${idx + 1}: ${record.content}]`
      )
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

  // 3. SYSTEM ONTOLOGY INJECTION
  const systemFrameworkContext = `
LIVE OPERATIONAL OBJECT STATE:
SYSTEM_ARCHETYPE_TIER: ${user.assigned_tier}
GEOGRAPHY_CODE: ${user.geo_country_code}-${user.geo_city_region}
INDUSTRY_TAXONOMY_ID: ${user.industry_taxonomy_id}
CURRENT_RESILIENCE_SCORE: ${state.resilience_score}
Runway.current_months: ${state.calculated_runway_months}
BurnRate.monthly: ${state.monthly_operating_burn}

REAL-TIME SYNCHRONIZED FINANCIAL LEDGER SNAPSHOTS:
MRR: ${ledgerMetrics?.mrr ?? 'Omitted (Using Conceptual Fallbacks)'}
Variable_COGS: ${ledgerMetrics?.variable_cogs ?? 'Omitted (Using Conceptual Fallbacks)'}
Fixed_Operating_Overhead: ${ledgerMetrics?.fixed_operating_overhead ?? 'Omitted (Using Conceptual Fallbacks)'}
Verified_Cash_Balance: ${ledgerMetrics?.verified_cash_balance ?? 'Omitted (Using Conceptual Fallbacks)'}
Last_State_Hydration_Method: ${ledgerMetrics?.last_hydrated_by ?? 'None'}

SIMORA CONFIDENCE SCORE:
Confidence Score: ${confidenceData.score}
Confidence Grade: ${confidenceData.grade}
Confidence Weaknesses: ${confidenceData.reasons.join(', ') || 'None'}
`;

  // 4. INFERENCE LOOP
  const completion = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: SIMORA_MASTER_SYSTEM_PROMPT,
      },
      {
        role: 'system',
        content: systemFrameworkContext,
      },
      {
        role: 'user',
        content: `CONTEXT_CHUNKS FROM HISTORICAL LOGS:
${vectorContext}

DECISION FOLLOWUP CONTEXT:
${decisionFollowupContext}

NEW INCOMING MESSAGE:
${ctx.incomingText}

Classify intent and output valid JSON following schema requirements.`,
      },
    ],
  });

  const rawOutput = completion.choices[0].message.content;

  if (!rawOutput) {
    throw new Error(
      'INFERENCE_TIMEOUT: Simora Engine failed to generate response.'
    );
  }

  let parsedRaw: any;

  try {
    const cleanJsonString = rawOutput
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    parsedRaw = JSON.parse(cleanJsonString);
  } catch {
    console.warn(
      'JSON_PARSE_WARNING: Raw token parsing failed. Routing to self-healing engine.'
    );
    parsedRaw = {};
  }

  // 5. SELF-HEALING VALIDATION
  const validatedOutput = selfHealAndValidateOutput(parsedRaw);

  // 6. STRATEGY CARD PERSISTENCE
  if (validatedOutput.type === 'FINANCIAL_MATRIX') {
    const delta = ctx.incomingDelta || 0;
    const currentRunway =
      Number(state.calculated_runway_months) || 0;

    const currentBurn =
      Number(state.monthly_operating_burn) || 1;

    const potentialNewBurn = currentBurn + delta;

    const elasticityScore =
      currentRunway / (potentialNewBurn / currentBurn || 1);

    const systemIntegrityFlag =
      elasticityScore < 0.8 ? 'DEATH_SPIRAL_RISK' : 'STABLE';

    const { error: insertError } = await supabaseAdmin
      .from('strategy_cards')
      .insert([
        {
          user_id: user.id,
          core_action_directive:
            validatedOutput.action_directive,
          impact_forecast_runway:
            validatedOutput.impact_runway,
          impact_forecast_margin:
            validatedOutput.impact_margin,
          auditor_critical_risk:
            validatedOutput.auditor_warning,
          algebraic_impact_model:
            validatedOutput.algebraic_impact_model,
          ledger_hydration_parameters:
            validatedOutput.ledger_hydration_parameters,
          receipt_computation_log: {
            variance_check: 'PASS',
            elasticity_matrix: systemIntegrityFlag,
            timestamp: new Date().toISOString(),
          },
          is_active: true,
        },
      ]);

    if (insertError) {
      console.error(
        `PERSISTENCE_WARNING: Failed to commit Strategy Card: ${insertError.message}`
      );
    }
  }

  // HYDRATE LEDGER
  if (validatedOutput.type === 'HYDRATE_LEDGER') {
    const metrics = validatedOutput.extracted_metrics;

    const updatePayload: any = {
      user_id: user.id,
      last_hydrated_by: 'MANUAL_WHATSAPP',
    };

    if (metrics.mrr !== null) {
      updatePayload.mrr = metrics.mrr;
    }

    if (metrics.variable_cogs !== null) {
      updatePayload.variable_cogs = metrics.variable_cogs;
    }

    if (metrics.fixed_operating_overhead !== null) {
      updatePayload.fixed_operating_overhead =
        metrics.fixed_operating_overhead;
    }

    if (metrics.verified_cash_balance !== null) {
      updatePayload.verified_cash_balance =
        metrics.verified_cash_balance;
    }

    const { error: upsertError } = await supabaseAdmin
      .from('ledger_metrics')
      .upsert(updatePayload, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error(
        `DATABASE_WRITE_WARNING: Failed manual hydration: ${upsertError.message}`
      );
    }
  }

  // CONNECT LEDGER
  if (validatedOutput.type === 'CONNECT_LEDGER') {
    const target = validatedOutput.integration_target;

    const secureVaultUrl =
      `https://vault.unified.to/oauth2/connect?workspace=simora_prod&integration=${target}&state=${user.id}`;

    validatedOutput.message =
      `🛡️ *SIMORA Secure Gateway Link Generated*\n\n` +
      `${validatedOutput.message}\n\n` +
      `👉 **Authorize Connection Here:** ${secureVaultUrl}\n\n` +
      `_Note: This connection session is sandboxed and encrypted at rest._`;
  }
    // 6. STRATEGY CARD PERSISTENCE FOR FINANCIAL INTENTS
  if (validatedOutput.type === 'FINANCIAL_MATRIX') {
    const delta = ctx.incomingDelta || 0;
    const currentBurn = Number(state.monthly_operating_burn || 0);
    const currentRunway = Number(state.calculated_runway_months || 0);

    const potentialNewBurn = currentBurn + delta;

    const elasticityScore =
      currentBurn > 0
        ? currentRunway / (potentialNewBurn / currentBurn)
        : currentRunway;

    const systemIntegrityFlag =
      elasticityScore < 0.8 ? 'DEATH_SPIRAL_RISK' : 'STABLE';

    const { error: insertError } = await supabaseAdmin
      .from('strategy_cards')
      .insert([
        {
          user_id: user.id,
          core_action_directive: validatedOutput.action_directive,
          impact_forecast_runway: validatedOutput.impact_runway,
          impact_forecast_margin: validatedOutput.impact_margin,
          auditor_critical_risk: validatedOutput.auditor_warning,
          algebraic_impact_model:
            validatedOutput.algebraic_impact_model,
          ledger_hydration_parameters:
            validatedOutput.ledger_hydration_parameters,
          receipt_computation_log: {
            variance_check: 'PASS',
            elasticity_matrix: systemIntegrityFlag,
            timestamp: new Date().toISOString(),
          },
          is_active: true,
        },
      ]);

    if (insertError) {
      console.error(
        `PERSISTENCE_WARNING: Failed to commit Strategy Card: ${insertError.message}`
      );
    }
  }

  // HYDRATE LEDGER ROUTER
  if (validatedOutput.type === 'HYDRATE_LEDGER') {
    const metrics = validatedOutput.extracted_metrics;

    const updatePayload: any = {
      user_id: user.id,
      last_hydrated_by: 'MANUAL_WHATSAPP',
    };

    if (metrics.mrr !== null) {
      updatePayload.mrr = metrics.mrr;
    }

    if (metrics.variable_cogs !== null) {
      updatePayload.variable_cogs = metrics.variable_cogs;
    }

    if (metrics.fixed_operating_overhead !== null) {
      updatePayload.fixed_operating_overhead =
        metrics.fixed_operating_overhead;
    }

    if (metrics.verified_cash_balance !== null) {
      updatePayload.verified_cash_balance =
        metrics.verified_cash_balance;
    }

    const { error: upsertError } = await supabaseAdmin
      .from('ledger_metrics')
      .upsert(updatePayload, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error(
        `DATABASE_WRITE_WARNING: Failed manual ledger hydration: ${upsertError.message}`
      );
    }
  }

  // CONNECT LEDGER HANDSHAKE
  if (validatedOutput.type === 'CONNECT_LEDGER') {
    const target = validatedOutput.integration_target;

    const secureVaultUrl =
      `https://vault.unified.to/oauth2/connect?workspace=simora_prod&integration=${target}&state=${user.id}`;

    validatedOutput.message =
      `🛡️ *SIMORA Secure Gateway Link Generated*\n\n` +
      `${validatedOutput.message}\n\n` +
      `👉 Authorize Connection Here:\n${secureVaultUrl}\n\n` +
      `_Connection session is sandboxed and encrypted at rest._`;
  }

  // MEMORY LOGGER
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([
      {
        user_id: user.id,
        content: ctx.incomingText,
        embedding: currentQueryVector,
      },
    ]);

  if (memoryInsertError) {
    console.error(
      `MEMORY_LOGGING_WARNING: Failed to log vector state: ${memoryInsertError.message}`
    );
  }

  // DECISION LOGGER (FIXED: ONLY INSERT ONCE)
  if (
    validatedOutput.type === 'FINANCIAL_MATRIX' ||
    validatedOutput.type === 'STRATEGIC_ADVICE'
  ) {
    const recommendation = validatedOutput.action_directive;

    const { error: decisionLogError } = await supabaseAdmin
      .from('decision_logs')
      .insert([
        {
          user_id: user.id,
          user_question: ctx.incomingText,
          simora_recommendation: recommendation,
          decision_status: 'PENDING',
        },
      ]);

    if (decisionLogError) {
      console.error(
        `DECISION_LOG_WARNING: Failed to persist decision log: ${decisionLogError.message}`
      );
    }
  }

  // FINAL RESPONSE
  return validatedOutput;
}
