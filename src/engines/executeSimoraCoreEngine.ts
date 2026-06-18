/**
 * Phase 3: Confidence Layer + WhatsApp-calibrated output
 *
 * Fixes applied (from session analysis):
 *   Bug 1 — confidence_score was calculated then silently dropped.
 *            Now carried through the schema, selfHeal, and return value.
 *   Bug 2 — system prompt had no length ceiling; responses were McKinsey-deck
 *            length inside a WhatsApp bubble. Replaced with hard per-field
 *            sentence caps enforced in the prompt.
 *   Design — confidence badge is now the *replacement* for hedging verbosity,
 *             not an addition to it. STRATEGIC_ADVICE + FINANCIAL_MATRIX only.
 *
 * Model note: llama-3.3-70b-versatile via Groq's OpenAI-compatible endpoint.
 * Groq does NOT enforce OpenAI's strict json_schema server-side — we use
 * json_object mode and enforce the schema ourselves in selfHealAndValidateOutput.
 */

import OpenAI from "openai";
import { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfidenceData {
  score: number; // 0–100
  grade: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[]; // ≤3 short reasons
}

interface CasualChat {
  type: "CASUAL_CHAT";
  message: string;
}

interface StrategicAdvice {
  type: "STRATEGIC_ADVICE";
  action_directive: string;
  strategic_framework: string;
  analytical_baselines: string;
  auditor_warning: string | null;
  confidence_score: number;
  confidence_grade: "HIGH" | "MEDIUM" | "LOW";
  confidence_reasons: string[];
}

interface FinancialMatrix {
  type: "FINANCIAL_MATRIX";
  action_directive: string;
  algebraic_impact_model: string;
  impact_runway: string;
  impact_margin: string;
  ledger_hydration_parameters: string[];
  auditor_warning: string | null;
  confidence_score: number;
  confidence_grade: "HIGH" | "MEDIUM" | "LOW";
  confidence_reasons: string[];
}

export type SimoraEngineResponse = CasualChat | StrategicAdvice | FinancialMatrix;

interface EngineContext {
  userId: string;
  whatsappHash: string;
  industry: string;
  inputMessage: string;
  systemState?: Record<string, unknown>;
  ledgerContext?: Record<string, unknown>;
  vectorMemory?: string[];
}

// ---------------------------------------------------------------------------
// Confidence Calculator
// ---------------------------------------------------------------------------

function calculateConfidenceScore(
  ctx: EngineContext,
  intentType: "CASUAL_CHAT" | "STRATEGIC_ADVICE" | "FINANCIAL_MATRIX"
): ConfidenceData {
  // Confidence is meaningless for casual chat — callers skip it.
  if (intentType === "CASUAL_CHAT") {
    return { score: 100, grade: "HIGH", reasons: [] };
  }

  const reasons: string[] = [];
  let score = 100;

  const ledger = ctx.ledgerContext ?? {};
  const state = ctx.systemState ?? {};

  // No live ledger data
  if (Object.keys(ledger).length === 0) {
    score -= 30;
    reasons.push("No ledger data connected — estimates use industry averages");
  }

  // Missing key financial fields
  const financialKeys = ["mrr", "burn_rate", "gross_revenue", "cac", "ltv"];
  const missing = financialKeys.filter((k) => !ledger[k]);
  if (missing.length >= 3) {
    score -= 20;
    reasons.push(`${missing.length} core metrics unavailable (${missing.slice(0, 2).join(", ")}…)`);
  } else if (missing.length >= 1) {
    score -= 10;
    reasons.push(`${missing.length} metric(s) missing: ${missing.join(", ")}`);
  }

  // No historical state context
  if (Object.keys(state).length === 0) {
    score -= 15;
    reasons.push("No prior system state — first-principles only");
  }

  // No vector memory (prior conversation context)
  if (!ctx.vectorMemory || ctx.vectorMemory.length === 0) {
    score -= 10;
    reasons.push("No conversation history loaded");
  }

  // For FINANCIAL_MATRIX: extra penalty if purely algebraic (no real numbers)
  if (intentType === "FINANCIAL_MATRIX" && missing.length >= 3) {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  const grade: "HIGH" | "MEDIUM" | "LOW" =
    score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW";

  // Keep reasons concise — max 3
  return { score, grade, reasons: reasons.slice(0, 3) };
}

// ---------------------------------------------------------------------------
// System Prompt Builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(ctx: EngineContext, confidenceData: ConfidenceData): string {
  const ledgerSummary =
    ctx.ledgerContext && Object.keys(ctx.ledgerContext).length > 0
      ? JSON.stringify(ctx.ledgerContext, null, 2)
      : "No live ledger data. Use algebraic frameworks and industry benchmarks.";

  const stateSummary =
    ctx.systemState && Object.keys(ctx.systemState).length > 0
      ? JSON.stringify(ctx.systemState, null, 2)
      : "No prior system state.";

  const memoryBlock =
    ctx.vectorMemory && ctx.vectorMemory.length > 0
      ? ctx.vectorMemory.map((m, i) => `[${i + 1}] ${m}`).join("\n")
      : "No prior conversation memory.";

  return `You are SIMORA — an autonomous business intelligence co-founder and venture CFO.
Industry context: ${ctx.industry || "General SaaS/Startup"}.

PERSONALITY MANDATE:
- Voice: elite strategic co-founder + ruthless venture CFO. Zero passivity.
- Eliminate: "keep a close eye", "be cautious", "monitor closely", "it depends".
- Replace with: explicit action states — "Freeze the pricing reduction", "Audit environment sprawl", "Isolate the hosting invoice".
- Anchor ALL financial arguments in hard industrial benchmarks:
  B2B SaaS infrastructure COGS target: 8-15% of MRR.
  Average cloud environment waste: 27%.
  Healthy SaaS gross margin: 70-80%.
  Healthy CAC:LTV ratio: 1:3 minimum.

LENGTH MANDATE — WHATSAPP FORMAT:
- action_directive: 1 sentence, ≤20 words. Imperative. No hedging.
- strategic_framework: 2-3 sentences MAX. Dense, no fluff.
- analytical_baselines: 1-2 sentences with a specific benchmark or algebraic relationship.
- algebraic_impact_model: show the math, 2-3 sentences, specific formulas.
- impact_runway / impact_margin: 1 sentence each.
- auditor_warning: 1 sentence or null. Only if there is a genuine risk.
- message (CASUAL_CHAT): 1-2 sentences. Conversational. Don't force business advice.
- ledger_hydration_parameters: the exact DB/API keys needed to make this deterministic.

ABSOLUTE RULE ON "UNKNOWN":
You are FORBIDDEN from outputting "Unknown" for any financial variable.
If you lack the precise number, use algebraic logic: show the formula, name the variables,
explain the compounding relationship, and state the break-even threshold algebraically.
Example: "If CAC rises 10% and price drops 5%, CM = (P × (1-0.05)) - VC must hold above zero.
Solve: P_new > VC / 0.95. That is the floor."

CURRENT SYSTEM CONTEXT:
User Industry: ${ctx.industry}
Confidence Grade: ${confidenceData.grade} (${confidenceData.score}/100)
Confidence Reasons: ${confidenceData.reasons.join("; ") || "Full data available"}

LEDGER DATA:
${ledgerSummary}

SYSTEM STATE:
${stateSummary}

CONVERSATION MEMORY:
${memoryBlock}

INTENT ROUTING — OUTPUT SCHEMA:
You MUST classify the user's input into EXACTLY ONE of these three response types
and return a SINGLE valid JSON object. No markdown, no preamble, just JSON.

TYPE 1 — CASUAL_CHAT (non-business questions, greetings, off-topic):
{
  "type": "CASUAL_CHAT",
  "message": "string"
}

TYPE 2 — STRATEGIC_ADVICE (qualitative business questions, hiring, positioning, growth):
{
  "type": "STRATEGIC_ADVICE",
  "action_directive": "string",
  "strategic_framework": "string",
  "analytical_baselines": "string",
  "auditor_warning": "string | null",
  "confidence_score": ${confidenceData.score},
  "confidence_grade": "${confidenceData.grade}",
  "confidence_reasons": ${JSON.stringify(confidenceData.reasons)}
}

TYPE 3 — FINANCIAL_MATRIX (cost, margin, pricing, runway, burn rate, P&L questions):
{
  "type": "FINANCIAL_MATRIX",
  "action_directive": "string",
  "algebraic_impact_model": "string",
  "impact_runway": "string",
  "impact_margin": "string",
  "ledger_hydration_parameters": ["string"],
  "auditor_warning": "string | null",
  "confidence_score": ${confidenceData.score},
  "confidence_grade": "${confidenceData.grade}",
  "confidence_reasons": ${JSON.stringify(confidenceData.reasons)}
}

CLASSIFICATION RULES:
- "What's a good Korean movie?" → CASUAL_CHAT
- "Should I hire a co-founder?" → STRATEGIC_ADVICE
- "Our CAC increased 10%, should we expand ads?" → STRATEGIC_ADVICE (CAC is strategic, not a P&L calc)
- "Fuel jumped 14% and we're dropping price 5%, what happens to margin?" → FINANCIAL_MATRIX
- Do NOT output FINANCIAL_MATRIX for questions where no algebraic calculation is meaningful.
- The confidence_score, confidence_grade, and confidence_reasons fields MUST be copied exactly
  from the values pre-injected above — do not invent your own.`;
}

// ---------------------------------------------------------------------------
// Self-Heal & Validate
// ---------------------------------------------------------------------------

function selfHealAndValidateOutput(
  raw: unknown,
  confidenceData: ConfidenceData
): SimoraEngineResponse {
  if (typeof raw !== "object" || raw === null) {
    return {
      type: "CASUAL_CHAT",
      message: "I ran into a processing issue. Try rephrasing your question.",
    };
  }

  const obj = raw as Record<string, unknown>;

  // Patch confidence onto STRATEGIC_ADVICE / FINANCIAL_MATRIX in case model dropped it
  if (obj.type === "STRATEGIC_ADVICE" || obj.type === "FINANCIAL_MATRIX") {
    if (typeof obj.confidence_score !== "number") {
      obj.confidence_score = confidenceData.score;
    }
    if (typeof obj.confidence_grade !== "string") {
      obj.confidence_grade = confidenceData.grade;
    }
    if (!Array.isArray(obj.confidence_reasons)) {
      obj.confidence_reasons = confidenceData.reasons;
    }
  }

  // Validate CASUAL_CHAT
  if (obj.type === "CASUAL_CHAT") {
    if (typeof obj.message !== "string" || obj.message.trim() === "") {
      return {
        type: "CASUAL_CHAT",
        message: "Got your message — could you rephrase that?",
      };
    }
    return obj as CasualChat;
  }

  // Validate STRATEGIC_ADVICE
  if (obj.type === "STRATEGIC_ADVICE") {
    const required = ["action_directive", "strategic_framework", "analytical_baselines"];
    const missing = required.filter(
      (k) => typeof obj[k] !== "string" || (obj[k] as string).trim() === ""
    );
    if (missing.length > 0) {
      throw new Error(
        `STRATEGIC_ADVICE response missing required fields: ${missing.join(", ")}`
      );
    }
    return {
      type: "STRATEGIC_ADVICE",
      action_directive: obj.action_directive as string,
      strategic_framework: obj.strategic_framework as string,
      analytical_baselines: obj.analytical_baselines as string,
      auditor_warning:
        typeof obj.auditor_warning === "string" ? obj.auditor_warning : null,
      confidence_score: obj.confidence_score as number,
      confidence_grade: obj.confidence_grade as "HIGH" | "MEDIUM" | "LOW",
      confidence_reasons: obj.confidence_reasons as string[],
    };
  }

  // Validate FINANCIAL_MATRIX
  if (obj.type === "FINANCIAL_MATRIX") {
    const required = [
      "action_directive",
      "algebraic_impact_model",
      "impact_runway",
      "impact_margin",
    ];
    const missing = required.filter(
      (k) => typeof obj[k] !== "string" || (obj[k] as string).trim() === ""
    );
    if (missing.length > 0) {
      throw new Error(
        `FINANCIAL_MATRIX response missing required fields: ${missing.join(", ")}`
      );
    }
    return {
      type: "FINANCIAL_MATRIX",
      action_directive: obj.action_directive as string,
      algebraic_impact_model: obj.algebraic_impact_model as string,
      impact_runway: obj.impact_runway as string,
      impact_margin: obj.impact_margin as string,
      ledger_hydration_parameters: Array.isArray(obj.ledger_hydration_parameters)
        ? (obj.ledger_hydration_parameters as string[])
        : [],
      auditor_warning:
        typeof obj.auditor_warning === "string" ? obj.auditor_warning : null,
      confidence_score: obj.confidence_score as number,
      confidence_grade: obj.confidence_grade as "HIGH" | "MEDIUM" | "LOW",
      confidence_reasons: obj.confidence_reasons as string[],
    };
  }

  // Unrecognised type — fall back to casual
  return {
    type: "CASUAL_CHAT",
    message:
      "I received an unexpected response shape. Could you rephrase your question?",
  };
}

// ---------------------------------------------------------------------------
// Decision Log Writer (Supabase)
// ---------------------------------------------------------------------------

async function writeDecisionLog(
  supabase: SupabaseClient,
  ctx: EngineContext,
  result: SimoraEngineResponse,
  confidenceData: ConfidenceData
): Promise<void> {
  try {
    const logEntry = {
      user_id: ctx.userId,
      whatsapp_hash: ctx.whatsappHash,
      input_message: ctx.inputMessage,
      response_type: result.type,
      confidence_score: confidenceData.score,
      confidence_grade: confidenceData.grade,
      confidence_reasons: confidenceData.reasons,
      response_payload: result,
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("simora_decision_logs").insert(logEntry);
    if (error) {
      console.error("[ENGINE] Decision log write failed:", error.message);
    }
  } catch (err) {
    console.error("[ENGINE] Decision log exception:", err);
  }
}

// ---------------------------------------------------------------------------
// Strategy Card Writer (Supabase — FINANCIAL_MATRIX + STRATEGIC_ADVICE only)
// ---------------------------------------------------------------------------

async function writeStrategyCard(
  supabase: SupabaseClient,
  ctx: EngineContext,
  result: StrategicAdvice | FinancialMatrix
): Promise<void> {
  try {
    const card = {
      user_id: ctx.userId,
      industry: ctx.industry,
      response_type: result.type,
      action_directive: result.action_directive,
      confidence_score: result.confidence_score,
      confidence_grade: result.confidence_grade,
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("strategy_cards").insert(card);
    if (error) {
      console.error("[ENGINE] Strategy card write failed:", error.message);
    }
  } catch (err) {
    console.error("[ENGINE] Strategy card exception:", err);
  }
}

// ---------------------------------------------------------------------------
// Vector Memory Logger
// ---------------------------------------------------------------------------

async function logVectorMemory(
  supabase: SupabaseClient,
  ctx: EngineContext,
  result: SimoraEngineResponse,
  openai: OpenAI
): Promise<void> {
  try {
    const textToEmbed =
      result.type === "CASUAL_CHAT"
        ? `User: ${ctx.inputMessage} | SIMORA: ${result.message}`
        : `User: ${ctx.inputMessage} | SIMORA [${result.type}]: ${result.action_directive}`;

    const embeddingRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: textToEmbed,
    });

    const embedding = embeddingRes.data[0]?.embedding;
    if (!embedding) return;

    const { error } = await supabase.from("ledger_embeddings").insert({
      user_id: ctx.userId,
      content: textToEmbed,
      embedding,
      response_type: result.type,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("[ENGINE] Vector memory write failed:", error.message);
    }
  } catch (err) {
    console.error("[ENGINE] Vector memory exception:", err);
  }
}

// ---------------------------------------------------------------------------
// Main Engine Entry Point
// ---------------------------------------------------------------------------

export async function executeSimoraCoreEngine(
  ctx: EngineContext,
  supabase: SupabaseClient,
  openai: OpenAI
): Promise<SimoraEngineResponse> {
  console.log(`[ENGINE] Start — user=${ctx.userId} input="${ctx.inputMessage.slice(0, 80)}"`);

  // 1. Pre-classify intent heuristically to compute the right confidence score.
  //    A full classification happens inside the LLM; this is just for the confidence calc.
  //    We default to STRATEGIC_ADVICE (the more common non-casual type) and let the
  //    LLM correct the final classification.
  const heuristicIntent: "STRATEGIC_ADVICE" | "FINANCIAL_MATRIX" | "CASUAL_CHAT" =
    /margin|runway|burn|cogs|cac|ltv|mrr|arr|price|revenue|cost|profit|loss|cash|p&l|expense/i.test(
      ctx.inputMessage
    )
      ? "FINANCIAL_MATRIX"
      : /hire|expand|pivot|position|competi|brand|market|strateg|growth|partner|team|product/i.test(
          ctx.inputMessage
        )
      ? "STRATEGIC_ADVICE"
      : "CASUAL_CHAT";

  // 2. Calculate confidence
  const confidenceData = calculateConfidenceScore(ctx, heuristicIntent);
  console.log(
    `[ENGINE] Confidence — grade=${confidenceData.grade} score=${confidenceData.score}`
  );

  // 3. Build system prompt with confidence injected
  const systemPrompt = buildSystemPrompt(ctx, confidenceData);

  // 4. Call the model
  let rawParsed: unknown;
  try {
    const completion = await openai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 800,
      temperature: 0.3, // Low temp for consistent structured output
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: ctx.inputMessage },
      ],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    console.log(`[ENGINE] Raw LLM response: ${rawText.slice(0, 200)}`);

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    rawParsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("[ENGINE] LLM call or JSON parse failed:", err);
    throw new Error(`SIMORA_ENGINE_ERROR: LLM call failed — ${String(err)}`);
  }

  // 5. Self-heal & validate (attaches confidence if model dropped it)
  let result: SimoraEngineResponse;
  try {
    result = selfHealAndValidateOutput(rawParsed, confidenceData);
    console.log(`[ENGINE] Output type=${result.type}`);
  } catch (err) {
    console.error("[ENGINE] Validation failed:", err);
    throw new Error(`SIMORA_ENGINE_ERROR: Schema validation failed — ${String(err)}`);
  }

  // 6. Persist decision log (always)
  await writeDecisionLog(supabase, ctx, result, confidenceData);

  // 7. Persist strategy card (STRATEGIC_ADVICE + FINANCIAL_MATRIX only)
  if (result.type === "STRATEGIC_ADVICE" || result.type === "FINANCIAL_MATRIX") {
    await writeStrategyCard(supabase, ctx, result as StrategicAdvice | FinancialMatrix);
  }

  // 8. Log vector memory (all types — co-founder remembers everything)
  await logVectorMemory(supabase, ctx, result, openai);

  console.log(`[ENGINE] Done — type=${result.type}`);
  return result;
}
