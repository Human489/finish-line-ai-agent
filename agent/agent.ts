import { google } from "@ai-sdk/google";
import { defineAgent } from "eve";
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
  /*
   * Passed STATICALLY, which the config docs allow: "To call a provider
   * directly and configure the model in code, pass a provider-authored
   * LanguageModel". The step.started restriction applies to dynamic resolvers,
   * not to this field, and believing otherwise cost about fifteen seconds a
   * turn.
   *
   * Measured on the deployed app by timestamping the event stream: with
   * defineDynamic, turn.started arrived at 0.1s and the first step produced
   * nothing until 15.2s, after which the whole rest of the turn - three more
   * steps and the answer - took four seconds. The docs explain the gap:
   * "Dynamic models do not compile a default model or model metadata. When a
   * resolver first selects a model, eve normalizes the selection and resolves
   * any omitted context-window metadata from the AI Gateway catalog." That
   * lookup happens at runtime, on the first step, every session.
   *
   * A static model compiles that metadata at build time instead. Same model,
   * same fallback wrapper, same single instance - just resolved before anyone
   * is waiting on it.
   */
  model,
  // All the judgement lives in score_backlog. The model picks a shortlist and
  // writes one grounded sentence per game, so extended reasoning buys nothing
  // and costs noticeable latency on every step of the loop.
  reasoning: "low",
});
