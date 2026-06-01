import OpenAI from 'openai';

// This tricks the OpenAI SDK into routing through Groq's free servers
export const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1", 
});
