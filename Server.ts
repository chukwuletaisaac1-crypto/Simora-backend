import { executeSimoraCoreEngine.ts } from "./engines/executeSimoraCoreEngine.ts";
import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import OpenAI from 'openai';

// ============================================================================
// 1. CONFIGURATION & SECURE SUPABASE SERVICE ROLE INITIALIZATION
// ============================================================================
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const META_API_TOKEN = process.env.META_API_TOKEN as string;
const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
};

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============================================================================
// 2. TYPESCRIPT INTERFACES
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
  ingested_vector_chunks: Array<{ chunk_id: string }>;
}

// ============================================================================
// 3. BACKGROUND QUEUES (BULLMQ)
// ============================================================================
const whatsappQueue = new Queue('WhatsAppStateTransition', { connection: REDIS_CONNECTION });
const hydrationQueue = new Queue('DataHydrationIngestion', { connection: REDIS_CONNECTION });

// ============================================================================
// 4. EXPRESS ROUTER
// ============================================================================
const app = express();
app.use(express.json());

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

app.post('/api/test-engine', async (req: Request, res: Response) => {
  try {
    const { userId, whatsappHash, incomingText, incomingDelta } = req.body;
    const result = await executeSimoraCoreEngine(
      { userId, whatsappHash, incomingText, incomingDelta },
      supabaseAdmin,
      openai
    );
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v1/webhook/whatsapp', (req: Request, res: Response) => {
  res.status(200).send(req.query['hub.challenge']);
});

// ============================================================================
// 5. ASYNCHRONOUS WORKERS
// ============================================================================
// [Rest of your worker code follows here exactly as you have it]
