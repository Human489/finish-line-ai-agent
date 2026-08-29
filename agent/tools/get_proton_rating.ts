import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getProtonRating, type ProtonLookup } from "../lib/steam";

/**
 * ProtonDB is keyless and costs no quota. It is reported for context only and
 * never affects a verdict — a Bronze game is still worth finishing. The one
 * exception is Borked, which is a genuine blocker on Linux.
 */
export default defineTool({
  description:
    "Get the ProtonDB Linux compatibility rating for a game. score_backlog already calls this for every game it scores — call it directly yourself only for a one-off compatibility question that is not part of a recommendation.",
  inputSchema: z.object({
    appid: z.number().int().positive().describe("The Steam appid."),
  }),
  async execute({ appid }, ctx) {
    const cache = cacheFor(ctx.session.id);

    const cached = cache.proton.get(appid) as ProtonLookup | undefined;
    const lookup = cached ?? (await getProtonRating(appid));
    // A failed lookup is not cached: it is a fact about the network a moment
    // ago, not about the game, and caching it would make one blip permanent for
    // the rest of the conversation.
    if (lookup.status !== "unknown") cache.proton.set(appid, lookup);

    if (lookup.status === "unknown") {
      return {
        appid,
        tier: null,
        note: "ProtonDB did not answer, so its Linux rating is unknown right now. Say that you could not check it, NOT that the game has no reports.",
      };
    }

    if (lookup.status === "none") {
      return { appid, tier: null, note: "ProtonDB has no reports for this game." };
    }

    const { rating } = lookup;
    return {
      appid,
      tier: rating.tier,
      score: rating.score,
      confidence: rating.confidence,
      reports: rating.reports,
      note: null,
    };
  },
});
