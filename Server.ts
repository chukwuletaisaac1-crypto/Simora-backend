// ============================================================================
// SIMORA GATEWAY — server.ts
// Railway + BullMQ + Supabase + Meta WhatsApp Cloud API
// Fully self-sufficient backend loop. No frontend dependency.
// ============================================================================

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
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import dns from 'dns';

// Force Node to prioritize IPv4 (Railway DNS stability)
dns.setDefaultResultOrder('ipv4first');

// 🎯 Core architecture imports
import { supabaseAdmin } from './supabase';
import { openai } from './openai';
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
// SIMORA RESPONSE FORMATTER
// ============================================================================
function formatSimoraResponse(response: any): string {
  if (!response) {
    return 'Simora encountered a processing fault.';
  }

  switch (response.type) {
    case 'CASUAL_CHAT':
      return response.message;

    case 'STRATEGIC_ADVICE':
      return [
        '📌 STRATEGIC DIRECTIVE',
        '',
        response.action_directive || '',
        '',
        'Framework:',
        response.strategic_framework || '',
        '',
        'Benchmarks:',
        response.analytical_baselines || '',
        '',
        response.auditor_warning
          ? `⚠ Risk: ${response.auditor_warning}`
          : '',
      ].join('\n');

    case 'FINANCIAL_MATRIX':
      return [
        '📊 FINANCIAL IMPACT ANALYSIS',
        '',
        `Directive: ${response.action_directive || ''}`,
        '',
        `Margin Impact: ${response.impact_margin || ''}`,
        '',
        `Runway Impact: ${response.impact_runway || ''}`,
        '',
        `Model: ${response.algebraic_impact_model || ''}`,
        '',
        response.auditor_warning
          ? `⚠ Risk: ${response.auditor_warning}`
          : '',
      ].join('\n');

    case 'HYDRATE_LEDGER':
      return response.message;

    case 'CONNECT_LEDGER':
      return response.message;

    default:
      return 'Simora generated an unsupported response.';
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const META_API_TOKEN = process.env.META_API_TOKEN as string;
const META_PHONE_ID = process.env.META_PHONE_ID as string;

// ============================================================================
// REDIS — URL-first, Railway-aware, never falls back to localhost in production
// ============================================================================
if (!process.env.REDIS_URL && !process.env.REDISHOST) {
  console.error('❌ FATAL: No Redis config found. Set REDIS_URL or REDISHOST in Railway.');
  process.exit(1);
}

const REDIS_CONNECTION = process.env.REDIS_URL
  ? {
      url: process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      family: 0,
    }
  : {
      host: process.env.REDISHOST!,
      port: parseInt(process.env.REDISPORT || '6379', 10),
      password: process.env.REDISPASSWORD,
      username: process.env.REDISUSER,
      maxRetriesPerRequest: null,
      family: 0,
    };

console.log(
  '[REDIS] Strategy:',
  process.env.REDIS_URL ? '✅ URL mode (Railway)' : '⚠️ Host mode (fallback)'
);

// ============================================================================
// QUEUE INITIALIZATION
// ============================================================================
const whatsappQueue = new Queue('WhatsAppStateTransition', {
  connection: REDIS_CONNECTION,
});

const hydrationQueue = new Queue('DataHydrationIngestion', {
  connection: REDIS_CONNECTION,
});

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
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();

  console.log('[WEBHOOK VERIFY] ── Incoming attempt ─────────────────────────────');
  console.log('[WEBHOOK VERIFY] hub.mode:            ', JSON.stringify(mode));
  console.log('[WEBHOOK VERIFY] hub.verify_token:    ', JSON.stringify(token));
  console.log('[WEBHOOK VERIFY] hub.challenge:       ', JSON.stringify(challenge));
  console.log(
    '[WEBHOOK VERIFY] Env token (raw):     ',
    JSON.stringify(process.env.WHATSAPP_VERIFY_TOKEN)
  );
  console.log(
    '[WEBHOOK VERIFY] Env token (trimmed): ',
    JSON.stringify(verifyToken)
  );
  console.log('[WEBHOOK VERIFY] Tokens match:        ', token === verifyToken);
  console.log('[WEBHOOK VERIFY] ───────────────────────────────────────────────────');

  if (!verifyToken) {
    console.error(
      '[WEBHOOK VERIFY] ❌ WHATSAPP_VERIFY_TOKEN not set in Railway variables.'
    );
    res.sendStatus(500);
    return;
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WEBHOOK VERIFY] ✅ Verification successful.');
    res.status(200).send(challenge);
    return;
  }

  console.error(
    '[WEBHOOK VERIFY] ❌ Rejected. mode:',
    JSON.stringify(mode),
    '| tokenMatch:',
    token === verifyToken
  );

  res.sendStatus(403);
});
// ============================================================================
// WEBHOOK — Incoming WhatsApp messages (POST)
// ============================================================================
app.post('/api/v1/webhook/whatsapp', async (req: Request, res: Response) => {
  // 200 MUST be sent immediately — Meta retries if no ack within 20 seconds
  res.status(200).send('OK');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Status updates, delivery receipts, read receipts — silently ignore
      return;
    }

    const extractedText =
      message.type === 'text'
        ? message.text?.body?.trim()
        : undefined;

    const payload: WhatsAppMessageContext = {
      from: message.from,
      text: extractedText,
      interactive_reply_id:
        message.type === 'interactive'
          ? message.interactive?.button_reply?.id
          : undefined,
      audio_id:
        message.type === 'audio'
          ? message.audio?.id
          : undefined,
    };

    console.log(
      '[WEBHOOK POST] Queuing message | from:',
      payload.from,
      '| type:',
      message.type,
      '| text:',
      payload.text
    );

    await whatsappQueue.add('ProcessWhatsAppMessage', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
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

    res.status(200).json({
      status: 'SYNC_QUEUED',
      timestamp: new Date().toISOString(),
    });
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
      {
        userId,
        whatsappHash,
        incomingText,
        incomingDelta: Number(incomingDelta || 0),
      },
      supabaseAdmin,
      openai
    );

    const formattedResponse = formatSimoraResponse(result);

    console.log('[TEST ENGINE] RAW RESULT:', result);
    console.log('[TEST ENGINE] FORMATTED RESULT:', formattedResponse);

    res.status(200).json({
      status: 'SUCCESS',
      raw: result,
      formatted: formattedResponse,
    });
  } catch (error: any) {
    console.error('[TEST ENGINE] Crash:', error);
    res.status(500).json({
      status: 'ENGINE_CRASHED',
      error: error.message,
    });
  }
});
// ============================================================================
// OUTBOUND DISPATCHER — sends WhatsApp messages via Meta Cloud API
// ============================================================================
async function sendWhatsApp(
  to: string,
  messagePayload: string | object
): Promise<void> {
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
      text: {
        preview_url: false,
        body: safeMessage,
      },
    };
  } else {
    finalPayload = messagePayload;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${META_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...finalPayload,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[OUTBOUND] ❌ Meta API error ${response.status} → ${to}:`,
        errorBody
      );
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
// Seeds system_states row immediately so engine never hits missing state.
// ============================================================================
async function seedSystemState(
  userId: string,
  assignedTier: string
): Promise<void> {
  console.log(
    `[STATE SEEDER] Seeding system_states for user: ${userId} | tier: ${assignedTier}`
  );

  const { error } = await supabaseAdmin
    .from('system_states')
    .upsert(
      {
        user_id: userId,
        assigned_tier: assignedTier,

        // Financial defaults
        liquid_cash_balance: 0,
        monthly_operating_burn: 0,
        calculated_runway_months: 0,

        // Strategic metrics
        resilience_score: 50,
        pipeline_velocity: 0,
        churn_rate_percentage: 0,
        ecosystem_node_count: 0,

        // Metadata
        activation_source: 'WHATSAPP_ONBOARDING',
        is_fully_activated: true,
        last_external_sync: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

  if (error) {
    console.error(
      `[STATE SEEDER] ❌ Failed to seed system_states for ${userId}:`,
      error.message
    );
    throw new Error(`System state seeding failed: ${error.message}`);
  }

  console.log(
    `[STATE SEEDER] ✅ system_states row confirmed for user: ${userId}`
  );
}
// ============================================================================
// WORKER — WhatsApp State Machine
// Handles onboarding + live AI strategy conversations
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

    // =========================================================================
    // NEW USER
    // =========================================================================
    if (!user) {
      const { data: newUser, error: insertErr } = await supabaseAdmin
        .from('users')
        .insert([{
          whatsapp_id_hash: whatsappHash,
          current_routing_state: 'AWAITING_LOCATION',
          created_at: new Date().toISOString(),
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
      // =========================================================================
      // LOCATION
      // =========================================================================
      case 'AWAITING_LOCATION': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: 'Please send city and country.\nExample: Lagos, NG' },
          });
          return;
        }

        const locationParts = text.split(',');
        const city = locationParts[0]?.trim() || text;
        const countryCode = locationParts[1]?.trim().toUpperCase() || 'UNKNOWN';

        await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'AWAITING_INDUSTRY',
            geo_city_region: city,
            geo_country_code: countryCode,
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

      // =========================================================================
      // INDUSTRY
      // =========================================================================
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
            industry_taxonomy_id: taxonomyId,
          })
          .eq('id', user.id);

        await sendWhatsApp(from, {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text:
                `Industry: ${text}\n\n` +
                `Choose primary business dynamic:`,
            },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'TIER_PIPELINE', title: '📈 Pipeline' } },
                { type: 'reply', reply: { id: 'TIER_CHURN', title: '📉 Churn' } },
                { type: 'reply', reply: { id: 'TIER_ECOSYSTEM', title: '🌐 Ecosystem' } },
              ],
            },
          },
        });

        break;
      }

      // =========================================================================
      // SYSTEM TIER
      // =========================================================================
      case 'AWAITING_SYSTEM_TIER': {
        if (!interactive_reply_id) {
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body: 'Please select a tier using the buttons.',
            },
          });
          return;
        }

        let assignedTier = 'PIPELINE';

        if (interactive_reply_id === 'TIER_CHURN') assignedTier = 'CHURN';
        if (interactive_reply_id === 'TIER_ECOSYSTEM') assignedTier = 'ECOSYSTEM';

        await supabaseAdmin
          .from('users')
          .update({
            assigned_tier: assignedTier,
            current_routing_state: 'ACTIVE',
          })
          .eq('id', user.id);

        await seedSystemState(user.id, assignedTier);

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              `✅ SIMORA initialized.\n\n` +
              `System Tier: ${assignedTier}\n\n` +
              `You can now ask strategic or financial questions.\n\n` +
              `Example:\nFuel rose 14% and we want to reduce route pricing by 5%. Can we absorb this?`,
          },
        });

        break;
      }

      // =========================================================================
      // ACTIVE — MAIN ENGINE ROUTER
      // =========================================================================
      case 'ACTIVE':
      default: {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body: 'Please send a text message for analysis.',
            },
          });
          return;
        }

        const result = await executeSimoraCoreEngine(
          {
            userId: user.id,
            whatsappHash,
            incomingText: text,
          },
          supabaseAdmin,
          openai,
        );

        let responseText = '';

        switch (result.type) {
          case 'CASUAL_CHAT':
            responseText = result.message;
            break;

          case 'STRATEGIC_ADVICE':
            responseText =
              `🎯 ACTION:\n${result.action_directive}\n\n` +
              `${result.strategic_framework}`;
            break;

          case 'FINANCIAL_MATRIX':
            responseText =
              `📊 ACTION:\n${result.action_directive}\n\n` +
              `Margin Impact:\n${result.impact_margin}\n\n` +
              `Runway Impact:\n${result.impact_runway}`;
            break;

          case 'HYDRATE_LEDGER':
            responseText = result.message;
            break;

          case 'CONNECT_LEDGER':
            responseText = result.message;
            break;
        }

        await sendWhatsApp(from, {
          type: 'text',
          text: { body: responseText.slice(0, 4000) },
        });

        break;
      }
    }
  },
  { connection: REDIS_CONNECTION }
);
      // ── STATE: Collect tier + SEED SYSTEM STATE (critical fix) ──────────
      case 'AWAITING_SYSTEM_TIER': {
        if (!interactive_reply_id) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '👆 Please use the buttons above to select your system tier.' },
          });
          return;
        }

        const tierMapping: Record<string, string> = {
          TIER_PIPELINE: 'PIPELINE_BOTTLENECK',
          TIER_CHURN: 'CHURN_LEAK',
          TIER_ECOSYSTEM: 'ECOSYSTEM_NETWORK',
        };

        const tierDescriptions: Record<string, string> = {
          PIPELINE_BOTTLENECK: 'Pipeline Bottleneck — optimizes revenue conversion flow',
          CHURN_LEAK: 'Churn Leak — identifies and plugs retention gaps',
          ECOSYSTEM_NETWORK: 'Ecosystem Network — maps and scales partner dynamics',
        };

        const selectedTier = tierMapping[interactive_reply_id];

        if (!selectedTier) {
          await sendWhatsApp(from, {
            type: 'text',
            text: { body: '⚠️ Unrecognized selection. Please try again.' },
          });
          return;
        }

        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({
            current_routing_state: 'PROFILE_ACTIVATED',
            assigned_tier: selectedTier,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateErr) throw new Error(`Tier update failed: ${updateErr.message}`);

        await seedSystemState(user.id, selectedTier);

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              '✅ *SIMORA ACTIVATED*\n\n' +
              `*System Architecture:* ${tierDescriptions[selectedTier]}\n` +
              `*Industry:* ${user.industry_taxonomy_id || 'General'}\n` +
              `*Region:* ${user.geo_city_region || 'Global'}, ${user.geo_country_code || ''}\n\n` +
              '🧠 Your intelligence matrix is online.\n\n' +
              'Send any business scenario, financial shift, or operational challenge.\n\n' +
              '_Example: "Fuel rose 14% and we want to cut pricing 5%. Can we absorb it?"_',
          },
        });

        break;
      }

      // ── STATE: Live scenario processing ─────────────────────────────────
      case 'PROFILE_ACTIVATED': {
        if (!text) {
          await sendWhatsApp(from, {
            type: 'text',
            text: {
              body:
                '🧠 *SIMORA is ready.*\n\n' +
                'Send a business scenario, metric update, or challenge.',
            },
          });
          return;
        }

        console.log(`[WORKER] Running core engine for user: ${user.id}`);

        try {
          const result = await executeSimoraCoreEngine(
            {
              userId: user.id,
              whatsappHash,
              incomingText: text,
              incomingDelta: 0,
            },
            supabaseAdmin,
            openai,
          );

          let reply = '';

          switch (result.type) {
            case 'CASUAL_CHAT':
              reply = result.message;
              break;

            case 'STRATEGIC_ADVICE':
              reply =
                `🎯 *Directive*\n${result.action_directive}\n\n` +
                `🧠 *Analysis*\n${result.strategic_framework}`;

              if (result.auditor_warning) {
                reply += `\n\n⚠️ *Risk*\n${result.auditor_warning}`;
              }
              break;

            case 'FINANCIAL_MATRIX':
              reply =
                `📊 *SIMORA ANALYSIS*\n\n` +
                `🎯 *Action*\n${result.action_directive}\n\n` +
                `📈 *Runway Impact*\n${result.impact_runway}\n\n` +
                `💰 *Margin Impact*\n${result.impact_margin}`;

              if (result.auditor_warning) {
                reply += `\n\n⚠️ *Risk*\n${result.auditor_warning}`;
              }
              break;

            case 'HYDRATE_LEDGER':
              reply =
                `💾 *Ledger Updated*\n\n${result.message}\n\n` +
                `SIMORA will now use the updated financial state in future analysis.`;
              break;

            case 'CONNECT_LEDGER':
              reply = result.message;
              break;

            default:
              reply =
                '⚠️ SIMORA completed analysis but returned an unrecognized response format.';
          }

          if (reply.length > 3500) {
            reply = reply.slice(0, 3500) + '...';
          }

          await sendWhatsApp(from, {
            type: 'text',
            text: { body: reply },
          });

        } catch (err: any) {
          console.error(`[WORKER] Engine crash | user: ${user.id} | error: ${err.message}`);

          if (
            err.message?.includes('CRITICAL_SYSTEM_ERROR') ||
            err.message?.includes('System State Missing')
          ) {
            try {
              await seedSystemState(
                user.id,
                user.assigned_tier || 'PIPELINE_BOTTLENECK'
              );

              await sendWhatsApp(from, {
                type: 'text',
                text: {
                  body:
                    '🔧 *System State Recovered*\n\n' +
                    'Your intelligence matrix was reinitialized.\n' +
                    'Please resend your scenario.',
                },
              });
            } catch (seedErr: any) {
              console.error(seedErr);

              await sendWhatsApp(from, {
                type: 'text',
                text: {
                  body:
                    '⚠️ *Critical system error.* Please try again in a few minutes.',
                },
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

      // ── DEFAULT: Unknown state guard ────────────────────────────────────
      default: {
        console.warn(
          `[WORKER] Unknown state "${user.current_routing_state}" for user ${user.id}`
        );

        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body:
              '⚠️ *Unexpected system state detected.*\n\n' +
              'Please contact support or type *RESET* to restart onboarding.',
          },
        });
      }
    }
  },
  { connection: REDIS_CONNECTION },
);
