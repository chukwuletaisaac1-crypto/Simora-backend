import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { executeSimoraCoreEngine } from '../engines/executeSimoraCoreEngine';

export function createWhatsAppRouter(supabaseAdmin: SupabaseClient, openai: OpenAI): Router {
  const router = Router();

  /**
   * 1. META WEBHOOK VERIFICATION (GET /api/whatsapp/webhook)
   * This is the mandatory "handshake" route Meta hits when you configure your webhook in their developer portal.
   * Meta sends a random challenge string and a token. If our server mirrors the challenge back, they verify us.
   */
  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // This token is a secret password you invent and add to your Railway environment variables
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      console.log("[WHATSAPP WEBHOOK] Security handshake successful with Meta!");
      res.status(200).send(challenge);
      return;
    }

    console.error("[WHATSAPP WEBHOOK] Handshake failed. Token mismatch.");
    res.sendStatus(403);
  });

  /**
   * 2. INBOUND MESSAGE RECEIVER & ENGINE TRIGGER (POST /api/whatsapp/webhook)
   * This is the main highway. Every time a user sends a text to your WhatsApp number, 
   * Meta broadcasts a massively nested JSON payload to this route.
   */
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const body = req.body;

      // Meta sends status updates (like read receipts) through this same route. We gracefully ignore those.
      if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        res.sendStatus(200); // Always return 200 immediately so Meta knows we received the packet
        return;
      }

      // Extract the raw text and metadata from Meta's complex payload structure
      const messageData = body.entry[0].changes[0].value.messages[0];
      const contactData = body.entry[0].changes[0].value.contacts?.[0];
      
      const rawPhoneNumber = messageData.from; // e.g., "2348012345678" or "14155552671"
      const incomingText = messageData.text?.body;
      const userName = contactData?.profile?.name || "User";

      if (!incomingText) {
        console.log("[WHATSAPP WEBHOOK] Received a non-text media item. Skipping interaction.");
        res.sendStatus(200);
        return;
      }

      console.log(`[WHATSAPP WEBHOOK] Live incoming text from ${userName}: "${incomingText}"`);

      /**
       * 3. THE PRIVACY & DATA INTEGRITY LAYER
       * To keep user profiles secure, we never store raw phone numbers in our database tables.
       * We create a one-way cryptographic SHA-256 hash of the phone number. 
       * This creates a permanent, unhackable identifier string that maps perfectly to our 'users' table.
       */
      const whatsappHash = crypto
        .createHash('sha256')
        .update(rawPhoneNumber)
        .digest('hex');

      /**
       * 4. EXECUTE THE SIMORA CALCULATION ENGINE
       * We pass the parsed text and the user's secure identity hash directly into the core calculation engine.
       * The engine takes care of checking data, generating vectors, running the Llama-3.3 brain, and saving states.
       */
      const engineOutput = await executeSimoraCoreEngine(
        {
          userId: "", // Handled dynamically via the whatsappHash inside the engine
          whatsappHash: whatsappHash,
          incomingText: incomingText,
          incomingDelta: 0 // Default baseline change state
        },
        supabaseAdmin,
        openai
      );

      /**
       * 5. THE OUTBOUND TRANSMITTER LAYER
       * The engine successfully generated the auditor response. Now, we take that beautiful response card,
       * format it cleanly, and transmit it back to Meta to appear right on the user's phone screen.
       */
      await sendWhatsAppTextMessage(
        rawPhoneNumber,
        `*SIMORA CORE ENGINE ENGINE OUTPUT* 📊\n\n` +
        `*Action Directive:*\n${engineOutput.action_directive}\n\n` +
        `*Runway Impact:* ${engineOutput.impact_runway}\n` +
        `*Margin Impact:* ${engineOutput.impact_margin}\n\n` +
        `⚠️ *Auditor Warning:*\n_${engineOutput.auditor_warning}_`
      );

      res.sendStatus(200);
    } catch (error: any) {
      console.error("[WHATSAPP WEBHOOK CRITICAL CRASH]:", error.message);
      
      // If something catches fire, try to text the user a safe system warning instead of leaving them hanging
      try {
        const fallbackPhone = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (fallbackPhone) {
          await sendWhatsAppTextMessage(
            fallbackPhone,
            "⚠️ *Simora Engine Operational Interruption:* The underlying system encountered an evaluation anomaly while processing this transaction matrix."
          );
        }
      } catch (nestedErr) {
        console.error("Failed to send fallback crash notification to user.");
      }

      res.sendStatus(200); // Still return 200 to Meta so they don't block/retry our server endpoints
    }
  });

  /**
   * 6. HELPER: META OUTBOUND TEXT TRANSMITTER
   * Talks directly to Meta's secure cloud graph endpoint to dispatch texts.
   */
  async function sendWhatsAppTextMessage(toPhoneNumber: string, textMessage: string) {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const systemAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneId || !systemAccessToken) {
      console.error("[CONFIGURATION ERROR] Missing outbound WhatsApp API keys in environment variables.");
      return;
    }

    const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${systemAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toPhoneNumber,
        type: "text",
        text: {
          preview_url: false,
          body: textMessage
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[META GRAPH OUTBOUND API ERROR] Status ${response.status}: ${errorText}`);
    } else {
      console.log(`[WHATSAPP WEBHOOK] Outbound response texted successfully to ${toPhoneNumber}`);
    }
  }

  return router;
}
