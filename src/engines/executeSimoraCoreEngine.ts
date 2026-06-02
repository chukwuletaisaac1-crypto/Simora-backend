import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns'; // 1. Import the native Node DNS module

// 2. Force Node to prioritize IPv4. This completely bypasses the cloud container ENOTFOUND bug.
dns.setDefaultResultOrder('ipv4first');

/**
 * SIMORA CORE ENGINE - PHASE 4 REAL VECTOR MEMORY INTEGRATION
 * Path: ./src/engines/executeSimoraCoreEngine.ts
 */
// ... rest of your engine code remains exactly the same
interface IngestionContext {
  userId: string;
  whatsappHash: string;
  incomingText: string;
  incomingDelta?: number; 
}

interface SimoraOutput {
  action_directive: string;
  impact_runway: string;
  impact_margin: string;
  auditor_warning: string;
  receipts_log: any;
}

/**
 * Helper function to extract free vector embeddings from Hugging Face Inference API
 */
async function getHuggingFaceEmbedding(text: string): Promise<number[]> {
  const hfToken = process.env.HUGGINGFACE_API_KEY;
  if (!hfToken) {
    throw new Error("CRITICAL_CONFIGURATION_ERROR: HUGGINGFACE_API_KEY environment variable is missing.");
  }

  const response = await fetch(
    "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
    {
      headers: { 
        "Authorization": `Bearer ${hfToken.trim()}`,
        "Content-Type": "application/json",
        "User-Agent": "SimoraCoreEngine/1.0.0" // Prevents Cloudflare gateway from dropping the connection
      },
      method: "POST",
      body: JSON.stringify({ 
        inputs: text,
        options: { 
          wait_for_model: true // Forces the API to wait for the model to boot if it's sleeping
        }
      }),
    }
  );

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`HUGGING_FACE_API_ERROR: HTTP ${response.status} - ${errorDetails}`);
  }

  const embedding = await response.json();
  
  if (!embedding) {
    throw new Error("HUGGING_FACE_API_ERROR: Hugging Face returned an empty payload response.");
  }

  // Feature-extraction models sometimes wrap vectors in a nested array layer e.g., [[0.1, 0.2, ...]]
  const flatEmbedding = Array.isArray(embedding[0]) ? embedding[0] : embedding;

  // Validate we have a proper numeric array matching our 384-dimension column structure
  if (!Array.isArray(flatEmbedding) || typeof flatEmbedding[0] !== 'number') {
    throw new Error("HUGGING_FACE_API_ERROR: Unexpected matrix format. Failed to isolate flat numeric vector coordinates.");
  }

  return flatEmbedding as number[];
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

  // 2. MATH GUARDRAIL GATE 1: VARIANCE SCANNER (2.5 Sigma STATISTICAL FILTER)
  const sigmaBaseline = Number(state.monthly_operating_burn) * 0.15; 
  const delta = ctx.incomingDelta || 0;
  
  if (Math.abs(delta) > 2.5 * sigmaBaseline) {
    throw new Error("GUARDRAIL_HALT: Variance Scanner detected a delta > 2.5 sigma. Verify structural environmental pivot.");
  }

  // 3. LIVE CONTEXTUAL RETRIEVAL VIA HUGGING FACE & SUPABASE
  const currentQueryVector = await getHuggingFaceEmbedding(ctx.incomingText);

  // Perform a geometric cosine similarity search inside our ledger_embeddings database table
  const { data: matchedContextRecords, error: vectorSearchError } = await supabaseAdmin.rpc(
    'match_ledger_embeddings',
    {
      query_embedding: currentQueryVector,
      match_threshold: 0.3, 
      match_count: 3,        
      p_user_id: user.id
    }
  );

  if (vectorSearchError) {
    throw new Error(`VECTOR_SEARCH_ERROR: Database execution anomaly during recall: ${vectorSearchError.message}`);
  }

  // Consolidate past memories into a single context block for our LLM to read
  let vectorContext = `[No relevant historical context discovered. Proceeding under baseline assumptions.]`;
  if (matchedContextRecords && matchedContextRecords.length > 0) {
    vectorContext = matchedContextRecords
      .map((record: any, idx: number) => `[Historical Event #${idx + 1}: ${record.content}]`)
      .join('\n');
  }

  // 4. MATH GUARDRAIL GATE 2: COUPLED-ELASTICITY MATRIX
  const currentRunway = Number(state.calculated_runway_months);
  const potentialNewBurn = Number(state.monthly_operating_burn) + delta;
  const elasticityScore = currentRunway / (potentialNewBurn / Number(state.monthly_operating_burn));
  
  const systemIntegrityFlag = elasticityScore < 0.8 ? "DEATH_SPIRAL_RISK" : "STABLE";

  // 5. CORE INFERENCE PIPELINE (GROQ LLAMA-3.3)
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
    model: 'llama-3.3-70b-versatile',
    temperature: 0.0, 
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
          CONTEXT_CHUNKS FROM HISTORICAL LOGS: 
          ${vectorContext}

          NEW INCOMING DYNAMIC INPUT: 
          ${ctx.incomingText}
          
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

  // 6. ASYNC BACKGROUND ACTION: PERSIST NEW INPUT TO THE VECTOR MEMORY TABLE
  const { error: memoryInsertError } = await supabaseAdmin
    .from('ledger_embeddings')
    .insert([{
      user_id: user.id,
      content: ctx.incomingText,
      embedding: currentQueryVector
    }]);

  if (memoryInsertError) {
    console.error(`MEMORY_LOGGING_WARNING: Failed to log current text vectors: ${memoryInsertError.message}`);
  }

  // 7. DATABASE PERSISTENCE (strategy_cards Table)
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
