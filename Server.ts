// ── Startup environment audit (safe — only logs boolean presence, never values)
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

// 🎯 Core architecture imports
import { supabaseAdmin }             from './supabase';
import { openai }                    from './openai';
import { executeSimoraCoreEngine }   from './src/engines/executeSimoraCoreEngine';

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
    account_balance_current:          number;
    monthly_operating_burn_rate:      number;
    calculated_system_runway_months:  number;
  };
  ingested_vector_chunks: Array<{ chunk_id: string; text_content: string }>;
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
      url:                   process.env.REDIS_URL,
      maxRetriesPerRequest:  null,
      family:                0,   // Dual-stack IPv4/IPv6 — required on Railway
    }
  : {
      host:                  process.env.REDISHOST!,
      port:                  parseInt(process.env.REDISPORT || '6379', 10),
      password:              process.env.REDISPASSWORD,
      username:              process.env.REDISUSER,
      maxRetriesPerRequest:  null,
      family:                0,
    };

console.log('[REDIS] Strategy:', process.env.REDIS_URL ? '✅ URL mode (Railway)' : '⚠️  Host mode (fallback)');

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
  res.status(200).send('OK');

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return;
    }

    const payload: WhatsAppMessageContext = {
      from:                 message.from,
      text:                 message.type === 'text'        ? message.text?.body                     : undefined,
      interactive_reply_id: message.type === 'interactive' ? message.interactive?.button_reply?.id  : undefined,
      audio_id:             message.type === 'audio'       ? message.audio?.id                      : undefined,
    };

    console.log('[WEBHOOK POST] Queuing message | from:', payload.from, '| type:', message.type);
    await whatsappQueue.add('ProcessWhatsAppMessage', payload, {
      attempts: 3,
      backoff:  { type: 'exponential', delay: 1000 },
    });
  } catch (error) {
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
      res.status(400).json({
        error: 'Missing required fields: userId, whatsappHash, incomingText',
      });
      return;
    }

    console.log(`[TEST ENGINE] Triggering core engine for user: ${userId}`);

    const result = await executeSimoraCoreEngine(
      { userId, whatsappHash, incomingText, incomingDelta },
      supabaseAdmin,
      openai,
    );

    res.status(200).json({ status: 'SUCCESS', data: result });
  } catch (error: any) {
    console.error('[TEST ENGINE] Crash:', error);
    res.status(500).json({ status: 'ENGINE_CRASHED', error: error.message });
  }
});

// ============================================================================
// OUTBOUND DISPATCHER — sends WhatsApp messages via Meta Cloud API
// ============================================================================
async function sendWhatsApp(to: string, messagePayload: object): Promise<void> {
  if (!META_API_TOKEN || !META_PHONE_ID) {
    console.error('[OUTBOUND] ❌ META_API_TOKEN or META_PHONE_ID missing. Cannot dispatch.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${META_PHONE_ID}/messages`;

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
        ...messagePayload,
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
// Called the moment a user completes onboarding (tier selection).
// Seeds the system_states row immediately in the backend entirely self-sufficient.
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
// Handles the full onboarding flow and live scenario processing entirely through WhatsApp.
// ============================================================================
const whatsappWorker = new Worker(
  'WhatsAppStateTransition',
  async (job: Job<WhatsAppMessageContext>) => {
    const { from, text, interactive_reply_id } = job.data;
    const whatsappHash = crypto.createHash('sha256').update(from).digest('hex');

    console.log(`[WORKER] Job ${job.id} | hash: ${whatsappHash}`);

    // ── 1. Resolve user — fetch existing or create new ─────────────────────
    let { data: user, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('whatsapp_id_hash', whatsappHash)
      .single();

    if (fetchErr && fetchErr.code !== 'PGRST116') {
      console.error('[WORKER] ❌ Unexpected Supabase fetch error:', fetchErr.message);
      throw new Error(`User fetch failed: ${fetchErr.message}`);
    }

    // ── 2. New user path — create profile and begin onboarding ─────────────
    if (!user) {
      console.log('[WORKER] New user detected. Creating profile...');

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
        console.error('[WORKER] ❌ User creation failed:', insertErr?.message);
        throw new Error(`User creation failed: ${insertErr?.message}`);
      }

      user = newUser;
      console.log(`[WORKER] ✅ New user created: ${user.id}`);

      await sendWhatsApp(from, {
        type: 'text',
        text: {
          body:
            '👋 *Welcome to SIMORA.*\n\n' +
            'I am your autonomous business intelligence system.\n\n' +
            'Let\'s initialize your profile.\n\n' +
            'Reply with your primary operating region:\n' +
            '_Format: City, Country Code_\n' +
            '_Example: Lagos, NG_',
        },
      });
      return;
    }

    // ── 3. Existing user — route through state machine ──────────────────────
    console.log(`[WORKER] User ${user.id} | state: ${user.current_routing_state}`);
    switch (user.current_routing_state) {

      // ── STATE: Collect location ──────────────────────────────────────────
      case 'AWAITING_LOCATION': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '📍 Please reply with your city and country code.\n_Example: Lagos, NG_' },
          });
          return;
        }

        const locationParts = text.split(',');
        const city          = locationParts[0]?.trim() || text;
        const countryCode   = locationParts[1]?.trim().toUpperCase() || 'UNKNOWN';

        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_INDUSTRY',
            geo_city_region:       city,
            geo_country_code:      countryCode,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateErr) throw new Error(`State update failed: ${updateErr.message}`);

        console.log(`[WORKER] Location set for ${user.id}: ${city}, ${countryCode}`);
        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              `📌 *Region locked:* ${city}, ${countryCode}\n\n` +
              'Now, describe your primary industry.\n\n' +
              '_Examples: SaaS, E-commerce, Fintech, Logistics, Healthcare, Consulting_',
          },
        });
        break;
      }

      // ── STATE: Collect industry taxonomy ────────────────────────────────
      case 'AWAITING_INDUSTRY': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '🏭 Please describe your primary industry. _Example: SaaS, E-commerce, Fintech_' },
          });
          return;
        }

        const taxonomyId = text.toLowerCase().replace(/\s+/g, '-');
        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_SYSTEM_TIER',
            industry_taxonomy_id:  taxonomyId,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateErr) throw new Error(`State update failed: ${updateErr.message}`);

        console.log(`[WORKER] Industry set for ${user.id}: ${taxonomyId}`);
        await sendWhatsApp(from, {
          type: 'interactive',
          interactive: {
            type:   'button',
            header: { type: 'text', text: '⚙️ SIMORA SYSTEM DESIGN' },
            body: {
              text:
                `*Industry:* ${text}\n\n` +
                'Select the primary dynamic that governs your core business problem:',
            },
            footer: { text: 'This determines your analysis framework.' },
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

      // ── STATE: Collect tier + SEED SYSTEM STATE ──────────────────────────
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
        const tierDescriptions: Record<string, string> = {
          PIPELINE_BOTTLENECK: 'Pipeline Bottleneck — optimizes revenue conversion flow',
          CHURN_LEAK:          'Churn Leak — identifies and plugs retention gaps',
          ECOSYSTEM_NETWORK:   'Ecosystem Network — maps and scales partner dynamics',
        };
        const selectedTier = tierMapping[interactive_reply_id];
        if (!selectedTier) {
          console.warn(`[WORKER] Unknown tier reply: ${interactive_reply_id}`);
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '⚠️ Unrecognized selection. Please try again.' },
          });
          return;
        }

        // ── STEP A: Update user profile ────────────────────────────────────
        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'PROFILE_ACTIVATED',
            assigned_tier:         selectedTier,
            updated_at:            new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateErr) throw new Error(`Tier update failed: ${updateErr.message}`);

        // ── STEP B: Seed system_states immediately — NO frontend required ──
        await seedSystemState(user.id, selectedTier);
        console.log(`[WORKER] ✅ User ${user.id} fully activated | tier: ${selectedTier}`);

        // ── STEP C: Confirm activation entirely through WhatsApp ───────────
        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              '✅ *SIMORA ACTIVATED*\n\n' +
              `*System Architecture:* ${tierDescriptions[selectedTier]}\n` +
              `*Industry:* ${user.industry_taxonomy_id || 'General'}\n` +
              `*Region:* ${user.geo_city_region || 'Global'}, ${user.geo_country_code || ''}\n\n` +
              '━━━━━━━━━━━━━━━━━━━━\n' +
              '🧠 *Your intelligence matrix is online.*\n\n' +
              'Send me any business scenario, challenge, or metric — and I will analyze it against your system framework immediately.\n\n' +
              '_Example: "We closed 3 deals this week but lost 5 clients. Monthly burn is $42,000."_',
          },
        });
        break;
      }

      // ── STATE: Live scenario processing (fully operational) ─────────────
      case 'PROFILE_ACTIVATED': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body:
                '🧠 *SIMORA is ready.*\n\n' +
                'Send me a business scenario, metric update, or challenge to analyze.',
            },
          });
          return;
        }

        console.log(`[WORKER] Running core engine for user: ${user.id}`);
        await sendWhatsApp(from, {
          type: 'text',
          text: { body: '⚙️ _Processing your scenario..._' },
        });
        try {
          // Capture the actual response from the AI engine
          const engineResponse = await executeSimoraCoreEngine(
            {
              userId:        user.id,
              whatsappHash:  whatsappHash,
              incomingText:  text,
              incomingDelta: 0,
            },
            supabaseAdmin,
            openai,
          );

          // Defensively parse the response (handles raw strings or JSON objects)
          const dynamicReply = typeof engineResponse === 'string' 
            ? engineResponse 
            : (engineResponse?.text || engineResponse?.reply || JSON.stringify(engineResponse));

          // Dispatch the dynamic AI thought back to the user
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body: dynamicReply,
            },
          });
        } catch (err: any) {
          console.error(`[WORKER] Engine crash | user: ${user.id} | error: ${err.message}`);
          
          if (err.message?.includes('CRITICAL_SYSTEM_ERROR') || err.message?.includes('System State Missing')) {
            console.warn(`[WORKER] System state missing for ${user.id} — attempting recovery seed...`);
            try {
              await seedSystemState(user.id, user.assigned_tier || 'PIPELINE_BOTTLENECK');
              console.log(`[WORKER] ✅ Recovery seed successful for ${user.id}. User should retry.`);
              await sendWhatsApp(from, {
                type: 'text',
                text: {
                  body:
                    '🔧 *System State Recovered*\n\n' +
                    'Your matrix was re-initialized. Please resend your scenario and analysis will proceed normally.',
                },
              });
            } catch (seedErr: any) {
              console.error(`[WORKER] ❌ Recovery seed also failed for ${user.id}:`, seedErr.message);
              await sendWhatsApp(from, {
                type: 'text',
                text: {
                  body: '⚠️ *Critical system error.* Our team has been alerted. Please try again in a few minutes.',
                },
              });
            }
          } else {
            await sendWhatsApp(from, {
              type: 'text',
              text: {
                body:
                  '⚠️ *Simora Interruption*\n\n' +
                  'The analysis engine encountered an anomaly processing this scenario.\n\n' +
                  '_Please rephrase and try again, or send a different scenario._',
              },
            });
          }
        }
        break;
      }

      // ── DEFAULT: Unknown state ──────────────────────────────────────────
      default: {
        console.warn(`[WORKER] Unknown state "${user.current_routing_state}" for user ${user.id}. Sending guidance.`);
        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              '⚠️ *Unexpected system state detected.*\n\n' +
              'Please contact support or type *RESET* if you would like to restart onboarding.',
          },
        });
      }
    }
  },
  { connection: REDIS_CONNECTION },
);

// ============================================================================
// WORKER — Data Hydration / External Ledger Sync
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
