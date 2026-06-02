import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

/**
 * SIMORA CORE ENGINE - PHASE 3 EXECUTION ROUTINE
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 */

interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number; // The specific metric value being updated/reported
}

interface SimoraOutput {
  action_directive: string;
  impact_runway: string;
  impact_margin: string;
  auditor_warning: string;
  receipts_log: any;
}

export async function executeSimoraCoreEngine(
  ctx: IngestionContext,
  supabaseAdmin: SupabaseClient,
  openai: OpenAI
): Promise<SimoraOutput> {
  // 1. DATA HYDRATION & STATE ALIGNMENT
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

  // 2. MATH GUARDRAIL GATE 1: VARIANCE SCANNER (2.5σ STATISTICAL FILTER)
  // We calculate drift based on the incomingDelta vs the historical monthly_operating_burn
  const sigmaBaseline = Number(state.monthly_operating_burn) * 0.15; // Assuming 15% historical std dev
  const delta = ctx.incomingDelta || 0;
  
  if (Math.abs(delta) > 2.5 * sigmaBaseline) {
    // Per Blueprint Document 4: Halt the pipeline and flag anomaly
    throw new Error("GUARDRAIL_HALT: Variance Scanner detected a delta > 2.5σ. Verify structural environmental pivot.");
  }

  // 3. CONTEXTUAL AUGMENTATION (SIMULATED FOR GROQ COMPATIBILITY)
  // Groq focuses on high-speed inference and doesn't host an embeddings endpoint.
  // Since our Vector Search is simulated for Phase 3, we bypass the API call entirely.
  const queryVector = [0.0];

  // Vector Search Simulated Call (as per Blueprint Doc 4, Section 3)
  const vectorContext = `[Ingested Ledger Context: Current logistics burn is ${state.monthly_operating_burn}/Day]`;

  // 4. MATH GUARDRAIL GATE 2: COUPLED-ELASTICITY MATRIX
  // Logic: Calculate inverse-decay (Runway vs Burn)
  // If burn increases without a corresponding 1:1.2 runway defense, we flag a death spiral.
  const currentRunway = Number(state.calculated_runway_months);
  const potentialNewBurn = Number(state.monthly_operating_burn) + delta;
  const elasticityScore = currentRunway / (potentialNewBurn / Number(state.monthly_operating_burn));
  
  const systemIntegrityFlag = elasticityScore < 0.8 ? "DEATH_SPIRAL_RISK" : "STABLE";

  // 5. CORE INFERENCE PIPELINE (GROQ LLAMA-3.3) - MATH GUARDRAIL GATE 3: CYNICAL AUDITOR
  const systemFrameworkContext = `
    SYSTEM_ARCHETYPE_TIER: ${user.assigned_tier}
    GEOGRAPHY_CODE: ${user.geo_country_code}-${user.geo_city_region}
    INDUY_TAXONOMY_ID: ${user.industry_taxonomy_id}
    CURRENT_RESILIENCE_SCORE: ${state.resilience_score}
    ELASTICITY_STATUS: ${systemIntegrityFlag}
    [ENVIRONMENTAL_LAW_CONSTANTS]
    Assume standard physical constraints, localized logistics routing fees, and energy spot adjustments are locked.
  `;

  const completion = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile', // Groq production model
    temperature: 0.0, // Eliminate behavioral drift
    response_format: { type: "json_object" },
    messages: [
      { 
        role: 'system', 
        content: `You are the Simora System Calculation Engine. You operate as a Cynical Corporate Auditor. 
        Analyze inputs under strict first-principles system logic rules. 
        Your goal is to find the single most fragile data asset and provide a pre-mortem warning.` 
      },
      { role: 'system', content: systemFrameworkContext },
      { 
        role: 'user', 
        content: `
          CONTEXT_CHUNKS: ${vectorContext}
          DYNAMIC_INPUT: ${ctx.incomingText}
          
          Generate a JSON response with:
          - action_directive: A singular high-leverage instruction.
          - impact_runway: Forecasted runway extension (e.g. "+15%").
          - impact_margin: Operating margin protection (e.g. "Defends 30%").
          - auditor_warning: The raw, hyper-realistic pre-mortem warning string.
          - receipts_log: A JSON object containing the math constants and formulas applied.
        `
      }
    ],
  });

  const rawOutput = completion.choices[0].message.content;
  if (!rawOutput) throw new Error("INFERENCE_TIMEOUT: Simora Engine failed to generate response.");
  
  const parsedOutput = JSON.parse(rawOutput);

  // 6. DATABASE PERSISTENCE (strategy_cards Table)
  const { error: insertError } = await supabaseAdmin
    .from('strategy_cards')
    .insert([{
      user_id: user.id,
      core_action_directive: parsedOutput.action_directive,
      impact_forecast_runway: parsedOutput.impact_runway,
      impact_forecast_margin: parsedOutput.impact_margin,
      auditor_critical_risk: parsedOutput.auditor_warning,
      receipts_computation_log: {
        ...parsedOutput.receipts_log,
        variance_check: "PASS",
        elasticity_matrix: systemIntegrityFlag,
        timestamp: new Date().toISOString()
      },
      is_active: true
    }]);

  if (insertError) {
    throw new Error(`PERSISTENCE_ERROR: Failed to commit Strategy Card: ${insertError.message}`);
  }

  return {
    action_directive: parsedOutput.action_directive,
    impact_runway: parsedOutput.impact_runway,
    impact_margin: parsedOutput.impact_margin,
    auditor_warning: parsedOutput.auditor_warning,
    receipts_log: parsedOutput.receipts_log
  };
}
