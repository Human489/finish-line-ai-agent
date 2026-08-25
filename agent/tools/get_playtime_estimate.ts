import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getPlaytimeEstimate, type PlaytimeEstimate } from "../lib/playtime";

/**
 * HowLongToBeat is unofficial and token-gated, so this tool is allowed to fail
 * and returns "no data" rather than throwing.
 */
export default defineTool({
  description:
    "Look up how long a single game takes to beat and to 100%, from HowLongToBeat. score_backlog already calls this for every game it scores — call it directly yourself only for a one-off hours question that is not part of a recommendation. May return no data — that is expected, not an error. Never invent hours when it returns none.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The game's name, as it appears on Steam."),
  }),
  async execute({ name }, ctx) {
    const cache = cacheFor(ctx.session.id);

    const cached = cache.playtime.get(name) as PlaytimeEstimate | undefined;
    const estimate = cached ?? (await getPlaytimeEstimate(name));
    cache.playtime.set(name, estimate);

    return { name, ...estimate };
  },
});
