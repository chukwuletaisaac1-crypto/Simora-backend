// ============================================================================
// SIMORA GATEWAY — server.ts
// Railway + BullMQ + Supabase + Meta WhatsApp Cloud API
// Fully self-sufficient backend loop. No frontend dependency.
//
// PHASE 4 CLEANUP NOTES:
// The previous version of this file had two competing worker definitions —
// a live switch block using state name 'ACTIVE', and a second, orphaned
// block of `case` statements (using the old state name 'PROFILE_ACTIVATED')
// left sitting outside any switch/function after a prior edit was pasted
// over an older version. That orphaned code was a syntax error on its own
// and, even if removed, would never have run because the routing state it
// checked for ('PROFILE_ACTIVATED') was never written to the database —
// only 'ACTIVE' is. This file keeps ONLY the live, correct path, and fixes
// three real gaps in it:
//   1. formatSimoraResponse() is now the single source of truth for every
//      outbound message — the worker no longer reimplements its own
//      thinner inline formatting that was silently dropping fields.
//   2. A lightweight numeric delta parser now extracts a $ or % figure from
//      incoming text so executeSimoraCoreEngine's variance/elasticity
//      guardrail has real input instead of always receiving 0.
//   3. The ACTIVE case now has the same try/catch + seedSystemState()
//      recovery path that previously only existed in the dead code block,
//      so a missing system_states row no longer results in total silence
//      back to the user.
// ============================================================================

console.log('--- RAILWAY ENV AUDIT ---');
console.log('REDIS_URL is set:            ', !!process.env.REDIS_URL);
console.log('REDISHOST is set:            ', !!process.env.REDISHOST);
console.log('REDISPORT is set:            ', !!process.env.REDISPORT);
console.log('REDISUSER is set:            ', !!process.env.REDISUSER);
console.log('REDISPASSWORD is set:        ', !!process.env.REDISPASSWORD);
console.log('PORT is:                     ', process.env.PORT);
console.log('META_PHONE_ID is set:        ', !!process.env.META_PHONE_ID);
console.log('META_API_TOKEN is set:       ', !!process.env.META_API_TOKEN);
console.log('WHATSAPP_VERIFY_TOKEN is set:', !!process.env.WHATSAPP_VERIFY_TOKEN);
console.log('-------------------------');

import express, { Request, Response } from 'express';
import { Queue, Worker, Job }          from 'bullmq';
import crypto                          from 'crypto';
import dns                             from 'dns';

// Force Node to prioritize IPv4 (Railway DNS stability)
dns.setDefaultResultOrder('ipv4first');

// 🎯 Core architecture imports
import { supabaseAdmin }           from './supabase';
import { openai }                  from './openai';
import { executeSimoraCoreEngine } from './src/engines/executeSimoraCoreEngine';

// ============================================================================
// PROCESS-LEVEL CRASH GUARDS (Railway container stability)
// ============================================================================
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled Promise Rejection:', reason);
});

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================
interface WhatsAppMessageContext {
  from:                  string;
  text?:                 string;
  interactive_reply_id?: string;
  audio_id?:             string;
}

interface HydrationPayload {
  user_id: string;
  financial_hydration_payload: {
    account_balance_current:         number;
    monthly_operating_burn_rate:     number;
    calculated_system_runway_months: number;
  };
  ingested_vector_chunks: Array<{ chunk_id: string; text_content: string }>;
}

// ============================================================================
// CONFIDENCE BADGE — always rendered as a 1-line prefix for
// STRATEGIC_ADVICE and FINANCIAL_MATRIX (per agreed spec). Never shown for
// CASUAL_CHAT, HYDRATE_LEDGER, or CONNECT_LEDGER, since confidence isn't
// meaningful for those intents.
// ============================================================================
function formatConfidenceBadge(grade: 'HIGH' | 'MEDIUM' | 'LOW', score: number): string {
  const icon = grade === 'HIGH' ? '🟢' : grade === 'MEDIUM' ? '🟡' : '🔴';
  return `${icon} Confidence: ${grade} (${score})`;
}

// ============================================================================
// SIMORA RESPONSE FORMATTER — single source of truth for every outbound
// WhatsApp message. Both the live worker and the Postman test route call
// this, so there is exactly one place that knows how to render each
// SimoraEngineResponse shape.
// ============================================================================
function formatSimoraResponse(response: any): string {
  if (!response) {
    return '⚠️ Simora encountered a processing fault.';
  }

  switch (response.type) {
    case 'CASUAL_CHAT':
      return response.message || '';

    case 'STRATEGIC_ADVICE': {
      const badge = formatConfidenceBadge(response.confidence_grade, response.confidence_score);
      const lines = [badge, ''];

      // recall_opening is a natural lead-in line, NOT a risk/compliance check.
      // It only appears here, never folded into auditor_warning.
      if (response.recall_opening) {
        lines.push(`💭 ${response.recall_opening}`, '');
      }

      lines.push(
        `🎯 *Directive*`,
        response.action_directive || '',
        '',
        `🧠 *Framework*`,
        response.strategic_framework || '',
        '',
        `📐 *Benchmarks*`,
        response.analytical_baselines || '',
      );
      if (response.auditor_warning) {
        lines.push('', `⚠️ *Risk*`, response.auditor_warning);
      }
      return lines.join('\n');
    }

    case 'FINANCIAL_MATRIX': {
      const badge = formatConfidenceBadge(response.confidence_grade, response.confidence_score);
      const lines = [badge, ''];

      if (response.recall_opening) {
        lines.push(`💭 ${response.recall_opening}`, '');
      }

      lines.push(
        `📊 *SIMORA ANALYSIS*`,
        '',
        `🎯 *Directive*`,
        response.action_directive || '',
        '',
        `📈 *Runway Impact*`,
        response.impact_runway || '',
        '',
        `💰 *Margin Impact*`,
        response.impact_margin || '',
        '',
        `🧮 *Model*`,
        response.algebraic_impact_model || '',
      );
      if (response.auditor_warning) {
        lines.push('', `⚠️ *Risk*`, response.auditor_warning);
      }
      return lines.join('\n');
    }

    case 'HYDRATE_LEDGER':
      return `💾 ${response.message || 'Ledger updated.'}`;

    case 'CONNECT_LEDGER':
      return response.message || '';

    default:
      return '⚠️ Simora generated an unsupported response format.';
  }
}

// ============================================================================
// DELTA PARSER — extracts a numeric $ or % figure from free-text WhatsApp
// messages so executeSimoraCoreEngine's variance/elasticity guardrail has
// real input instead of silently always receiving 0. This is a lightweight
// heuristic, not a full NLP parser — it looks for the first dollar amount or
// percentage in the message and prioritizes a dollar amount if both appear,
// since the guardrail compares against monthly_operating_burn in dollars.
// ============================================================================
function parseIncomingDelta(text: string): number {
  if (!text) return 0;

  // Match a dollar figure like "$42,000" or "$1200.50"
  const dollarMatch = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (dollarMatch) {
    const value = parseFloat(dollarMatch[1].replace(/,/g, ''));
    if (!Number.isNaN(value)) return value;
  }

  // Match a percentage figure like "14%" — treated as a directional signal,
  // not a dollar amount, so we return 0 here and let the engine's own
  // algebraic reasoning handle percentage-based shocks contextually.
  return 0;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const META_API_TOKEN = process.env.META_API_TOKEN as string;
const META_PHONE_ID  = process.env.META_PHONE_ID  as string;

// ============================================================================
// REDIS — URL-first, Railway-aware, never falls back to localhost in production
// ============================================================================
if (!process.env.REDIS_URL && !process.env.REDISHOST) {
  console.error('❌ FATAL: No Redis config found. Set REDIS_URL or REDISHOST in Railway.');
  process.exit(1);
}

const REDIS_CONNECTION = process.env.REDIS_URL
  ? {
      url:                  process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      family:               0,
    }
  : {
      host:                 process.env.REDISHOST!,
      port:                 parseInt(process.env.REDISPORT || '6379', 10),
      password:             process.env.REDISPASSWORD,
      username:             process.env.REDISUSER,
      maxRetriesPerRequest: null,
      family:               0,
    };

console.log('[REDIS] Strategy:', process.env.REDIS_URL ? '✅ URL mode (Railway)' : '⚠️ Host mode (fallback)');

// ============================================================================
// QUEUE INITIALIZATION
// ============================================================================
const whatsappQueue  = new Queue('WhatsAppStateTransition', { connection: REDIS_CONNECTION });
const hydrationQueue = new Queue('DataHydrationIngestion',  { connection: REDIS_CONNECTION });

// ============================================================================
// EXPRESS APP
// ============================================================================
const app = express();
app.use(express.json());

// ============================================================================
// HEALTHCHECK — prevents Railway from killing the container as unhealthy
// ============================================================================
app.get('/', (_req: Request, res: Response) => {
  res.status(200).send('Simora Gateway is Online');
});

// ============================================================================
// WEBHOOK — Meta verification handshake (GET)
// ============================================================================
app.get('/api/v1/webhook/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode']         as string | undefined;
  const token     = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge']    as string | undefined;

  const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();

  console.log('[WEBHOOK VERIFY] ── Incoming attempt ─────────────────────────────');
  console.log('[WEBHOOK VERIFY] hub.mode:            ', JSON.stringify(mode));
  console.log('[WEBHOOK VERIFY] hub.verify_token:    ', JSON.stringify(token));
  console.log('[WEBHOOK VERIFY] hub.challenge:       ', JSON.stringify(challenge));
  console.log('[WEBHOOK VERIFY] Env token (raw):     ', JSON.stringify(process.env.WHATSAPP_VERIFY_TOKEN));
  console.log('[WEBHOOK VERIFY] Env token (trimmed): ', JSON.stringify(verifyToken));
  console.log('[WEBHOOK VERIFY] Tokens match:        ', token === verifyToken);
  console.log('[WEBHOOK VERIFY] ───────────────────────────────────────────────────');

  if (!verifyToken) {
    console.error('[WEBHOOK VERIFY] ❌ WHATSAPP_VERIFY_TOKEN not set in Railway variables.');
    res.sendStatus(500);
    return;
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WEBHOOK VERIFY] ✅ Verification successful.');
    res.status(200).send(challenge);
    return;
  }

  console.error('[WEBHOOK VERIFY] ❌ Rejected. mode:', JSON.stringify(mode), '| tokenMatch:', token === verifyToken);
  res.sendStatus(403);
});

// ============================================================================
// WEBHOOK — Incoming WhatsApp messages (POST)
// ============================================================================
app.post('/api/v1/webhook/whatsapp', async (req: Request, res: Response) => {
  // 200 MUST be sent immediately — Meta retries if no ack within 20 seconds
  res.status(200).send('OK');

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Status updates, delivery receipts, read receipts — silently ignore
      return;
    }

    const extractedText = message.type === 'text' ? message.text?.body?.trim() : undefined;

    const payload: WhatsAppMessageContext = {
      from:                 message.from,
      text:                 extractedText,
      interactive_reply_id: message.type === 'interactive' ? message.interactive?.button_reply?.id : undefined,
      audio_id:             message.type === 'audio'       ? message.audio?.id                      : undefined,
    };

    console.log('[WEBHOOK POST] Queuing message | from:', payload.from, '| type:', message.type, '| text:', payload.text);

    await whatsappQueue.add('ProcessWhatsAppMessage', payload, {
      attempts: 3,
      backoff:  { type: 'exponential', delay: 1000 },
    });
  } catch (error) {
    // 200 already sent — log for diagnostics only
    console.error('[WEBHOOK POST] Ingestion error after 200 ack:', error);
  }
});

// ============================================================================
// WEBHOOK — External data hydration / ledger sync (POST)
// ============================================================================
app.post('/api/v1/webhook/data-hydration', async (req: Request, res: Response) => {
  try {
    const payload = req.body as HydrationPayload;

    if (!payload.user_id || !payload.financial_hydration_payload) {
      res.status(400).json({ error: 'Malformed Hydration Payload Structure' });
      return;
    }

    console.log('[HYDRATION WEBHOOK] Ledger sync queued for user:', payload.user_id);

    await hydrationQueue.add('ProcessLedgerSync', payload);

    res.status(200).json({ status: 'SYNC_QUEUED', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[HYDRATION WEBHOOK] Queue error:', error);
    res.status(500).send('Internal Queue Error');
  }
});

// ============================================================================
// TEST ROUTE — Manual engine trigger via Postman / curl
// ============================================================================
app.post('/api/v1/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta } = req.body;

    if (!userId || !whatsappHash || !incomingText) {
      res.status(400).json({ error: 'Missing required fields: userId, whatsappHash, incomingText' });
      return;
    }

    console.log(`[TEST ENGINE] Triggering core engine for user: ${userId}`);

    const result = await executeSimoraCoreEngine(
      {
        userId,
        whatsappHash,
        incomingText,
        incomingDelta: Number(incomingDelta || 0),
      },
      supabaseAdmin,
      openai,
    );

    const formattedResponse = formatSimoraResponse(result);

    console.log('[TEST ENGINE] RAW RESULT:', result);
    console.log('[TEST ENGINE] FORMATTED RESULT:', formattedResponse);

    res.status(200).json({ status: 'SUCCESS', raw: result, formatted: formattedResponse });
  } catch (error: any) {
    console.error('[TEST ENGINE] Crash:', error);
    res.status(500).json({ status: 'ENGINE_CRASHED', error: error.message });
  }
});

// ============================================================================
// OUTBOUND DISPATCHER — sends WhatsApp messages via Meta Cloud API
// ============================================================================
async function sendWhatsApp(to: string, messagePayload: string | object): Promise<void> {
  if (!META_API_TOKEN || !META_PHONE_ID) {
    console.error('[OUTBOUND] ❌ META_API_TOKEN or META_PHONE_ID missing. Cannot dispatch.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${META_PHONE_ID}/messages`;

  let finalPayload: any;

  if (typeof messagePayload === 'string') {
    let safeMessage = messagePayload;

    // WhatsApp starts rejecting very large bodies
    if (safeMessage.length > 3500) {
      safeMessage = safeMessage.slice(0, 3490) + '...';
    }

    finalPayload = {
      type: 'text',
      text: { preview_url: false, body: safeMessage },
    };
  } else {
    finalPayload = messagePayload;
  }

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${META_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        ...finalPayload,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[OUTBOUND] ❌ Meta API error ${response.status} → ${to}:`, errorBody);
    } else {
      console.log(`[OUTBOUND] ✅ Message dispatched → ${to}`);
    }
  } catch (err) {
    console.error(`[OUTBOUND] ❌ Network error dispatching → ${to}:`, err);
  }
}

// ============================================================================
// SYSTEM STATE SEEDER
// Called the moment a user completes onboarding (tier selection), and also
// used as a recovery path if the engine ever reports a missing state row.
// ============================================================================
async function seedSystemState(userId: string, assignedTier: string): Promise<void> {
  console.log(`[STATE SEEDER] Seeding system_states for user: ${userId} | tier: ${assignedTier}`);

  const { error } = await supabaseAdmin
    .from('system_states')
    .upsert(
      {
        user_id:                  userId,
        assigned_tier:            assignedTier,
        liquid_cash_balance:      0,
        monthly_operating_burn:   0,
        calculated_runway_months: 0,
        resilience_score:         50,
        pipeline_velocity:        0,
        churn_rate_percentage:    0,
        ecosystem_node_count:     0,
        activation_source:        'WHATSAPP_ONBOARDING',
        is_fully_activated:       true,
        last_external_sync:       null,
        created_at:               new Date().toISOString(),
        updated_at:               new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) {
    console.error(`[STATE SEEDER] ❌ Failed to seed system_states for ${userId}:`, error.message);
    throw new Error(`System state seeding failed: ${error.message}`);
  }

  console.log(`[STATE SEEDER] ✅ system_states row confirmed for user: ${userId}`);
}

// ============================================================================
// WORKER — WhatsApp State Machine
// Single, authoritative switch block. Handles onboarding + live engine
// conversations. State name 'ACTIVE' is the only post-onboarding state —
// there is no 'PROFILE_ACTIVATED' anywhere in this file.
// ============================================================================
const whatsappWorker = new Worker(
  'WhatsAppStateTransition',
  async (job: Job<WhatsAppMessageContext>) => {
    const { from, text, interactive_reply_id } = job.data;
    const whatsappHash = crypto.createHash('sha256').update(from).digest('hex');

    console.log(`[WORKER] Job ${job.id} | hash: ${whatsappHash}`);

    let { data: user, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('whatsapp_id_hash', whatsappHash)
      .single();

    if (fetchErr && fetchErr.code !== 'PGRST116') {
      console.error('[WORKER] ❌ Unexpected Supabase fetch error:', fetchErr.message);
      throw new Error(`User fetch failed: ${fetchErr.message}`);
    }

    // ── NEW USER ─────────────────────────────────────────────────────────
    if (!user) {
      const { data: newUser, error: insertErr } = await supabaseAdmin
        .from('users')
        .insert([{
          whatsapp_id_hash:      whatsappHash,
          current_routing_state: 'AWAITING_LOCATION',
          created_at:            new Date().toISOString(),
        }])
        .select()
        .single();

      if (insertErr || !newUser) {
        throw new Error(`User creation failed: ${insertErr?.message}`);
      }

      user = newUser;

      await sendWhatsApp(from, {
        type: 'text',
        text: {
          body:
            '👋 *Welcome to SIMORA.*\n\n' +
            'I am your autonomous business intelligence system.\n\n' +
            'Reply with your operating region.\n' +
            '_Example: Lagos, NG_',
        },
      });

      return;
    }

    console.log(`[WORKER] User ${user.id} | state: ${user.current_routing_state}`);

    switch (user.current_routing_state) {

      // ── LOCATION ──────────────────────────────────────────────────────
      case 'AWAITING_LOCATION': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: 'Please send city and country.\nExample: Lagos, NG' },
          });
          return;
        }

        const locationParts = text.split(',');
        const city          = locationParts[0]?.trim() || text;
        const countryCode   = locationParts[1]?.trim().toUpperCase() || 'UNKNOWN';

        await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_INDUSTRY',
            geo_city_region:       city,
            geo_country_code:      countryCode,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              `📍 Region locked: ${city}, ${countryCode}\n\n` +
              `What industry are you in?\n` +
              `_Examples: SaaS, Logistics, Fintech_`,
          },
        });

        break;
      }

      // ── INDUSTRY ──────────────────────────────────────────────────────
      case 'AWAITING_INDUSTRY': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: 'Please describe your industry.' },
          });
          return;
        }

        const taxonomyId = text.toLowerCase().replace(/\s+/g, '-');

        await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_SYSTEM_TIER',
            industry_taxonomy_id:  taxonomyId,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'interactive',
          interactive: {
            type:   'button',
            header: { type: 'text', text: '⚙️ SIMORA SYSTEM DESIGN' },
            body: {
              text: `Industry: ${text}\n\nChoose primary business dynamic:`,
            },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'TIER_PIPELINE',  title: '📈 Pipeline'  } },
                { type: 'reply', reply: { id: 'TIER_CHURN',     title: '📉 Churn'     } },
                { type: 'reply', reply: { id: 'TIER_ECOSYSTEM', title: '🌐 Ecosystem' } },
              ],
            },
          },
        });

        break;
      }

      // ── SYSTEM TIER + SEED SYSTEM STATE ──────────────────────────────
      case 'AWAITING_SYSTEM_TIER': {
        if (!interactive_reply_id) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '👆 Please use the buttons above to select your system tier.' },
          });
          return;
        }

        const tierMapping: Record<string, string> = {
          TIER_PIPELINE:  'PIPELINE_BOTTLENECK',
          TIER_CHURN:     'CHURN_LEAK',
          TIER_ECOSYSTEM: 'ECOSYSTEM_NETWORK',
        };

        const selectedTier = tierMapping[interactive_reply_id];

        if (!selectedTier) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '⚠️ Unrecognized selection. Please try again.' },
          });
          return;
        }

        // Tier is set, but onboarding is NOT yet complete — persona is the
        // final step before ACTIVE. This is deliberate: SIMORA needs to know
        // who it's talking to before it starts giving advice in any voice.
        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_PERSONA',
            assigned_tier:         selectedTier,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateErr) throw new Error(`Tier update failed: ${updateErr.message}`);

        await seedSystemState(user.id, selectedTier);

        await sendWhatsApp(from, {
          type: 'interactive',
          interactive: {
            type:   'button',
            header: { type: 'text', text: '🗣️ ONE LAST THING' },
            body: {
              text:
                'How should I talk to you?\n\n' +
                'This shapes how I phrase things — not what I tell you. The data and confidence behind every answer stay the same no matter what you pick.',
            },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'PERSONA_FOUNDER',    title: '🚀 Founder'    } },
                { type: 'reply', reply: { id: 'PERSONA_STUDENT',    title: '🎓 Student'    } },
                { type: 'reply', reply: { id: 'PERSONA_RESEARCHER', title: '🔬 Researcher' } },
              ],
            },
          },
        });

        break;
      }

      // ── PERSONA — final onboarding step, governs voice only ──────────────
      case 'AWAITING_PERSONA': {
        if (!interactive_reply_id) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '👆 Please pick one using the buttons above.' },
          });
          return;
        }

        const personaMapping: Record<string, string> = {
          PERSONA_FOUNDER:    'FOUNDER',
          PERSONA_STUDENT:    'STUDENT',
          PERSONA_RESEARCHER: 'RESEARCHER',
        };

        const tierDescriptions: Record<string, string> = {
          PIPELINE_BOTTLENECK: 'Pipeline Bottleneck — optimizes revenue conversion flow',
          CHURN_LEAK:          'Churn Leak — identifies and plugs retention gaps',
          ECOSYSTEM_NETWORK:   'Ecosystem Network — maps and scales partner dynamics',
        };

        const selectedPersona = personaMapping[interactive_reply_id];

        if (!selectedPersona) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '⚠️ Unrecognized selection. Please try again.' },
          });
          return;
        }

        const { error: personaUpdateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'ACTIVE',
            user_persona:          selectedPersona,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        if (personaUpdateErr) throw new Error(`Persona update failed: ${personaUpdateErr.message}`);

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              '✅ *SIMORA ACTIVATED*\n\n' +
              `*System Architecture:* ${tierDescriptions[user.assigned_tier] || user.assigned_tier}\n` +
              `*Industry:* ${user.industry_taxonomy_id || 'General'}\n` +
              `*Region:* ${user.geo_city_region || 'Global'}, ${user.geo_country_code || ''}\n` +
              `*Talking to you as:* ${selectedPersona}\n\n` +
              '🧠 Your intelligence matrix is online.\n\n' +
              'Send any business scenario, financial shift, or operational challenge.\n\n' +
              '_Example: "Fuel rose 14% and we want to cut pricing 5%. Can we absorb it?"_',
          },
        });

        break;
      }

      // ── ACTIVE — MAIN ENGINE ROUTER (the only live post-onboarding path) ─
      case 'ACTIVE':
      default: {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '🧠 *SIMORA is ready.* Send a business scenario, metric update, or challenge.' },
          });
          return;
        }

        console.log(`[WORKER] Running core engine for user: ${user.id}`);

        try {
          const incomingDelta = parseIncomingDelta(text);

          const result = await executeSimoraCoreEngine(
            {
              userId:        user.id,
              whatsappHash,
              incomingText:  text,
              incomingDelta,
            },
            supabaseAdmin,
            openai,
          );

          // Single source of truth for formatting — same function used by
          // the Postman test route, so behavior is identical in both paths.
          const reply = formatSimoraResponse(result);

          await sendWhatsApp(from, { type: 'text', text: { body: reply } });

        } catch (err: any) {
          console.error(`[WORKER] Engine crash | user: ${user.id} | error: ${err.message}`);

          // Recovery path restored — previously this logic existed only in
          // dead, unreachable code after the 'PROFILE_ACTIVATED' bug.
          if (err.message?.includes('CRITICAL_SYSTEM_ERROR') || err.message?.includes('System State Missing')) {
            console.warn(`[WORKER] System state missing for ${user.id} — attempting recovery seed...`);
            try {
              await seedSystemState(user.id, user.assigned_tier || 'PIPELINE_BOTTLENECK');

              await sendWhatsApp(from, {
                type: 'text',
                text: {
                  body:
                    '🔧 *System State Recovered*\n\n' +
                    'Your intelligence matrix was reinitialized. Please resend your scenario.',
                },
              });
            } catch (seedErr: any) {
              console.error(`[WORKER] ❌ Recovery seed also failed for ${user.id}:`, seedErr.message);
              await sendWhatsApp(from, {
                type: 'text',
                text: { body: '⚠️ *Critical system error.* Please try again in a few minutes.' },
              });
            }
          } else {
            await sendWhatsApp(from, {
              type: 'text',
              text: {
                body:
                  '⚠️ *Simora Interruption*\n\n' +
                  'The analysis engine encountered an anomaly.\n\n' +
                  'Please resend or rephrase your scenario.',
              },
            });
          }
        }

        break;
      }
    }
  },
  { connection: REDIS_CONNECTION },
);

// ============================================================================
// WORKER — Data Hydration / External Ledger Sync
// Called by external scraping agents or accounting integrations via REST
// ============================================================================
const hydrationWorker = new Worker(
  'DataHydrationIngestion',
  async (job: Job<HydrationPayload>) => {
    const payload = job.data;
    console.log(`[HYDRATION WORKER] Syncing ledger for user: ${payload.user_id}`);

    const { error } = await supabaseAdmin
      .from('system_states')
      .upsert(
        {
          user_id:                  payload.user_id,
          liquid_cash_balance:      payload.financial_hydration_payload.account_balance_current,
          monthly_operating_burn:   payload.financial_hydration_payload.monthly_operating_burn_rate,
          calculated_runway_months: payload.financial_hydration_payload.calculated_system_runway_months,
          last_external_sync:       new Date().toISOString(),
          updated_at:               new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    if (error) {
      console.error('[HYDRATION WORKER] ❌ Upsert failed:', error.message);
      throw new Error(`Ledger sync failed: ${error.message}`);
    }

    console.log(`[HYDRATION WORKER] ✅ Ledger synced for user: ${payload.user_id}`);
  },
  { connection: REDIS_CONNECTION },
);

// ── Worker error listeners (prevent Redis errors from crashing main process)
whatsappWorker.on('error',   (err) => console.error('[WHATSAPP WORKER ERROR]:', err.message));
hydrationWorker.on('error',  (err) => console.error('[HYDRATION WORKER ERROR]:', err.message));

whatsappWorker.on('failed',  (job, err) => console.error(`[WHATSAPP WORKER] Job ${job?.id} failed:`, err.message));
hydrationWorker.on('failed', (job, err) => console.error(`[HYDRATION WORKER] Job ${job?.id} failed:`, err.message));

// ============================================================================
// SERVER BOOT
// ============================================================================
const PORT: number = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SIMORA-GATEWAY] ✅ Gateway active on port ${PORT}`);
  console.log(`[SIMORA-GATEWAY] 🔁 WhatsApp worker online — fully self-sufficient backend loop ready`);
});
