import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getProtonRating, type ProtonRating } from "../lib/steam";

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

    const cached = cache.proton.get(appid) as ProtonRating | null | undefined;
    const rating = cached !== undefined ? cached : await getProtonRating(appid);
    cache.proton.set(appid, rating);

    if (!rating) {
      return { appid, tier: null, note: "No ProtonDB reports for this game." };
    }

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
