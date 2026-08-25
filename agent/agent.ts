import { google } from "@ai-sdk/google";
import { defineAgent } from "eve";

// gemini-2.5-flash is closed to new API keys. gemini-3.6-flash works but its
// free tier caps at 20 requests/day, which one conversation's tool loop burns
// through immediately. flash-lite tiers carry a much higher free daily cap and
// are plenty for narration over data score_backlog already computed.
// `npx tsx scripts/smoke-keys.ts` confirms what this key can currently reach.
//
// "Gemini 3 Flash Live" (gemini-3.1-flash-live-preview) is a different API —
// bidiGenerateContent, for realtime audio/video — and does not support the
// generateContent + tool-calling this agent needs, so it was not an option.
export default defineAgent({
  model: google("gemini-3.5-flash-lite"),
  // All the judgement lives in score_backlog. The model picks a shortlist and
  // writes one grounded sentence per game, so extended reasoning buys nothing
  // and costs noticeable latency on every step of the loop.
  reasoning: "low",
});
