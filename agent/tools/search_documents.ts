import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { RELEVANCE_FLOOR, searchDocuments, type DocumentMatch } from "../lib/rag";

/** The best search this conversation has produced, kept per session. */
type BestSearch = { question: string; topScore: number; matches: DocumentMatch[] };

/**
 * The reference-document half of the agent's grounding.
 *
 * Everything else here answers questions about the player's own library from
 * live Steam data. This answers questions about how the underlying systems
 * work, from a fixed corpus — the questions the agent used to decline.
 *
 * The important behaviour is the negative one: when nothing clears the
 * relevance floor the tool says so plainly rather than handing over its best
 * bad guess. A near-miss presented as an answer is exactly the confident
 * falsehood the rest of this codebase is built to avoid, and it is not
 * hypothetical — "what does the Borked rating mean?" retrieves Valve's Steam
 * Deck compatibility docs at 0.64, which describe a completely different
 * rating system from ProtonDB's.
 */
export default defineTool({
  description:
    "Search the reference documents for how Steam, ProtonDB and Proton actually work — why a game might be missing from a library, what Steam Families shares, how achievements and global unlock percentages work, how playtime is recorded, what Proton can and cannot run. Use this for 'how' and 'why' questions about the systems, including questions about this app's own output. It does NOT know anything about the player's own library — use the Steam tools for that. If it reports nothing relevant, say you do not know rather than answering anyway.",
  inputSchema: z.object({
    question: z
      .string()
      .min(3)
      .describe(
        "The player's question, in their own words. Full sentences retrieve better than keywords, because the search matches on meaning rather than exact words.",
      ),
  }),
  /**
   * The model gets the passages and their sources — enough to answer and to
   * cite — plus an explicit instruction when there is nothing worth using.
   * Scores are included so it can weigh a strong match against a weak one, and
   * the UI shows them separately.
   */
  toModelOutput(output: {
    matches: DocumentMatch[];
    nothingRelevant: boolean;
    topScore: number | null;
    error: string | null;
    earlierSearch: BestSearch | null;
  }) {
    if (output.error) {
      return {
        type: "text" as const,
        value: `Document search unavailable: ${output.error} Tell the player something went wrong looking it up and they could try again — in one plain sentence, without naming the machinery. Do not answer from general knowledge instead.`,
      };
    }

    if (output.nothingRelevant) {
      // A refusal is only honest if nothing usable was found AT ALL this
      // conversation. Earlier in this session a search may already have cleared
      // the floor, and throwing that away to say "not covered" would be a false
      // statement about the corpus.
      if (output.earlierSearch) {
        return {
          type: "json" as const,
          value: {
            note: `This search found nothing above the ${RELEVANCE_FLOOR} threshold, but an earlier search in this conversation DID find usable passages. Judge whether they answer the question. If they do, answer from them in plain words and end with the filename. If they genuinely do not, say you do not know — one ordinary sentence, and do not mention searching, documents or scores.`,
            earlierQuestion: output.earlierSearch.question,
            passages: output.earlierSearch.matches.map((match) => ({
              source: match.source,
              score: match.score,
              text: match.text,
            })),
          },
        };
      }

      return {
        type: "text" as const,
        value:
          "Nothing usable. Reply with one plain sentence saying you do not know, naming what was asked — e.g. \"I don't know what the Borked rating means.\" Nothing else: no preamble, no reasoning, no mention of searching, documents, passages or scores. Do not answer from your own knowledge of Steam, Proton or Linux instead.",
      };
    }

    return {
      type: "json" as const,
      value: {
        passages: output.matches.map((match) => ({
          source: match.source,
          score: match.score,
          text: match.text,
        })),
        rules:
          "Answer now from these passages only, and do NOT search again. Reply with the answer itself and nothing else: no preamble, no reasoning, no \"according to the documents\". Ignore passages that do not bear on the question. End with the filename in brackets exactly as written in `source`, e.g. (source: steam-families.pdf). If none of them answer it, reply with one plain sentence saying you do not know.",
      },
    };
  },
  async execute({ question }, ctx) {
    const result = await searchDocuments(question);
    const cache = cacheFor(ctx.session.id);
    const previous = cache.bestDocSearch as BestSearch | undefined;

    // Remember the strongest search of the conversation, and never let a weaker
    // one displace it.
    if (!result.nothingRelevant && result.topScore !== null) {
      if (!previous || result.topScore > previous.topScore) {
        cache.bestDocSearch = {
          question,
          topScore: result.topScore,
          matches: result.matches,
        } satisfies BestSearch;
      }
    }

    return {
      ...result,
      // Only offered when this search came back empty — otherwise the model has
      // two sets of passages and no reason to prefer either.
      earlierSearch: result.nothingRelevant ? (previous ?? null) : null,
      // Surfaced for the UI so a person can see where the cut-off sits, rather
      // than having to infer it from the scores.
      relevanceFloor: RELEVANCE_FLOOR,
      question,
    };
  },
});
