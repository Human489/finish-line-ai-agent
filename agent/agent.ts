import { google } from "@ai-sdk/google";
import { defineAgent, defineDynamic } from "eve";
import { withModelFallback } from "./lib/model-fallback";

// gemini-2.5-flash is closed to new API keys. gemini-3.6-flash works but its
// free tier caps at 20 requests/day, which one conversation's tool loop burns
// through immediately. flash-lite tiers carry a much higher free daily cap and
// are plenty for narration over data score_backlog already computed.
// `npx tsx scripts/smoke-keys.ts` confirms what this key can currently reach.
//
// "Gemini 3 Flash Live" (gemini-3.1-flash-live-preview) is a different API —
// bidiGenerateContent, for realtime audio/video — and does not support the
// generateContent + tool-calling this agent needs, so it was not an option.
/*
 * flash-lite stays the primary. The others exist only so a rate limit or a
 * capacity blip does not kill the turn — see agent/lib/model-fallback.ts, which
 * only switches on 429/503 and never on a malformed request.
 *
 * 3.6-flash is last on purpose: it works, but its free tier caps at 20
 * requests/day, which one conversation's tool loop can exhaust. It is a
 * lifeboat, not a workhorse.
 *
 * Built once at module scope, not per step: a new wrapper on every step would
 * throw away the provider's prompt cache each time.
 */
const model = withModelFallback([
  google("gemini-3.5-flash-lite"),
  google("gemini-3.5-flash"),
  google("gemini-3.6-flash"),
]);

export default defineAgent({
  // Dynamic, because eve only accepts a live LanguageModel object (as opposed
  // to a model id string) from the step.started scope — and the fallback
  // wrapper is exactly that. The same instance is returned every step, so this
  // is a static choice expressed through the only API that accepts it.
  model: defineDynamic({
    events: {
      "step.started": () => model,
    },
  }),
  // All the judgement lives in score_backlog. The model picks a shortlist and
  // writes one grounded sentence per game, so extended reasoning buys nothing
  // and costs noticeable latency on every step of the loop.
  reasoning: "low",
});
