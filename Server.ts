import express, { Request, Response } from 'express';
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';

// 🎯 SECURE CORE ARCHITECTURE IMPORTS
import { supabaseAdmin } from './supabase'; 
import { openai } from './openai'; 
import { executeSimoraCoreEngine } from './src/engines/executeSimoraCoreEngine';

// ============================================================================
// CONFIGURATION & REDIS QUEUE INITIALIZATION
// ============================================================================
const META_API_TOKEN = process.env.META_API_TOKEN as string;

// Consolidated Connection Logic with mandatory TLS for Public Endpoints
const REDIS_CONNECTION = process.env.REDIS_URL 
  ? { url: process.env.REDIS_URL } 
  : {
      host: process.env.REDIS_HOST || 'zephyr.proxy.rlwy.net',
      port: parseInt(process.env.REDIS_PORT || '37887', 10),
      password: process.env.REDIS_PASSWORD,
      tls: {}, // CRITICAL: This enables the required encryption for Public Railway proxies
    };

// Debug Log for Railway Initialization
console.log("--- REDIS CONFIG DEBUG ---");
console.log("Attempting Connection to:", REDIS_CONNECTION);
console.log("--------------------------");

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

// Establish high-throughput asynchronous lines
const whatsappQueue = new Queue('WhatsAppStateTransition', { connection: REDIS_CONNECTION });
const hydrationQueue = new Queue('DataHydrationIngestion', { connection: REDIS_CONNECTION });

const app = express();
app.use(express.json());

// ============================================================================
// WEBHOOK INGESTION ROUTES
// ============================================================================

app.get('/api/v1/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

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
  } catch (error) {
    res.status(500).send('Internal Ingestion Error');
  }
});

app.post('/api/v1/webhook/data-hydration', async (req: Request, res: Response) => {
  try {
    const payload = req.body as HydrationPayload;
    if (!payload.user_id || !payload.financial_hydration_payload) {
       res.status(400).json({ error: 'Malformed Payload' });
       return;
    }
    await hydrationQueue.add('ProcessLedgerSync', payload);
    res.status(200).json({ status: 'SYNC_QUEUED' });
  } catch (error) {
    res.status(500).send('Internal Queue Error');
  }
});

app.post('/api/v1/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta } = req.body;
    const result = await executeSimoraCoreEngine({ userId, whatsappHash, incomingText, incomingDelta }, supabaseAdmin, openai); 
    res.status(200).json({ status: 'SUCCESS', data: result });
  } catch (error: any) {
    res.status(500).json({ status: 'ENGINE_CRASHED', error: error.message });
  }
});

// ============================================================================
// ASYNC WORKERS WITH ERROR HANDLING
// ============================================================================
async function sendWhatsApp(to: string, messagePayload: any): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${process.env.META_PHONE_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...messagePayload }),
  });
}

const whatsappWorker = new Worker('WhatsAppStateTransition', async (job: Job<WhatsAppMessageContext>) => {
  const { from, text, interactive_reply_id } = job.data;
  const whatsappHash = crypto.createHash('sha256').update(from).digest('hex');

  let { data: user } = await supabaseAdmin.from('users').select('*').eq('whatsapp_id_hash', whatsappHash).single();

  if (!user) {
    const { data: newUser } = await supabaseAdmin.from('users').insert([{ whatsapp_id_hash: whatsappHash, current_routing_state: 'AWAITING_LOCATION' }]).select().single();
    user = newUser;
    await sendWhatsApp(from, { type: 'text', text: { body: "SIMORA: Initialization requested. Please reply with your primary operating region." } });
    return;
  }

  // ... (Your switch statement logic remains here)
  switch (user.current_routing_state) {
    case 'AWAITING_LOCATION':
        if (!text) return;
        await supabaseAdmin.from('users').update({ current_routing_state: 'AWAITING_INDUSTRY', geo_city_region: text }).eq('id', user.id);
        await sendWhatsApp(from, { type: 'text', text: { body: "Region locked. Please state your primary industry." } });
        break;
    case 'PROFILE_ACTIVATED':
        if (!text) return;
        try {
            await executeSimoraCoreEngine({ userId: user.id, whatsappHash, incomingText: text, incomingDelta: 0 }, supabaseAdmin, openai);
            await sendWhatsApp(from, { type: 'text', text: { body: `*SIMORA SYSTEM ANALYSIS* 📊\n\nScenario processed.` } });
        } catch (err: any) {
            await sendWhatsApp(from, { type: 'text', text: { body: "⚠️ Error parsing scenario." } });
        }
        break;
  }
}, { connection: REDIS_CONNECTION });

// Add Error Listeners to prevent crashes
whatsappWorker.on('error', (err) => console.error("WhatsApp Worker Error:", err));

const hydrationWorker = new Worker('DataHydrationIngestion', async (job: Job<HydrationPayload>) => {
  const payload = job.data;
  await supabaseAdmin.from('system_states').upsert({
    user_id: payload.user_id,
    liquid_cash_balance: payload.financial_hydration_payload.account_balance_current,
    monthly_operating_burn: payload.financial_hydration_payload.monthly_operating_burn_rate,
    calculated_runway_months: payload.financial_hydration_payload.calculated_system_runway_months,
    last_external_sync: new Date().toISOString()
  }, { onConflict: 'user_id' });
}, { connection: REDIS_CONNECTION });

hydrationWorker.on('error', (err) => console.error("Hydration Worker Error:", err));

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SIMORA-GATEWAY] Gateway active on port ${PORT}`);
});
