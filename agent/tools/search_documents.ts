import { defineTool } from "eve/tools";
import { z } from "zod";
import { RELEVANCE_FLOOR, searchDocuments, type DocumentMatch } from "../lib/rag";

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
  }) {
    if (output.error) {
      return {
        type: "text" as const,
        value: `Document search unavailable: ${output.error} Tell the player you could not check your reference material, and do not answer from general knowledge.`,
      };
    }

    if (output.nothingRelevant) {
      return {
        type: "text" as const,
        value:
          "Nothing in the reference documents answers this. Say so plainly — that the documents do not cover it — and do NOT answer from your own knowledge of Steam, Proton or Linux. An honest 'I don't know' is the correct answer here.",
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
          "Answer ONLY from these passages. You MUST end your answer by naming the source file you used, exactly as written in `source` above — for example: (source: steam-families.pdf). An answer without that filename is incomplete, because the player cannot check it otherwise. Not every passage will be relevant — ignore the ones that do not bear on the question rather than forcing them in. If none of them actually answer it, say the documents do not cover it.",
      },
    };
  },
  async execute({ question }) {
    const result = await searchDocuments(question);

    return {
      ...result,
      // Surfaced for the UI so a person can see where the cut-off sits, rather
      // than having to infer it from the scores.
      relevanceFloor: RELEVANCE_FLOOR,
      question,
    };
  },
});
