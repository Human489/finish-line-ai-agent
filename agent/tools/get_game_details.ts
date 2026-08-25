import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getGameDetails, type GameDetails } from "../lib/steam";

/**
 * Genre and Steam's own review rating, from two keyless store endpoints.
 * This is what makes a genre/rating request ("a horror game", "something
 * well-reviewed") answerable from real data instead of the model guessing
 * from a title alone.
 */
export default defineTool({
  description:
    "Get a game's genres and Steam review rating (e.g. 'Overwhelmingly Positive'). Use this to check whether a candidate actually matches a genre, mood or rating the player asked for, BEFORE recommending it — check a few candidates, not every unstarted game.",
  inputSchema: z.object({
    appid: z.number().int().positive().describe("The Steam appid."),
  }),
  async execute({ appid }, ctx) {
    const cache = cacheFor(ctx.session.id);

    const cached = cache.details?.get(appid) as GameDetails | undefined;
    const details = cached ?? (await getGameDetails(appid));
    cache.details ??= new Map();
    cache.details.set(appid, details);

    return details;
  },
});
