import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dns from 'dns';
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';

// Force Node to prioritize IPv4 to bypass cloud container network bugs
dns.setDefaultResultOrder('ipv4first');

// 🎯 EXACT ROADMAP PATHS AND IMPORT CLEANUP
import { supabaseAdmin } from './supabase'; 
import { openai } from './openai'; 
import { executeSimoraCoreEngine } from './src/engines/executeSimoraCoreEngine';

// ============================================================================
// CONFIGURATION & QUEUES
// ============================================================================
const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN as string;
const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
};

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

const whatsappQueue = new Queue('WhatsAppStateTransition', { connection: REDIS_CONNECTION });
const hydrationQueue = new Queue('DataHydrationIngestion', { connection: REDIS_CONNECTION });

const app = express();
app.use(express.json());

// ============================================================================
// WEBHOOK ROUTES
// ============================================================================

/**
 * 1. LIVE META WEBHOOK HANDSHAKE (GET Verification)
 * Secure verification gateway that confirms ownership with Meta using environment keys.
 */
app.get('/api/v1/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log("[WHATSAPP WEBHOOK] Secure Meta handshake verified successfully.");
    res.status(200).send(challenge);
    return;
  }
  
  console.error("[WHATSAPP WEBHOOK] Security handshake rejected due to token mismatch.");
  res.sendStatus(403);
});

/**
 * 2. LIVE INBOUND WHATSAPP PAYLOAD INGESTION (POST)
 * Converts Meta packets to safe queue payloads to prevent timeout crashes on high load.
 */
app.post('/api/v1/webhook/whatsapp', async (req: Request, res: Response) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const payload: WhatsAppMessageContext = {
        from: message.from,
        text: message.type === 'text' ? message.text.body : undefined,
        interactive_reply_id: message.type === 'interactive' ? message.interactive.button_reply.id : undefined,
        audio_id: message.type === 'audio' ? message.audio.id : undefined,
      };
      
      await whatsappQueue.add('ProcessWhatsAppMessage', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    }
    res.status(200).send('OK');
    return;
  } catch (error) {
    res.status(500).send('Internal Ingestion Error');
    return;
  }
});

/**
 * 3. EXTERNAL DATA HYDRATION ROUTE
 * Syncs third-party financial records securely down into the background queue pipelines.
 */
app.post('/api/v1/webhook/data-hydration', async (req: Request, res: Response) => {
  try {
    const payload = req.body as HydrationPayload;
    if (!payload.user_id || !payload.financial_hydration_payload) {
       res.status(400).json({ error: 'Malformed Hydration Payload Structure' });
       return;
    }
    await hydrationQueue.add('ProcessLedgerSync', payload);
    res.status(200).json({ status: 'SYNC_QUEUED', timestamp: new Date().toISOString() });
    return;
  } catch (error) {
    res.status(500).send('Internal Queue Error');
    return;
  }
});

/**
 * 4. ISOLATED MANUAL CORE ENGINE TESTING ENDPOINT
 * Standard isolated testing suite route reserved for direct Postman simulation.
 */
app.post('/api/v1/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta } = req.body;

    if (!userId || !whatsappHash || !incomingText) {
      res.status(400).json({ 
        error: 'Missing required fields. Provide userId, whatsappHash, and incomingText.' 
      });
      return;
    }

    console.log(`[TEST ROUTE] Manually executing calculation engine for UUID: ${userId}`);
    
    const ctx = { userId, whatsappHash, incomingText, incomingDelta };
    const result = await executeSimoraCoreEngine(ctx, supabaseAdmin, openai); 

    res.status(200).json({ 
      status: 'SUCCESS', 
      data: result 
    });
    return;
  } catch (error: any) {
    console.error('[TEST ROUTE CRASH]:', error);
    res.status(500).json({ status: 'ENGINE_CRASHED', error: error.message });
    return;
  }
});

// ============================================================================
// BACKGROUND TRANSMISSION UTILITIES
// ============================================================================
async function sendWhatsApp(to: string, messagePayload: any): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${process.env.META_PHONE_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${META_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...messagePayload,
    }),
  });

  if (!response.ok) {
    const errorLog = await response.text();
    console.error(`[META TRANSMISSION FAILURE] Status ${response.status}: ${errorLog}`);
  }
}

// ============================================================================
// BACKGROUND WORKERS (STATE TRANSITION ORCHESTRATION ENGINE)
// ============================================================================
const whatsappWorker = new Worker('WhatsAppStateTransition', async (job: Job<WhatsAppMessageContext>) => {
  const { from, text, interactive_reply_id } = job.data;
  const whatsappHash = crypto.createHash('sha256').update(from).digest('hex');

  let { data: user, error: fetchErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('whatsapp_id_hash', whatsappHash)
    .single();

  if (!user || fetchErr) {
    const { data: newUser } = await supabaseAdmin
      .from('users')
      .insert([{ whatsapp_id_hash: whatsappHash, current_routing_state: 'AWAITING_LOCATION' }])
      .select()
      .single();
    
    user = newUser;
    await sendWhatsApp(from, {
      type: 'text',
      text: { body: "SIMORA: Initialization requested.\n\nPlease reply with your primary operating region (City, Country Code)." }
    });
    return;
  }

  switch (user.current_routing_state) {
    case 'AWAITING_LOCATION':
      if (!text) return;
      const locationParts = text.split(',');
      await supabaseAdmin.from('users').update({
        current_routing_state: 'AWAITING_INDUSTRY',
        geo_city_region: locationParts[0]?.trim() || text,
        geo_country_code: locationParts[1]?.trim() || 'UNKNOWN'
      }).eq('id', user.id);

      await sendWhatsApp(from, {
        type: 'text',
        text: { body: "Region locked. Please state your primary industry taxonomy." }
      });
      break;

    case 'AWAITING_INDUSTRY':
      if (!text) return;
      await supabaseAdmin.from('users').update({
        current_routing_state: 'AWAITING_SYSTEM_TIER',
        industry_taxonomy_id: text.toLowerCase().replace(/\s+/g, '-')
      }).eq('id', user.id);

      await sendWhatsApp(from, {
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: "SIMORA SYSTEM DESIGN" },
          body: { text: "Identify the primary dynamic layout governing your business problem:" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "TIER_PIPELINE", title: "Pipeline" } },
              { type: "reply", reply: { id: "TIER_CHURN", title: "Churn" } },
              { type: "reply", reply: { id: "TIER_ECOSYSTEM", title: "Ecosystem" } }
            ]
          }
        }
      });
      break;

    case 'AWAITING_SYSTEM_TIER':
      if (!interactive_reply_id) return;
      const tierMapping: Record<string, string> = {
        'TIER_PIPELINE': 'PIPELINE_BOTTLENECK',
        'TIER_CHURN': 'CHURN_LEAK',
        'TIER_ECOSYSTEM': 'ECOSYSTEM_NETWORK'
      };
      const selectedTier = tierMapping[interactive_reply_id];
      if (!selectedTier) return;

      await supabaseAdmin.from('users').update({
        current_routing_state: 'PROFILE_ACTIVATED',
        assigned_tier: selectedTier
      }).eq('id', user.id);

      await sendWhatsApp(from, {
        type: 'text',
        text: { body: `System architecture locked: ${selectedTier}.\n\nAccess your minimal canvas: https://simora.app/auth/claim?token=${user.id}\n\nYou are fully activated. Send any system scenario text to evaluate immediate matrix impacts.` }
      });
      break;

    case 'PROFILE_ACTIVATED':
      if (!text) return;
      console.log(`[SIMORA ORCHESTRATION] Executing core Llama calculation engine for live active user: ${user.id}`);
      
      try {
        // Run core engine logic via our secure prototype bypass
        const engineOutput = await executeSimoraCoreEngine(
          {
            userId: user.id,
            whatsappHash: whatsappHash,
            incomingText: text,
            incomingDelta: 0
          },
          supabaseAdmin,
          openai
        );

        // Format and transmit calculations right back to their phone screen
        await sendWhatsApp(from, {
          type: 'text',
          text: {
            body: `*SIMORA SYSTEM ANALYSIS* 📊\n\n` +
                  `*Action Directive:*\n${engineOutput.action_directive}\n\n` +
                  `*Runway Impact:* ${engineOutput.impact_runway}\n` +
                  `*Margin Impact:* ${engineOutput.impact_margin}\n\n` +
                  `⚠️ *Auditor Warning:*\n_${engineOutput.auditor_warning}_`
          }
        });
      } catch (err: any) {
        console.error("[WORKER CRITICAL SYSTEM ERROR]:", err.message);
        await sendWhatsApp(from, {
          type: 'text',
          text: { body: "⚠️ *Simora Interruption:* The execution matrix hit an anomaly parsing this business calculation scenario." }
        });
      }
      break;
  }
}, { connection: REDIS_CONNECTION });

const hydrationWorker = new Worker('DataHydrationIngestion', async (job: Job<HydrationPayload>) => {
  const payload = job.data;
  const { error: upsertErr } = await supabaseAdmin.from('system_states').upsert({
    user_id: payload.user_id,
    liquid_cash_balance: payload.financial_hydration_payload.account_balance_current,
    monthly_operating_burn: payload.financial_hydration_payload.monthly_operating_burn_rate,
    calculated_runway_months: payload.financial_hydration_payload.calculated_system_runway_months,
    last_external_sync: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (upsertErr) throw new Error(`State Update Failed: ${upsertErr.message}`);
}, { connection: REDIS_CONNECTION });

// ============================================================================
// APP BOOTSTRAP INITIALIZATION
// ============================================================================
app.listen(PORT, () => {
  console.log(`[SIMORA-GATEWAY] Omnichannel Webhook Gateway active on port ${PORT}`);
});
