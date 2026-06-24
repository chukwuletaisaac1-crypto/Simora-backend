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
      // Honest footer — only renders when an industry prior was substituted
      // for real data. Keeps the assumption visible without padding every
      // response when real ledger data was actually used.
      if (Array.isArray(response.assumptions_used) && response.assumptions_used.length > 0) {
        lines.push('', `📋 *Assumed:* ${response.assumptions_used.join('; ')}`);
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
      if (Array.isArray(response.assumptions_used) && response.assumptions_used.length > 0) {
        lines.push('', `📋 *Assumed:* ${response.assumptions_used.join('; ')}`);
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

// PHASE 6 — REAL LEDGER SYNC (Unified.to)
// CORRECTED DESIGN: there is no separate static "connect" page. Unified.to
// redirects the user's browser directly back to OUR server's own
// GET /api/v1/unified/callback route after authorization — SIMORA_PUBLIC_URL
// is this server's own public Railway domain, used only to build that
// redirect target when generating the auth URL (see executeSimoraCoreEngine.ts,
// step 8 of the CONNECT_LEDGER handling).
const UNIFIED_API_KEY      = process.env.UNIFIED_API_KEY as string;
const UNIFIED_WORKSPACE_ID = process.env.UNIFIED_WORKSPACE_ID as string;
const SIMORA_PUBLIC_URL    = process.env.SIMORA_PUBLIC_URL as string;

if (!UNIFIED_API_KEY || !UNIFIED_WORKSPACE_ID) {
  console.warn(
    '⚠️ UNIFIED_API_KEY or UNIFIED_WORKSPACE_ID not set. Ledger sync (CONNECT_LEDGER) will ' +
    'be unable to generate working connection links or sync real financial data until configured. ' +
    'The rest of SIMORA is unaffected.',
  );
}
if (!SIMORA_PUBLIC_URL) {
  console.warn(
    '⚠️ SIMORA_PUBLIC_URL not set. CONNECT_LEDGER will be unable to build a working auth URL ' +
    'until this is set to this server\'s own public Railway domain (e.g. https://your-app.up.railway.app).',
  );
}

// ============================================================================
// PHONE NUMBER ENCRYPTION (PHASE 5: OUTCOME TRACKING — ACTIVE NUDGE SUPPORT)
//
// whatsapp_id_hash (SHA-256) is one-way by design and cannot be reversed —
// that's correct for identity lookup, but it means SIMORA has no way to
// proactively message a user it hasn't heard from recently. The active
// decision-followup nudge needs a real, retrievable phone number. Per
// explicit decision: store it encrypted (reversible, AES-256-GCM), not in
// plaintext and not hashed. This is genuinely different from the identity
// hash — this column exists ONLY so the server itself can decrypt and use
// the number to send a message; it is never used for lookup/matching.
//
// REQUIRES a new Railway env var: WHATSAPP_NUMBER_ENCRYPTION_KEY — a 32-byte
// key, base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Store the output as the env var value. Losing this key makes every
// encrypted number permanently unrecoverable — back it up somewhere safe
// outside Railway (e.g. a password manager), not just in the dashboard.
// ============================================================================
const ENCRYPTION_KEY_B64 = process.env.WHATSAPP_NUMBER_ENCRYPTION_KEY;
let ENCRYPTION_KEY: Buffer | null = null;

if (!ENCRYPTION_KEY_B64) {
  console.error(
    '❌ WHATSAPP_NUMBER_ENCRYPTION_KEY is not set. Active decision-followup nudges will be ' +
    'unable to encrypt/decrypt phone numbers until this is configured. The rest of the ' +
    'system (onboarding, passive resolution, all reactive WhatsApp replies) is unaffected — ' +
    'this only blocks proactive outreach.',
  );
} else {
  try {
    const keyBuffer = Buffer.from(ENCRYPTION_KEY_B64, 'base64');
    if (keyBuffer.length !== 32) {
      throw new Error(`Key must decode to exactly 32 bytes, got ${keyBuffer.length}.`);
    }
    ENCRYPTION_KEY = keyBuffer;
    console.log('[ENCRYPTION] ✅ WhatsApp number encryption key loaded.');
  } catch (err: any) {
    console.error('❌ WHATSAPP_NUMBER_ENCRYPTION_KEY is set but invalid:', err.message);
  }
}

/**
 * Encrypts a phone number using AES-256-GCM (authenticated encryption —
 * not just reversible obfuscation; tampering with the ciphertext is
 * detectable on decrypt, unlike plain AES-CBC). Output format is a single
 * string: `iv:authTag:ciphertext`, all hex-encoded, so it fits in one TEXT
 * column without needing a JSON or composite type.
 */
function encryptPhoneNumber(plaintext: string): string | null {
  if (!ENCRYPTION_KEY) {
    console.error('[ENCRYPTION] ❌ Cannot encrypt — encryption key not loaded.');
    return null;
  }
  try {
    const iv = crypto.randomBytes(12); // 12 bytes is the recommended IV length for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (err: any) {
    console.error('[ENCRYPTION] ❌ Encryption failed:', err.message);
    return null;
  }
}

/**
 * Decrypts a value produced by encryptPhoneNumber(). Returns null on any
 * failure (wrong key, tampered ciphertext, malformed format) rather than
 * throwing — callers (the nudge job) treat null the same as "no number on
 * file" and skip that user, rather than crashing the whole batch job over
 * one bad row.
 */
function decryptPhoneNumber(encryptedValue: string): string | null {
  if (!ENCRYPTION_KEY) {
    console.error('[ENCRYPTION] ❌ Cannot decrypt — encryption key not loaded.');
    return null;
  }
  try {
    const [ivHex, authTagHex, ciphertextHex] = encryptedValue.split(':');
    if (!ivHex || !authTagHex || !ciphertextHex) {
      throw new Error('Malformed encrypted value — expected iv:authTag:ciphertext format.');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err: any) {
    console.error('[ENCRYPTION] ❌ Decryption failed (key mismatch, tampering, or malformed value):', err.message);
    return null;
  }
}

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
// PHASE 5 — OUTCOME TRACKING: repeatable job that scans for stale PENDING
// decisions and sends an active WhatsApp check-in. See SUPABASE_SCHEMA_NOTE_
// outcome_tracking.md for the full design. This queue has no incoming
// webhook trigger — it's scheduled below via queue.add() with a `repeat`
// option, BullMQ's native cron-like mechanism.
const decisionFollowupQueue = new Queue('DecisionFollowupNudge', { connection: REDIS_CONNECTION });

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
// UNIFIED.TO OAUTH CALLBACK — receives connection_id after the user
// authorizes directly with Unified.to's own hosted authorization screen.
//
// Flow: SIMORA sends a WhatsApp link (built in executeSimoraCoreEngine.ts's
// CONNECT_LEDGER handling) → user opens it in their phone's browser →
// Unified.to shows ITS OWN hosted auth screen (no page of ours involved) →
// on success, Unified.to redirects the browser HERE, with the
// connection_id, plus the user_id and provider we embedded in the
// success_redirect URL ourselves. This is what lets us know WHICH SIMORA
// user a given connection_id belongs to — Unified.to has no concept of
// "your app's user," only the connection_id it issues. There is no
// `unified-auth.html` or any other static page in this flow — that was an
// earlier draft design, since superseded by this simpler direct-redirect
// approach (see SUPABASE_SCHEMA_NOTE_unified_ledger_sync.md).
// ============================================================================
app.get('/api/v1/unified/callback', async (req: Request, res: Response) => {
  const connectionId   = req.query.id as string | undefined;    // Unified.to appends this on SUCCESS
  const userId          = req.query.uid as string | undefined;   // ours, round-tripped through the redirect
  const provider         = (req.query.provider as string | undefined)?.toLowerCase(); // ours, round-tripped
  const unifiedError    = req.query.error as string | undefined; // Unified.to appends THIS on FAILURE instead of `id`

  console.log('[UNIFIED CALLBACK] Received:', JSON.stringify({ connectionId, userId, provider, unifiedError }));

  // ── REAL PROVIDER-SIDE FAILURE (e.g. integration not enabled on this
  // workspace) — Unified.to redirected correctly and told us WHY it
  // failed. This is different from "the callback URL itself is malformed"
  // below: here, uid/provider are present, but Unified.to never issued a
  // connection_id because something on ITS side rejected the request
  // (wrong workspace config, integration not activated, user declined,
  // etc). Surface the real reason instead of a generic message — this is
  // exactly the gap that turned a 1-config-toggle fix into a multi-step
  // debugging session the first time this happened.
  if (unifiedError && userId) {
    const decodedError = decodeURIComponent(unifiedError);
    console.error(`[UNIFIED CALLBACK] ❌ Unified.to reported a failure for user ${userId} (provider: ${provider}): ${decodedError}`);

    // Notify the user on WhatsApp with the REAL reason, not a vague retry
    // prompt — if it's a workspace config issue, no amount of retrying
    // the link will fix it, so telling them to "try again" would be
    // actively misleading.
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('whatsapp_number_encrypted')
      .eq('id', userId)
      .single();

    if (userRow?.whatsapp_number_encrypted) {
      const decrypted = decryptPhoneNumber(userRow.whatsapp_number_encrypted);
      if (decrypted) {
        await sendWhatsApp(decrypted, {
          type: 'text',
          text: {
            body:
              `⚠️ *${provider === 'quickbooksonline' ? 'QuickBooks' : 'Stripe'} connection failed.*\n\n` +
              `Reason: ${decodedError}\n\n` +
              `This may need a fix on our end rather than a retry — we've logged it.`,
          },
        });
      }
    }

    res.status(200).send(
      '<html><body style="font-family:monospace;background:#0B0D10;color:#E25A5A;padding:40px;">' +
      `<h2>Connection failed</h2><p style="color:#8B92A0;">${decodedError}</p>` +
      '<p style="color:#8B92A0;">You can close this window — we\'ve been notified.</p>' +
      '</body></html>',
    );
    return;
  }

  // ── GENUINELY MALFORMED CALLBACK — neither a connection_id NOR an error
  // came through. This is the actual "something is wrong with the redirect
  // URL itself" case, distinct from the provider-side failure handled above.
  if (!connectionId || !userId || !provider) {
    console.error('[UNIFIED CALLBACK] ❌ Missing required query params (no connection_id AND no error from Unified.to).');
    res.status(400).send(
      '<html><body style="font-family:monospace;background:#0B0D10;color:#E25A5A;padding:40px;">' +
      'Connection failed — missing required information. Please try the link from WhatsApp again.' +
      '</body></html>',
    );
    return;
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('unified_connections')
    .upsert(
      {
        user_id:       userId,
        provider:      provider,
        connection_id: connectionId,
        connected_at:  new Date().toISOString(),
        is_active:     true,
      },
      { onConflict: 'user_id,provider' }, // one active connection per provider per user
    );

  if (upsertErr) {
    console.error('[UNIFIED CALLBACK] ❌ Failed to store connection:', upsertErr.message);
    res.status(500).send(
      '<html><body style="font-family:monospace;background:#0B0D10;color:#E25A5A;padding:40px;">' +
      'Connection succeeded on the provider side, but we could not save it. Please contact support.' +
      '</body></html>',
    );
    return;
  }

  console.log(`[UNIFIED CALLBACK] ✅ Connection stored — user: ${userId} | provider: ${provider} | connection_id: ${connectionId}`);

  // Notify the user on WhatsApp immediately — they authorized in a browser,
  // but the confirmation should land where they actually live: the chat.
  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('whatsapp_number_encrypted')
    .eq('id', userId)
    .single();

  if (userRow?.whatsapp_number_encrypted) {
    const decrypted = decryptPhoneNumber(userRow.whatsapp_number_encrypted);
    if (decrypted) {
      await sendWhatsApp(decrypted, {
        type: 'text',
        text: {
          body:
            `✅ *${provider === 'quickbooks' ? 'QuickBooks' : 'Stripe'} connected.*\n\n` +
            `Your real financial data will sync shortly. Future answers will use your actual numbers instead of industry assumptions where available.`,
        },
      });
    }
  }

  res.status(200).send(
    '<html><body style="font-family:monospace;background:#0B0D10;color:#5EE6B0;padding:40px;text-align:center;">' +
    '<h2>Connected ✓</h2><p style="color:#8B92A0;">You can close this window and return to WhatsApp.</p>' +
    '</body></html>',
  );
});

// ============================================================================
// TEST ROUTE — Manual engine trigger via Postman / curl
// ============================================================================
app.post('/api/v1/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta, canBeNudged } = req.body;

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
        // Optional in test payloads — if omitted, the engine treats it as
        // UNKNOWN and answers conservatively if asked about followups.
        canBeNudged: typeof canBeNudged === 'boolean' ? canBeNudged : undefined,
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
      // Encrypt the real number for later proactive outreach (decision
      // nudges). whatsapp_id_hash remains the one-way identity lookup key —
      // this encrypted value is a SEPARATE column, used only so the server
      // itself can decrypt and message this user later without the user
      // having messaged first. encryptPhoneNumber() returns null if the
      // encryption key isn't configured — that's handled gracefully below
      // rather than blocking user creation on it.
      const encryptedNumber = encryptPhoneNumber(from);
      if (!encryptedNumber) {
        console.warn(
          `[WORKER] ⚠️ Could not encrypt WhatsApp number for new user (hash: ${whatsappHash}). ` +
          `Active decision-followup nudges will not work for this user until WHATSAPP_NUMBER_ENCRYPTION_KEY is configured.`,
        );
      }

      const { data: newUser, error: insertErr } = await supabaseAdmin
        .from('users')
        .insert([{
          whatsapp_id_hash:        whatsappHash,
          whatsapp_number_encrypted: encryptedNumber,
          current_routing_state:  'AWAITING_LOCATION',
          created_at:              new Date().toISOString(),
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

    // ── BACKFILL: whatsapp_number_encrypted (PHASE 5 SELF-HEALING) ─────────
    // This runs on EVERY message from an existing user, not just new-user
    // creation. It closes the gap flagged in the schema note: users created
    // before the encryption rollout have whatsapp_number_encrypted = NULL,
    // and the only place the real number is ever available is `from` on an
    // incoming webhook — there is no other way to recover it later. Rather
    // than leaving that as a manual follow-up, every message from a user
    // missing this field now triggers an attempt to backfill it. This makes
    // the encryption gap self-healing under normal usage: any user who is
    // active enough to send a message will get nudging capability restored
    // the moment the encryption key is correctly configured.
    //
    // Every outcome here is logged explicitly and distinctly — encrypted
    // successfully, key missing, or write failed — so encryption status is
    // never a silent unknown. This is the visibility requirement: SIMORA
    // (via these logs, and the new column read below) always knows whether
    // a given user CAN be nudged, instead of that fact only surfacing as a
    // failure inside the nudge job days later.
    if (!user.whatsapp_number_encrypted) {
      const backfillEncrypted = encryptPhoneNumber(from);

      if (!backfillEncrypted) {
        // encryptPhoneNumber() already logs the specific reason (missing
        // or invalid WHATSAPP_NUMBER_ENCRYPTION_KEY) — no need to repeat it
        // here, but we log the user-level consequence explicitly so it's
        // traceable to a specific user_id, not just a generic key warning.
        console.warn(
          `[BACKFILL] ⚠️ User ${user.id} still has no encrypted WhatsApp number on file — ` +
          `encryption key unavailable or invalid. This user CANNOT be actively nudged until resolved. ` +
          `No action needed here; this will retry automatically on their next message.`,
        );
      } else {
        const { error: backfillErr } = await supabaseAdmin
          .from('users')
          .update({ whatsapp_number_encrypted: backfillEncrypted, updated_at: new Date().toISOString() })
          .eq('id', user.id);

        if (backfillErr) {
          console.error(
            `[BACKFILL] ❌ Encrypted number was generated for user ${user.id} but the Supabase write failed: ` +
            `${backfillErr.message}. This user CANNOT be actively nudged until this write succeeds — will retry on next message.`,
          );
        } else {
          console.log(`[BACKFILL] ✅ Encrypted WhatsApp number backfilled for user ${user.id} — active nudging now possible.`);
          user.whatsapp_number_encrypted = backfillEncrypted; // keep in-memory user object consistent for the rest of this job
        }
      }
    }

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

          // canBeNudged is computed HERE, in server.ts, where both facts
          // needed to determine it actually live: whether this user has an
          // encrypted number on file (set at insert time or by the backfill
          // step above), AND whether the encryption key is currently valid
          // server-wide (ENCRYPTION_KEY, set once at boot from the env var).
          // A user can have a stored encrypted value yet still be
          // un-nudgeable right now if the key was rotated/removed — both
          // conditions must hold for nudging to actually work.
          const canBeNudged = Boolean(user.whatsapp_number_encrypted) && ENCRYPTION_KEY !== null;

          const result = await executeSimoraCoreEngine(
            {
              userId:        user.id,
              whatsappHash,
              incomingText:  text,
              incomingDelta,
              canBeNudged,
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

// ============================================================================
// WORKER — Decision Followup Nudge (PHASE 5: OUTCOME TRACKING)
//
// Runs once a day (scheduled below via decisionFollowupQueue.add with a
// `repeat` option). Each run: find every decision_logs row that is still
// PENDING, was created more than 3 days ago, and either has never been
// nudged (last_followup_sent_at is null) or was last nudged more than 3
// days ago. Send one WhatsApp check-in per qualifying decision, then stamp
// last_followup_sent_at so the next daily run doesn't re-send it within the
// same 3-day window. This nudge does NOT resolve the decision itself — the
// user's reply is picked up by detectDecisionResolution() in the engine on
// their next message, the same passive path used for opportunistic replies.
// ============================================================================
const decisionFollowupWorker = new Worker(
  'DecisionFollowupNudge',
  async () => {
    console.log('[DECISION FOLLOWUP] Scanning for stale pending decisions...');

    const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Stale PENDING decisions: created more than 3 days ago.
    const { data: staleDecisions, error: fetchErr } = await supabaseAdmin
      .from('decision_logs')
      .select('*, users!inner(whatsapp_number_encrypted)')
      .eq('decision_status', 'PENDING')
      .lt('created_at', threeDaysAgoIso);

    if (fetchErr) {
      console.error('[DECISION FOLLOWUP] ❌ Fetch failed:', fetchErr.message);
      throw new Error(`Decision followup fetch failed: ${fetchErr.message}`);
    }

    if (!staleDecisions || staleDecisions.length === 0) {
      console.log('[DECISION FOLLOWUP] No stale pending decisions found.');
      return;
    }

    // Filter in code (not in the query) for the "never nudged OR nudged
    // more than 3 days ago" condition — combining a null-check with a date
    // comparison is awkward to express cleanly in a single Supabase filter
    // chain, and this list is expected to be small enough that filtering
    // in memory here is simpler and just as correct.
    const dueForNudge = staleDecisions.filter((d: any) => {
      if (!d.last_followup_sent_at) return true;
      return new Date(d.last_followup_sent_at).getTime() < Date.now() - 3 * 24 * 60 * 60 * 1000;
    });

    console.log(`[DECISION FOLLOWUP] ${dueForNudge.length} decision(s) due for a nudge.`);

    // Aggregate run-level counters — this is the visibility piece. A single
    // skipped decision is a minor, expected event (e.g. one stale user).
    // ALL decisions skipping for the SAME reason (key missing/invalid) is a
    // systemic failure that needs to be obvious at a glance, not discovered
    // by manually counting individual warning lines across a long log.
    let nudgeSent = 0;
    let nudgeSkippedNoNumber = 0;
    let nudgeFailedToSend = 0;

    for (const decision of dueForNudge) {
      // Decrypt the stored phone number using the AES-256-GCM helper above.
      // decryptPhoneNumber() returns null if the key is missing, the value
      // is malformed, or decryption otherwise fails — any of those cases
      // are treated identically to "no number on file" and this decision
      // is skipped for this run rather than crashing the whole batch.
      const encryptedNumber = (decision as any).users?.whatsapp_number_encrypted;
      const whatsappNumber = encryptedNumber ? decryptPhoneNumber(encryptedNumber) : null;

      if (!whatsappNumber) {
        console.error(
          `[DECISION FOLLOWUP] ⚠️ Cannot nudge decision ${decision.id} — no decryptable WhatsApp number on file. ` +
          `Either this user predates the encryption rollout and hasn't messaged since (no backfill chance yet), ` +
          `or WHATSAPP_NUMBER_ENCRYPTION_KEY is misconfigured.`,
        );
        nudgeSkippedNoNumber++;
        continue;
      }

      try {
        await sendWhatsApp(whatsappNumber, {
          type: 'text',
          text: {
            body:
              `💭 Following up — a few days ago you asked: "${decision.user_question}"\n\n` +
              `SIMORA's directive at the time: "${decision.simora_recommendation}"\n\n` +
              `Did that hold, or did things go differently?`,
          },
        });
      } catch (sendErr: any) {
        console.error(`[DECISION FOLLOWUP] ❌ sendWhatsApp threw for decision ${decision.id}:`, sendErr?.message || sendErr);
        nudgeFailedToSend++;
        continue;
      }

      const { error: stampErr } = await supabaseAdmin
        .from('decision_logs')
        .update({ last_followup_sent_at: new Date().toISOString() })
        .eq('id', decision.id);

      if (stampErr) {
        console.error(`[DECISION FOLLOWUP] ⚠️ Failed to stamp last_followup_sent_at for ${decision.id}:`, stampErr.message);
        nudgeFailedToSend++;
      } else {
        console.log(`[DECISION FOLLOWUP] ✅ Nudge sent for decision ${decision.id}`);
        nudgeSent++;
      }
    }

    // ── RUN SUMMARY — single line, grep-able, makes systemic failure obvious ─
    // If nudgeSkippedNoNumber equals dueForNudge.length (everyone skipped for
    // the same reason), that's a strong signal of a misconfigured or missing
    // WHATSAPP_NUMBER_ENCRYPTION_KEY, not a series of unrelated one-off gaps.
    const allSkippedForSameReason = dueForNudge.length > 0 && nudgeSkippedNoNumber === dueForNudge.length;

    if (allSkippedForSameReason) {
      console.error(
        `[DECISION FOLLOWUP RUN SUMMARY] 🚨 SYSTEMIC FAILURE: all ${dueForNudge.length} due decision(s) were ` +
        `skipped for "no decryptable number" in this run. This strongly suggests WHATSAPP_NUMBER_ENCRYPTION_KEY ` +
        `is missing or was rotated without re-encrypting existing data. Active nudging is effectively non-functional ` +
        `right now — check the env var immediately.`,
      );
    } else {
      console.log(
        `[DECISION FOLLOWUP RUN SUMMARY] sent=${nudgeSent} skipped_no_number=${nudgeSkippedNoNumber} ` +
        `failed_to_send=${nudgeFailedToSend} total_due=${dueForNudge.length}`,
      );
    }
  },
  { connection: REDIS_CONNECTION },
);

// ── Worker error listeners (prevent Redis errors from crashing main process)
whatsappWorker.on('error',          (err) => console.error('[WHATSAPP WORKER ERROR]:', err.message));
hydrationWorker.on('error',         (err) => console.error('[HYDRATION WORKER ERROR]:', err.message));
decisionFollowupWorker.on('error',  (err) => console.error('[DECISION FOLLOWUP WORKER ERROR]:', err.message));

whatsappWorker.on('failed',         (job, err) => console.error(`[WHATSAPP WORKER] Job ${job?.id} failed:`, err.message));
hydrationWorker.on('failed',        (job, err) => console.error(`[HYDRATION WORKER] Job ${job?.id} failed:`, err.message));
decisionFollowupWorker.on('failed', (job, err) => console.error(`[DECISION FOLLOWUP WORKER] Job ${job?.id} failed:`, err.message));

// ── Schedule the repeatable nudge job — runs once every 24 hours. BullMQ's
// native `repeat` option handles this without needing a separate cron
// library. This call is safe to run on every server boot: BullMQ
// deduplicates repeatable jobs with identical repeat options, so redeploys
// won't stack up duplicate schedules.
decisionFollowupQueue.add(
  'ScanForStaleDecisions',
  {},
  { repeat: { every: 24 * 60 * 60 * 1000 } }, // 24 hours, in milliseconds
).then(() => {
  console.log('[DECISION FOLLOWUP] ✅ Repeatable daily scan scheduled.');
}).catch((err) => {
  console.error('[DECISION FOLLOWUP] ❌ Failed to schedule repeatable scan:', err.message);
});

// ============================================================================
// SERVER BOOT
// ============================================================================
const PORT: number = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SIMORA-GATEWAY] ✅ Gateway active on port ${PORT}`);
  console.log(`[SIMORA-GATEWAY] 🔁 WhatsApp worker online — fully self-sufficient backend loop ready`);
});
