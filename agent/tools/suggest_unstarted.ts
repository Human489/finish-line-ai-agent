import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooledSettled } from "../lib/cache";
import { getGameDetails, getOwnedGames, type GameDetails, type OwnedGame } from "../lib/steam";

/** How many unstarted games to check genres for when a genre is asked for. */
const GENRE_SEARCH_WIDTH = 40;

/**
 * Never-started games cost nothing to surface: zero playtime means zero
 * achievements, so no keyed call is needed to categorise them. Used when the
 * started-and-unfinished candidates run dry.
 */
export default defineTool({
  description:
    "List owned games with zero playtime. Use this whenever the player asks what to START or PLAY NEXT — not just when Finish Line candidates run out. This is the tool for 'new game' questions; score_backlog is for 'which game am I closest to finishing'. Steam gives no purchase-date or ranking signal for this list, so treat the order as arbitrary: pick a handful and pass their appids to score_backlog before recommending one, rather than just returning the first result. If the player named a genre or mood, pass it as `genre` and this tool does the filtering itself against real Steam genres — do NOT fetch genres game by game to filter a large library, you will only ever see a few of them.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
    limit: z.number().int().min(1).max(30).default(15).describe("How many to return."),
    genre: z
      .string()
      .min(2)
      .optional()
      .describe(
        "A Steam genre to filter by, e.g. 'Horror', 'RPG', 'Strategy'. Matched case-insensitively against the genres Steam publishes for each game. Use the player's own word for it.",
      ),
  }),
  async execute({ steamId, limit, genre }, ctx) {
    const cache = cacheFor(ctx.session.id);

    let library = cache.library as OwnedGame[] | undefined;
    if (!library) {
      library = await getOwnedGames(steamId);
      cache.library = library;
    }

    const unstarted = library.filter((game) => game.hoursPlayed === 0);

    if (genre === undefined) {
      return {
        totalUnstarted: unstarted.length,
        games: unstarted.slice(0, limit).map((game) => ({
          appid: game.appid,
          name: game.name,
        })),
        note: "These have never been launched. Pass appids to score_backlog for hours-to-beat and Linux compatibility before recommending one.",
      };
    }

    // Genre filtering belongs here, not in the model's head. Steam publishes no
    // genre on the library endpoint and appdetails does not batch, so a genre
    // question used to mean one tool call per game. The model was told to check
    // at most five candidates, which on a 4,000-game library is a rounding
    // error away from a coin flip, and it correctly reported "nothing matches"
    // for libraries full of matches.
    cache.details ??= new Map();
    const details = cache.details as Map<number, GameDetails>;

    const pool = unstarted.slice(0, GENRE_SEARCH_WIDTH);
    const settled = await pooledSettled(pool, 8, async (game) => {
      const known = details.get(game.appid);
      if (known) return known;
      const fetched = await getGameDetails(game.appid);
      details.set(game.appid, fetched);
      return fetched;
    });

    const wanted = genre.trim().toLowerCase();
    const matches: { appid: number; name: string; genres: string[] }[] = [];
    let failedLookups = 0;

    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        failedLookups += 1;
        return;
      }
      const hit = result.value.genres.some((g) => g.toLowerCase().includes(wanted));
      if (hit) {
        matches.push({
          appid: pool[index].appid,
          name: pool[index].name,
          genres: result.value.genres,
        });
      }
    });

    // Say what was actually looked at. "None of your games are horror" and "none
    // of the 40 I checked are horror" are different statements, and only the
    // second one is true.
    return {
      totalUnstarted: unstarted.length,
      genre,
      checked: pool.length,
      failedLookups,
      games: matches.slice(0, limit),
      note:
        matches.length > 0
          ? `Genres are Steam's own. Checked ${pool.length} of ${unstarted.length} unstarted games and ${matches.length} matched "${genre}". Pass appids to score_backlog before recommending one.`
          : `Checked ${pool.length} of ${unstarted.length} unstarted games and none listed "${genre}" as a Steam genre. Say you looked at ${pool.length} of them rather than implying the whole library was searched, and offer to look at more or at a different genre.`,
    };
  },
});
