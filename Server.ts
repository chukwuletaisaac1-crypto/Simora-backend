// DEBUG: PRINT ENVIRONMENT VARIABLES (SAFE)
console.log("--- RAILWAY ENV DEBUG ---");
console.log("REDIS_URL is set:    ", !!process.env.REDIS_URL);
console.log("REDISHOST is set:    ", !!process.env.REDISHOST);
console.log("REDISPORT is set:    ", !!process.env.REDISPORT);
console.log("REDISUSER is set:    ", !!process.env.REDISUSER);
console.log("REDISPASSWORD is set:", !!process.env.REDISPASSWORD);
console.log("PORT is:             ", process.env.PORT);
console.log("META_PHONE_ID is set:", !!process.env.META_PHONE_ID);
console.log("META_API_TOKEN is set:", !!process.env.META_API_TOKEN);
console.log("WHATSAPP_VERIFY_TOKEN is set:", !!process.env.WHATSAPP_VERIFY_TOKEN);
console.log("-------------------------");

import express, { Request, Response } from 'express';
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';

// 🎯 SECURE CORE ARCHITECTURE IMPORTS
import { supabaseAdmin } from './supabase';
import { openai } from './openai';
import { executeSimoraCoreEngine } from './src/engines/executeSimoraCoreEngine';

// ============================================================================
// CRITICAL ERROR HANDLERS (RAILWAY CRASH PREVENTION)
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
  from: string;
  text?: string;
  interactive_reply_id?: string;
  audio_id?: string;
}

interface HydrationPayload {
  user_id: string;
  financial_hydration_payload: {
    account_balance_current: number;
    monthly_operating_burn_rate: number;
    calculated_system_runway_months: number;
  };
  ingested_vector_chunks: Array<{ chunk_id: string; text_content: string }>;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const META_API_TOKEN  = process.env.META_API_TOKEN  as string;
const META_PHONE_ID   = process.env.META_PHONE_ID   as string;

// ============================================================================
// REDIS CONNECTION — Railway-aware, URL-first, never falls back to localhost
// ============================================================================
if (!process.env.REDIS_URL && !process.env.REDISHOST) {
  // Hard crash is intentional — workers cannot function without Redis
  console.error('❌ FATAL: No Redis config found. Set REDIS_URL or REDISHOST in Railway.');
  process.exit(1);
}

const REDIS_CONNECTION = process.env.REDIS_URL
  ? {
      url: process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      family: 0, // Dual-stack IPv4/IPv6 — required on Railway networking
    }
  : {
      host: process.env.REDISHOST!,
      port: parseInt(process.env.REDISPORT || '6379', 10),
      password: process.env.REDISPASSWORD,
      username: process.env.REDISUSER,   // Was missing in original — Railway provides this
      maxRetriesPerRequest: null,
      family: 0,
    };

console.log('[REDIS] Connection strategy:', process.env.REDIS_URL ? '✅ URL mode (Railway)' : '⚠️  Host mode (fallback)');

// ============================================================================
// QUEUE INITIALIZATION
// ============================================================================
const whatsappQueue = new Queue('WhatsAppStateTransition', { connection: REDIS_CONNECTION });
const hydrationQueue = new Queue('DataHydrationIngestion',  { connection: REDIS_CONNECTION });

// ============================================================================
// EXPRESS APP
// ============================================================================
const app = express();
app.use(express.json());

// ============================================================================
// RAILWAY HEALTHCHECK (prevents container being killed as unhealthy)
// ============================================================================
app.get('/', (_req: Request, res: Response) => {
  res.status(200).send('Simora Gateway is Online');
});

// ============================================================================
// WEBHOOK — META VERIFICATION HANDSHAKE (GET)
// ============================================================================
app.get('/api/v1/webhook/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode']         as string | undefined;
  const token     = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge']    as string | undefined;

  // .trim() is critical — Railway env var UI does NOT strip whitespace on paste
  const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();

  // ── DIAGNOSTIC BLOCK — safe to leave in, remove once webhook is confirmed ─
  console.log('[WEBHOOK VERIFY] ── Incoming verification attempt ──────────────');
  console.log('[WEBHOOK VERIFY] hub.mode:           ', JSON.stringify(mode));
  console.log('[WEBHOOK VERIFY] hub.verify_token:   ', JSON.stringify(token));
  console.log('[WEBHOOK VERIFY] hub.challenge:      ', JSON.stringify(challenge));
  console.log('[WEBHOOK VERIFY] Env token (raw):    ', JSON.stringify(process.env.WHATSAPP_VERIFY_TOKEN));
  console.log('[WEBHOOK VERIFY] Env token (trimmed):', JSON.stringify(verifyToken));
  console.log('[WEBHOOK VERIFY] Tokens match:       ', token === verifyToken);
  console.log('[WEBHOOK VERIFY] ────────────────────────────────────────────────');
  // ─────────────────────────────────────────────────────────────────────────

  // Guard: env var missing entirely — misconfiguration, not a client error
  if (!verifyToken) {
    console.error('[WEBHOOK VERIFY] ❌ WHATSAPP_VERIFY_TOKEN is not set in Railway environment variables.');
    res.sendStatus(500);
    return;
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WEBHOOK VERIFY] ✅ Verification successful. Challenge returned.');
    res.status(200).send(challenge);
    return;
  }

  console.error('[WEBHOOK VERIFY] ❌ Rejected. mode:', JSON.stringify(mode), '| tokenMatch:', token === verifyToken);
  res.sendStatus(403);
});

// ============================================================================
// WEBHOOK — INCOMING WHATSAPP MESSAGES (POST)
// ============================================================================
app.post('/api/v1/webhook/whatsapp', async (req: Request, res: Response) => {
  // Meta requires a 200 response within 20 seconds or it retries — always ack first
  res.status(200).send('OK');

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Status updates and read receipts also hit this endpoint — silently ignore
      return;
    }

    const payload: WhatsAppMessageContext = {
      from: message.from,
      text:                message.type === 'text'        ? message.text?.body                        : undefined,
      interactive_reply_id: message.type === 'interactive' ? message.interactive?.button_reply?.id    : undefined,
      audio_id:            message.type === 'audio'       ? message.audio?.id                         : undefined,
    };

    console.log('[WEBHOOK POST] Queuing message from:', payload.from, '| type:', message.type);

    await whatsappQueue.add('ProcessWhatsAppMessage', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  } catch (error) {
    // 200 already sent — log the internal error for diagnostics
    console.error('[WEBHOOK POST] Internal ingestion error after 200 ack:', error);
  }
});

// ============================================================================
// WEBHOOK — DATA HYDRATION INGESTION (POST)
// ============================================================================
app.post('/api/v1/webhook/data-hydration', async (req: Request, res: Response) => {
  try {
    const payload = req.body as HydrationPayload;

    if (!payload.user_id || !payload.financial_hydration_payload) {
      res.status(400).json({ error: 'Malformed Hydration Payload Structure' });
      return;
    }

    await hydrationQueue.add('ProcessLedgerSync', payload);
    res.status(200).json({ status: 'SYNC_QUEUED', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[HYDRATION WEBHOOK] Queue error:', error);
    res.status(500).send('Internal Queue Error');
  }
});

// ============================================================================
// TEST ROUTE — Manual engine trigger via Postman/curl
// ============================================================================
app.post('/api/v1/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta } = req.body;

    if (!userId || !whatsappHash || !incomingText) {
      res.status(400).json({
        error: 'Missing required fields. Provide userId, whatsappHash, and incomingText.',
      });
      return;
    }

    console.log(`[POSTMAN TEST] Triggering core engine for user: ${userId}`);

    const ctx    = { userId, whatsappHash, incomingText, incomingDelta };
    const result = await executeSimoraCoreEngine(ctx, supabaseAdmin, openai);

    res.status(200).json({ status: 'SUCCESS', data: result });
  } catch (error: any) {
    console.error('[POSTMAN TEST] Engine crash:', error);
    res.status(500).json({ status: 'ENGINE_CRASHED', error: error.message });
  }
});

// ============================================================================
// OUTBOUND META DISPATCH — sends WhatsApp messages via Cloud API
// ============================================================================
async function sendWhatsApp(to: string, messagePayload: object): Promise<void> {
  if (!META_API_TOKEN || !META_PHONE_ID) {
    console.error('[OUTBOUND] ❌ META_API_TOKEN or META_PHONE_ID is not set. Cannot send message.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${META_PHONE_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${META_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        ...messagePayload,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[OUTBOUND] ❌ Meta API error ${response.status} for ${to}:`, errorBody);
    } else {
      console.log(`[OUTBOUND] ✅ Message dispatched to ${to}`);
    }
  } catch (err) {
    console.error(`[OUTBOUND] ❌ Network error sending to ${to}:`, err);
  }
}

// ============================================================================
// WORKER — WhatsApp State Machine
// ============================================================================
const whatsappWorker = new Worker(
  'WhatsAppStateTransition',
  async (job: Job<WhatsAppMessageContext>) => {
    const { from, text, interactive_reply_id } = job.data;
    const whatsappHash = crypto.createHash('sha256').update(from).digest('hex');

    console.log(`[WORKER] Processing job for hash: ${whatsappHash} | jobId: ${job.id}`);

    // ── Fetch or create user ────────────────────────────────────────────────
    let { data: user, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('whatsapp_id_hash', whatsappHash)
      .single();

    if (fetchErr) {
      console.warn(`[WORKER] User not found (${fetchErr.code}), creating new profile...`);
    }

    if (!user) {
      const { data: newUser, error: insertErr } = await supabaseAdmin
        .from('users')
        .insert([{ whatsapp_id_hash: whatsappHash, current_routing_state: 'AWAITING_LOCATION' }])
        .select()
        .single();

      if (insertErr || !newUser) {
        console.error('[WORKER] ❌ Failed to create new user:', insertErr);
        throw new Error(`User creation failed: ${insertErr?.message}`);
      }

      user = newUser;

      await sendWhatsApp(from, {
        type: 'text',
        text: {
          body: 'SIMORA: Initialization requested.\n\nPlease reply with your primary operating region (City, Country Code).',
        },
      });
      return;
    }

    // ── State machine routing ───────────────────────────────────────────────
    console.log(`[WORKER] User ${user.id} | state: ${user.current_routing_state}`);

    switch (user.current_routing_state) {

      case 'AWAITING_LOCATION': {
        if (!text) return;

        const locationParts = text.split(',');
        await supabaseAdmin.from('users').update({
          current_routing_state: 'AWAITING_INDUSTRY',
          geo_city_region:       locationParts[0]?.trim() || text,
          geo_country_code:      locationParts[1]?.trim() || 'UNKNOWN',
        }).eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'text',
          text: { body: 'Region locked. Please state your primary industry taxonomy.' },
        });
        break;
      }

      case 'AWAITING_INDUSTRY': {
        if (!text) return;

        await supabaseAdmin.from('users').update({
          current_routing_state: 'AWAITING_SYSTEM_TIER',
          industry_taxonomy_id:  text.toLowerCase().replace(/\s+/g, '-'),
        }).eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'interactive',
          interactive: {
            type:   'button',
            header: { type: 'text', text: 'SIMORA SYSTEM DESIGN' },
            body:   { text: 'Identify the primary dynamic layout governing your business problem:' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'TIER_PIPELINE',  title: 'Pipeline'  } },
                { type: 'reply', reply: { id: 'TIER_CHURN',     title: 'Churn'     } },
                { type: 'reply', reply: { id: 'TIER_ECOSYSTEM', title: 'Ecosystem' } },
              ],
            },
          },
        });
        break;
      }

      case 'AWAITING_SYSTEM_TIER': {
        if (!interactive_reply_id) return;

        const tierMapping: Record<string, string> = {
          TIER_PIPELINE:  'PIPELINE_BOTTLENECK',
          TIER_CHURN:     'CHURN_LEAK',
          TIER_ECOSYSTEM: 'ECOSYSTEM_NETWORK',
        };

        const selectedTier = tierMapping[interactive_reply_id];
        if (!selectedTier) {
          console.warn(`[WORKER] Unknown tier reply ID: ${interactive_reply_id}`);
          return;
        }

        await supabaseAdmin.from('users').update({
          current_routing_state: 'PROFILE_ACTIVATED',
          assigned_tier:         selectedTier,
        }).eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body: `System architecture locked: ${selectedTier}.\n\nAccess your minimal canvas: https://simora.app/auth/claim?token=${user.id}\n\nYou are fully activated. Send any system scenario text to evaluate immediate matrix impacts.`,
          },
        });
        break;
      }

      case 'PROFILE_ACTIVATED': {
        if (!text) return;

        console.log(`[WORKER] Activating core engine for user: ${user.id}`);

        try {
          await executeSimoraCoreEngine(
            {
              userId:       user.id,
              whatsappHash: whatsappHash,
              incomingText: text,
              incomingDelta: 0,
            },
            supabaseAdmin,
            openai,
          );

          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body: '*SIMORA SYSTEM ANALYSIS* 📊\n\nYour calculation scenario has been processed and your matrix balances have been updated successfully inside your canvas.',
            },
          });
        } catch (err: any) {
          console.error('[WORKER] Engine crash for user', user.id, ':', err.message);
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body: '⚠️ *Simora Interruption:* The execution matrix encountered an evaluation anomaly parsing this scenario.',
            },
          });
        }
        break;
      }

      default:
        console.warn(`[WORKER] Unknown routing state "${user.current_routing_state}" for user ${user.id}`);
    }
  },
  { connection: REDIS_CONNECTION },
);

// ============================================================================
// WORKER — Data Hydration / Ledger Sync
// ============================================================================
const hydrationWorker = new Worker(
  'DataHydrationIngestion',
  async (job: Job<HydrationPayload>) => {
    const payload = job.data;

    console.log(`[HYDRATION WORKER] Syncing ledger for user: ${payload.user_id}`);

    const { error: upsertErr } = await supabaseAdmin.from('system_states').upsert(
      {
        user_id:               payload.user_id,
        liquid_cash_balance:   payload.financial_hydration_payload.account_balance_current,
        monthly_operating_burn: payload.financial_hydration_payload.monthly_operating_burn_rate,
        calculated_runway_months: payload.financial_hydration_payload.calculated_system_runway_months,
        last_external_sync:    new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

    if (upsertErr) {
      console.error('[HYDRATION WORKER] ❌ Upsert failed:', upsertErr.message);
      throw new Error(`State update failed: ${upsertErr.message}`);
    }

    console.log(`[HYDRATION WORKER] ✅ Ledger synced for user: ${payload.user_id}`);
  },
  { connection: REDIS_CONNECTION },
);

// Prevent worker Redis errors from crashing the main process
whatsappWorker.on('error',  (err) => console.error('[WHATSAPP WORKER ERROR]:', err.message));
hydrationWorker.on('error', (err) => console.error('[HYDRATION WORKER ERROR]:', err.message));

whatsappWorker.on('failed',  (job, err) => console.error(`[WHATSAPP WORKER] Job ${job?.id} failed:`, err.message));
hydrationWorker.on('failed', (job, err) => console.error(`[HYDRATION WORKER] Job ${job?.id} failed:`, err.message));

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================
const PORT: number = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SIMORA-GATEWAY] ✅ Omnichannel Webhook Gateway active on port ${PORT}`);
});
