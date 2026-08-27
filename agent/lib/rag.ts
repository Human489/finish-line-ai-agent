/**
 * Retrieval over the reference documents, via Cloudflare Workers AI + Vectorize.
 *
 * The Steam tools answer "what is in this library". These documents answer
 * "how does any of this work" — why a game is missing, what Steam Families
 * shares, how playtime is recorded, what Proton can and cannot run. Questions
 * the agent previously had to decline.
 *
 * Two hosts, one API token:
 *   Workers AI  - turns text into a 768-number vector
 *   Vectorize   - stores those vectors and finds the nearest ones
 *
 * Like every other data source here, this degrades rather than throws. A
 * missing key, a timeout or a bad response returns "no matches" with a reason
 * attached, and the agent says it does not know.
 */

/**
 * MUST match the model the corpus was ingested with. Vectors from two
 * different models are not comparable — the query would return confident
 * nonsense rather than an error, which is the worst possible failure. The
 * index is created with 768 dimensions specifically because this model emits
 * 768 numbers.
 */
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Bounded like every other outbound call in agent/lib. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Below this, treat the whole result as "nothing relevant" and say so.
 *
 * Measured against this corpus rather than inherited:
 *
 *   0.8877  "why is a game missing from my Steam library?"  - true hit
 *   0.7293  secondary chunks on that same question         - still relevant
 *   0.6423  "what does the Borked rating mean?"            - NEAR MISS
 *   0.5781  "what is the best build in Elden Ring?"        - unrelated
 *
 * The 0.64 case is why the number is not lower. Nothing in the corpus defines
 * ProtonDB's tiers — ProtonDB does not publish them — so that query matches
 * Valve's Steam Deck compatibility docs, which describe a DIFFERENT rating
 * system. At the 0.62 threshold suggested as a starting point, the agent would
 * have answered it confidently and been wrong.
 *
 * Note this gates the TOP score only: it decides whether to answer at all.
 * Filtering every chunk by it would be worse — on the missing-games question
 * two irrelevant chunks sit at 0.726, above any threshold that still admits
 * the real secondary hits.
 */
export const RELEVANCE_FLOOR = 0.75;

/*
 * Tuned by watching the agent use it, not by querying the index by hand — the
 * agent rephrases the question before searching, and phrasing moves the score
 * a long way. "What does the Borked rating mean?" scored 0.6423 by hand,
 * then 0.7026 and 0.7375 through the agent.
 *
 * The uncomfortable part is that the two populations OVERLAP:
 *
 *   0.7375  "what does the Borked rating mean?"        - near miss, must refuse
 *   0.7537  "how is playtime recorded if I play offline?" - real hit, must answer
 *   0.8303  "what does Steam Families let me do?"      - real hit
 *   0.8877  "why is a game missing from my library?"   - real hit
 *
 * 0.75 is the only value that gets all four right, and it clears each by about
 * 0.012. That is not a comfortable margin, and it is luck rather than design.
 *
 * The real fix is not a better threshold, it is better retrieval: the offline
 * question scores low because its answer sits inside a 500-word chunk full of
 * other material, so the signal is diluted. Re-ingesting with smaller chunks
 * (CHUNK_WORDS=200) should lift genuine hits and leave the near-miss where it
 * is, separating the populations properly. A reranker would do the same job
 * more thoroughly.
 *
 * Until then, err upward when in doubt: a needless refusal costs the player a
 * retry, a near-miss answer costs them a confident falsehood.
 */
/** How many chunks to hand back. Enough for context, few enough to stay cheap. */
const TOP_K = 4;

export type DocumentMatch = {
  score: number;
  /** The filename the chunk came from, so an answer can cite it. */
  source: string;
  text: string;
};

export type SearchResult = {
  matches: DocumentMatch[];
  /** True when the best match is too weak to answer from. */
  nothingRelevant: boolean;
  topScore: number | null;
  /** Set when retrieval could not run at all, as opposed to finding nothing. */
  error: string | null;
};

const EMPTY = (error: string | null): SearchResult => ({
  matches: [],
  nothingRelevant: true,
  topScore: null,
  error,
});

function config() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  const index = process.env.CF_VECTORIZE_INDEX;
  if (!accountId || !apiToken || !index) return null;
  return { accountId, apiToken, index };
}

/** One string in, one 768-float vector out. */
async function embed(
  text: string,
  cf: NonNullable<ReturnType<typeof config>>,
): Promise<number[] | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/run/${EMBED_MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cf.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [text] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as { result?: { data?: number[][] } };
  return body.result?.data?.[0] ?? null;
}

export async function searchDocuments(question: string): Promise<SearchResult> {
  const cf = config();
  if (!cf) {
    return EMPTY(
      "Document search is not configured on this server (CF_ACCOUNT_ID, CF_API_TOKEN and CF_VECTORIZE_INDEX).",
    );
  }

  try {
    const vector = await embed(question, cf);
    if (!vector) return EMPTY("Could not turn the question into a vector.");

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/vectorize/v2/indexes/${cf.index}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${cf.apiToken}`, "Content-Type": "application/json" },
        // returnMetadata must be the STRING "all", not a boolean. A boolean is
        // accepted and silently returns matches with no text attached, which
        // looks like an empty corpus rather than a bad request.
        body: JSON.stringify({ vector, topK: TOP_K, returnMetadata: "all" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return EMPTY(`Vectorize query failed (HTTP ${response.status}).`);

    const body = (await response.json()) as {
      result?: { matches?: { score?: number; metadata?: { source?: string; text?: string } }[] };
    };

    const matches: DocumentMatch[] = (body.result?.matches ?? [])
      .map((match) => ({
        score: typeof match.score === "number" ? Math.round(match.score * 10000) / 10000 : 0,
        source: match.metadata?.source ?? "unknown",
        text: match.metadata?.text ?? "",
      }))
      .filter((match) => match.text.length > 0);

    if (matches.length === 0) return EMPTY(null);

    const topScore = matches[0].score;
    return {
      matches,
      // Gate on the best match only — see RELEVANCE_FLOOR.
      nothingRelevant: topScore < RELEVANCE_FLOOR,
      topScore,
      error: null,
    };
  } catch (error) {
    return EMPTY(
      error instanceof Error && error.name === "TimeoutError"
        ? "Document search timed out."
        : "Document search failed.",
    );
  }
}
