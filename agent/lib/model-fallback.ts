/**
 * Keeps a turn alive when the primary model is rate limited or overloaded.
 *
 * The free Gemini tier this runs on fails in two ways that are not the app's
 * fault and not permanent:
 *
 *   429 RESOURCE_EXHAUSTED — per-minute or per-day request cap
 *   503 UNAVAILABLE        — "model is currently experiencing high demand"
 *
 * Both were observed here: `gemini-3.5-flash-lite` returned 503 for a stretch
 * while `gemini-3.5-flash` and `gemini-3.6-flash` answered normally the whole
 * time. Without a fallback the turn simply dies, which is a poor outcome when
 * an equivalent model was available the entire time.
 *
 * WHY A MIDDLEWARE AND NOT A RESOLVER. eve's `defineDynamic` picks the model
 * for a step *before* the provider call, so it cannot see a 429 and react —
 * a resolver that throws or returns nothing just fails the turn. The AI SDK
 * middleware sits on the other side of that boundary, around `doGenerate` /
 * `doStream`, which is the only place the provider error is catchable.
 *
 * Only capacity errors are retried. A malformed request or a bad key is not
 * going to succeed on a different model, and silently re-sending the prompt
 * elsewhere would just multiply the cost of a real bug.
 *
 * Cost note: prompt caches are per model, so a fallback re-ingests the
 * conversation at uncached prices. That is the right trade against failing,
 * but it is a reason to keep the primary first and not shuffle the order.
 */

import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

/**
 * The live model object, not the "provider/model-id" string half of
 * `LanguageModel`, and specifically the spec version the middleware itself
 * sees. `wrapLanguageModel` accepts V2/V3/V4 instances whose result shapes
 * differ, but `wrapGenerate` must return the V4 shape — so the middleware
 * signature, not the wrapper's, is the correct source for this type. Derived
 * rather than imported from @ai-sdk/provider, a transitive dependency here.
 */
type ModelInstance = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["model"];

/** HTTP statuses worth trying somewhere else. */
const CAPACITY_STATUSES = new Set([429, 503]);

/**
 * True for "this model cannot serve you right now", false for "this request is
 * wrong". Checks the status code where the SDK exposes one and falls back to
 * the message, because provider error shapes are not guaranteed stable.
 */
export function isCapacityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") {
    // A status code is authoritative. Falling through to the message when one
    // is present let a 400 whose text merely mentions "quota" be retried as a
    // capacity problem — the opposite of this function's purpose.
    return CAPACITY_STATUSES.has(status);
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  // No status to go on, so match only tokens that are unambiguous alone. Bare
  // "quota" and "overloaded" were dropped: they turn up in permanent errors too.
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|rate.?limit(?:ed)?|high demand/i.test(
    message,
  );
}

/** Reports which model actually served a call, so a fallback is never silent. */
export type FallbackNotice = (info: {
  from: string;
  to: string;
  reason: string;
}) => void;

function fallbackMiddleware(
  alternatives: ModelInstance[],
  onFallback: FallbackNotice,
): LanguageModelMiddleware {
  const attempt = async <T>(
    primary: () => PromiseLike<T>,
    call: (model: ModelInstance) => PromiseLike<T>,
    primaryId: string,
  ): Promise<T> => {
    try {
      return await primary();
    } catch (error) {
      if (!isCapacityError(error)) throw error;

      let lastError = error;
      for (const alternative of alternatives) {
        try {
          const result = await call(alternative);
          onFallback({
            from: primaryId,
            to: alternative.modelId,
            reason: error instanceof Error ? error.message.slice(0, 160) : String(error),
          });
          return result;
        } catch (nextError) {
          // A non-capacity failure on the alternative is a real error and is
          // surfaced immediately rather than masked by trying yet another.
          if (!isCapacityError(nextError)) throw nextError;
          lastError = nextError;
        }
      }
      // Everything is rate limited. Rethrow the last one so the message the
      // user eventually sees describes a real, current condition.
      throw lastError;
    }
  };

  return {
    specificationVersion: "v4",
    wrapGenerate: ({ doGenerate, params, model }) =>
      attempt(doGenerate, (alternative) => alternative.doGenerate(params), model.modelId),
    wrapStream: ({ doStream, params, model }) =>
      attempt(doStream, (alternative) => alternative.doStream(params), model.modelId),
  };
}

/**
 * `models[0]` is the primary; the rest are tried in order, only on a capacity
 * error. Returns a single model the agent can use anywhere a model is expected.
 */
export function withModelFallback(
  models: ModelInstance[],
  onFallback: FallbackNotice = (info) =>
    console.warn(`[model-fallback] ${info.from} unavailable, used ${info.to}: ${info.reason}`),
): ModelInstance {
  const [primary, ...alternatives] = models;
  if (!primary) throw new Error("withModelFallback needs at least one model");
  if (alternatives.length === 0) return primary;

  return wrapLanguageModel({
    model: primary,
    middleware: fallbackMiddleware(alternatives, onFallback),
  });
}
