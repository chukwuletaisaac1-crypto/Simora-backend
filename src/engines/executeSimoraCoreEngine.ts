import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';

// Force Node to prioritize IPv4. Bypasses the cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE — PHASE 5: INTENT ROUTER
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 *
 * The engine no longer forces every input into a financial matrix schema.
 * It first classifies intent, then routes to one of three response shapes:
 *   - CASUAL_CHAT        → conversational, no math, no persistence to strategy_cards
 *   - STRATEGIC_ADVICE    → qualitative reasoning, no hard financial projection
 *   - FINANCIAL_MATRIX    → full guardrail math + strategy card persistence
 *
 * This keeps Simora from hallucinating runway/margin numbers when a user
 * asks something like "what's a good Korean movie?" or "should I hire a
 * co-founder?" — those are real questions but not financial computations.
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

type SimoraEngineResponse =
  | { type: 'CASUAL_CHAT'; message: string }
  | { type: 'STRATEGIC_ADVICE'; action_directive: string; strategic_framework: string; auditor_warning?: string }
  | { type: 'FINANCIAL_MATRIX'; action_directive: string; impact_runway: string; impact_margin: string; auditor_warning?: string; receipts_log?: any };

// Internal shape the LLM is asked to produce — slightly looser than the
// public union so we can validate/normalize before returning.
interface RawIntentOutput {
  type: 'CASUAL_CHAT' | 'STRATEGIC_ADVICE' | 'FINANCIAL_MATRIX';
  message?: string;
  action_directive?: string;
  strategic_framework?: string;
  impact_runway?: string;
  impact_margin?: string;
  auditor_warning?: string;
  receipts_log?: any;
}

// ============================================================================
// PROTOTYPE EMBEDDING BYPASS
// Railway's native fetch was clashing with Hugging Face's DNS. For now we
// return a neutral vector to satisfy the pgvector column. Swap for real
// OpenAI/HF embeddings in Phase 6.
// ============================================================================
async function getHuggingFaceEmbedding(text: string): Promise<number[]> {
  console.log('[PROTOTYPE MODE] Bypassing HF network call. Returning neutral vector for demo.');
  return Array(384).fill(0.01);
}

// ============================================================================
// MAIN ENGINE
// ============================================================================
export async function executeSimoraCoreEngine(
  ctx: IngestionContext,
  supabaseAdmin: SupabaseClient,
  openai: OpenAI,
): Promise<SimoraEngineResponse> {

  // ── 1. DATA HYDRATION & STATE ALIGNMENT ──────────────────────────────────
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('whatsapp_id_hash', ctx.whatsappHash)
    .single();

  if (userErr) {
    throw new Error(`SUPABASE_DATABASE_CRASH: ${userErr.message} (Code: ${userErr.code})`);
  }
  if (!user) {
    throw new Error(`CRITICAL_SYSTEM_ERROR: User Profile Unmapped for Hash ${ctx.whatsappHash}`);
  }

  const { data: state, error: stateErr } = await supabaseAdmin
    .from('system_states')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (stateErr || !state) {
    throw new Error(`CRITICAL_SYSTEM_ERROR: System State Missing for User ${user.id}`);
  }

  // ── 2. LIVE CONTEXTUAL RETRIEVAL (VECTOR MEMORY) ─────────────────────────
  const currentQueryVector = await getHuggingFaceEmbedding(ctx.incomingText);

  const { data: matchedContextRecords, error: vectorSearchError } = await supabaseAdmin.rpc(
    'match_ledger_embeddings',
    {
      query_embedding: currentQueryVector,
      match_threshold: 0.3,
      match_count: 3,
      p_user_id: user.id,
    },
  );

  if (vectorSearchError) {
    throw new Error(`VECTOR_SEARCH_ERROR: Database execution anomaly during recall: ${vectorSearchError.message}`);
  }

  let vectorContext = '[No relevant historical context discovered. Proceeding under baseline assumptions.]';
  if (matchedContextRecords && matchedContextRecords.length > 0) {
    vectorContext = matchedContextRecords
      .map((record: any, idx: number) => `[Historical Event #${idx + 1}: ${record.content}]`)
      .join('\n');
  }

  // ── 3. SYSTEM FRAMEWORK CONTEXT (always available to the LLM) ───────────
  const systemFrameworkContext = `
    SYSTEM_ARCHETYPE_TIER: ${user.assigned_tier}
    GEOGRAPHY_CODE: ${user.geo_country_code}-${user.geo_city_region}
    INDUSTRY_TAXONOMY_ID: ${user.industry_taxonomy_id}
    CURRENT_RESILIENCE_SCORE: ${state.resilience_score}
    CURRENT_RUNWAY_MONTHS: ${state.calculated_runway_months}
    MONTHLY_OPERATING_BURN: ${state.monthly_operating_burn}
  `;

  // ── 4. INTENT ROUTER + INFERENCE (single LLM call decides shape) ────────
  const completion = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are SIMORA — a genius human co-founder embedded inside a WhatsApp chat. You are sharp, warm, occasionally blunt, and you know exactly when a question deserves a number and when it doesn't.

You MUST first silently classify the user's incoming message into exactly one of three intents, then respond ONLY in the matching JSON shape. Never blend shapes. Never invent financial figures for a non-financial question.

INTENT 1 — CASUAL_CHAT
Use this when the message is small talk, a casual question, an opinion request, or anything with no real business decision attached (e.g. "what's a good Korean movie?", "how's it going", "lol that's funny").
Shape: { "type": "CASUAL_CHAT", "message": "<a natural, warm, conversational reply — no business jargon, no forced advice>" }

INTENT 2 — STRATEGIC_ADVICE
Use this when the user is asking a real qualitative business or strategic question that does NOT require hard financial computation (e.g. "should I hire a co-founder?", "how do I position against a bigger competitor?", "is now a good time to raise?").
Shape: { "type": "STRATEGIC_ADVICE", "action_directive": "<one clear, high-leverage instruction>", "strategic_framework": "<the reasoning model or mental framework you applied, explained in plain language>", "auditor_warning": "<optional — a sharp pre-mortem risk, omit the key entirely if nothing material applies>" }

INTENT 3 — FINANCIAL_MATRIX
Use this ONLY when the user has given you an actual financial/operational scenario with numbers, deltas, or a concrete business event that affects burn, runway, or margin (e.g. "we closed 3 deals but lost 5 clients, burn is $42k/month", "we just signed a $10k/mo contract").
Shape: { "type": "FINANCIAL_MATRIX", "action_directive": "<one clear, high-leverage instruction>", "impact_runway": "<forecasted runway effect, e.g. '+15%'>", "impact_margin": "<operating margin effect, e.g. 'Defends 30%'>", "auditor_warning": "<optional — sharp pre-mortem risk, omit the key entirely if nothing material applies>", "receipts_log": { <key math constants/assumptions you used> } }

RULES:
- If you are not given real numbers, NEVER invent impact_runway or impact_margin. That is a FINANCIAL_MATRIX hallucination and is forbidden — route to STRATEGIC_ADVICE or CASUAL_CHAT instead.
- Respond with raw JSON only. No markdown, no preamble, no commentary outside the JSON object.
- Match the user's energy. If they're casual, be casual. If they bring numbers, get precise.`,
      },
      { role: 'system', content: `BUSINESS CONTEXT:\n${systemFrameworkContext}` },
      {
        role: 'user',
        content: `CONTEXT_CHUNKS FROM HISTORICAL LOGS:\n${vectorContext}\n\nNEW INCOMING MESSAGE:\n${ctx.incomingText}\n\nClassify the intent and respond in the matching JSON shape only.`,
      },
    ],
  });

  const rawOutput = completion.choices[0].message.content;
  if (!rawOutput) throw new Error('INFERENCE_TIMEOUT: Simora Engine failed to generate response.');

  const parsedOutput: RawIntentOutput = JSON.parse(rawOutput);

  // ── 5. VALIDATE INTENT TYPE — fail safe rather than silently coercing ───
  if (!['CASUAL_CHAT', 'STRATEGIC_ADVICE', 'FINANCIAL_MATRIX'].includes(parsedOutput.type)) {
    throw new Error(`INTENT_ROUTER_ERROR: Model returned unrecognized type "${parsedOutput.type}"`);
  }

  // ── 6. GUARDRAILS — only apply financial math gates for FINANCIAL_MATRIX ─
  if (parsedOutput.type === 'FINANCIAL_MATRIX') {
    const sigmaBaseline = Number(state.monthly_operating_burn) * 0.15;
    const delta = ctx.incomingDelta || 0;

    if (Math.abs(delta) > 2.5 * sigmaBaseline) {
      throw new Error('GUARDRAIL_HALT: Variance Scanner detected a delta > 2.5 sigma. Verify structural environmental pivot.');
    }

    const currentRunway = Number(state.calculated_runway_months);
    const potentialNewBurn = Number(state.monthly_operating_burn) + delta;
    const elasticityScore = currentRunway / (potentialNewBurn / Number(state.monthly_operating_burn));
    const systemIntegrityFlag = elasticityScore < 0.8 ? 'DEATH_SPIRAL_RISK' : 'STABLE';

    if (!parsedOutput.action_directive || !parsedOutput.impact_runway || !parsedOutput.impact_margin) {
      throw new Error('SCHEMA_VALIDATION_ERROR: FINANCIAL_MATRIX response missing required fields.');
    }

    // Persist to strategy_cards — only financial scenarios get a card
    const { error: insertError } = await supabaseAdmin
      .from('strategy_cards')
      .insert([{
        user_id: user.id,
        core_action_directive: parsedOutput.action_directive,
        impact_forecast_runway: parsedOutput.impact_runway,
        impact_forecast_margin: parsedOutput.impact_margin,
        auditor_critical_risk: parsedOutput.auditor_warning ?? null,
        receipts_computation_log: {
          ...(parsedOutput.receipts_log ?? {}),
          variance_check: 'PASS',
          elasticity_matrix: systemIntegrityFlag,
          timestamp: new Date().toISOString(),
        },
        is_active: true,
      }]);

    if (insertError) {
      throw new Error(`PERSISTENCE_ERROR: Failed to commit Strategy Card: ${insertError.message}`);
    }
  }

  if (parsedOutput.type === 'STRATEGIC_ADVICE') {
    if (!parsedOutput.action_directive || !parsedOutput.strategic_framework) {
      throw new Error('SCHEMA_VALIDATION_ERROR: STRATEGIC_ADVICE response missing required fields.');
    }
  }

  if (parsedOutput.type === 'CASUAL_CHAT') {
    if (!parsedOutput.message) {
      throw new Error('SCHEMA_VALIDATION_ERROR: CASUAL_CHAT response missing message field.');
    }
  }

  // ── 7. ASYNC MEMORY PERSISTENCE — log every message regardless of intent ─
  // Casual chats still build long-term context (e.g. rapport, preferences).
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([{
      user_id: user.id,
      content: ctx.incomingText,
      embedding: currentQueryVector,
    }]);

  if (memoryInsertError) {
    console.error(`MEMORY_LOGGING_WARNING: Failed to log current text vectors: ${memoryInsertError.message}`);
  }

  // ── 8. RETURN — clean, validated, intent-shaped response ────────────────
  switch (parsedOutput.type) {
    case 'CASUAL_CHAT':
      return {
        type: 'CASUAL_CHAT',
        message: parsedOutput.message!,
      };

    case 'STRATEGIC_ADVICE':
      return {
        type: 'STRATEGIC_ADVICE',
        action_directive: parsedOutput.action_directive!,
        strategic_framework: parsedOutput.strategic_framework!,
        ...(parsedOutput.auditor_warning ? { auditor_warning: parsedOutput.auditor_warning } : {}),
      };

    case 'FINANCIAL_MATRIX':
      return {
        type: 'FINANCIAL_MATRIX',
        action_directive: parsedOutput.action_directive!,
        impact_runway: parsedOutput.impact_runway!,
        impact_margin: parsedOutput.impact_margin!,
        ...(parsedOutput.auditor_warning ? { auditor_warning: parsedOutput.auditor_warning } : {}),
        receipts_log: parsedOutput.receipts_log,
      };
  }
}
