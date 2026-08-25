import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getOwnedGames, type OwnedGame } from "../lib/steam";

/**
 * Never-started games cost nothing to surface: zero playtime means zero
 * achievements, so no keyed call is needed to categorise them. Used when the
 * started-and-unfinished candidates run dry.
 */
export default defineTool({
  description:
    "List owned games with zero playtime. Use this whenever the player asks what to START or PLAY NEXT — not just when Finish Line candidates run out. This is the tool for 'new game' questions; score_backlog is for 'which game am I closest to finishing'. Steam gives no purchase-date or ranking signal for this list, so treat the order as arbitrary: pick a handful and pass their appids to score_backlog before recommending one, rather than just returning the first result.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
    limit: z.number().int().min(1).max(30).default(15).describe("How many to return."),
  }),
  async execute({ steamId, limit }, ctx) {
    const cache = cacheFor(ctx.session.id);

    let library = cache.library as OwnedGame[] | undefined;
    if (!library) {
      library = await getOwnedGames(steamId);
      cache.library = library;
    }

    const unstarted = library.filter((game) => game.hoursPlayed === 0);

    return {
      totalUnstarted: unstarted.length,
      games: unstarted.slice(0, limit).map((game) => ({
        appid: game.appid,
        name: game.name,
      })),
      note: "These have never been launched. Pass appids to score_backlog for hours-to-beat and Linux compatibility before recommending one.",
    };
  },
});
