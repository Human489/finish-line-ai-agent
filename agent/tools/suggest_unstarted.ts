import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooledSettled } from "../lib/cache";
import { getGameDetails, getOwnedGames, type GameDetails, type OwnedGame } from "../lib/steam";

/** Genres are checked in batches, stopping as soon as enough games match. */
const GENRE_BATCH = 40;
/** Hard ceiling on how many games one genre question may look up. */
const GENRE_MAX_SCAN = 200;

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

    const wanted = genre.trim().toLowerCase();
    const matches: { appid: number; name: string; genres: string[] }[] = [];
    // Every genre Steam actually returned while scanning. This is what makes
    // "nothing matched" and "Steam does not have that genre" different answers.
    const seen = new Set<string>();
    let failedLookups = 0;
    let checked = 0;

    // Scan in batches and stop as soon as there are enough matches. A single
    // 40-game window found nothing on a 4,500-game library, which is a sampling
    // problem rather than a genre problem: the order Steam returns is arbitrary,
    // so a narrow window says more about the window than the library. Common
    // genres now terminate in the first batch; rare ones keep looking, bounded
    // so a genre nobody owns cannot walk an entire library.
    const ceiling = Math.min(unstarted.length, GENRE_MAX_SCAN);
    while (checked < ceiling && matches.length < limit) {
      const batch = unstarted.slice(checked, Math.min(checked + GENRE_BATCH, ceiling));
      if (batch.length === 0) break;

      const settled = await pooledSettled(batch, 8, async (game) => {
        const known = details.get(game.appid);
        if (known) return known;
        const fetched = await getGameDetails(game.appid);
        details.set(game.appid, fetched);
        return fetched;
      });

      settled.forEach((result, index) => {
        if (result.status !== "fulfilled") {
          failedLookups += 1;
          return;
        }
        result.value.genres.forEach((g) => seen.add(g));
        if (result.value.genres.some((g) => g.toLowerCase().includes(wanted))) {
          matches.push({
            appid: batch[index].appid,
            name: batch[index].name,
            genres: result.value.genres,
          });
        }
      });

      checked += batch.length;
    }

    // Say what was actually looked at. "None of your games are horror" and "none
    // of the 40 I checked are horror" are different statements, and only the
    // second one is true.
    // Steam's appdetails genres are a short, coarse list: Action, Adventure,
    // Indie, RPG, Strategy, Simulation, Casual and a few more. Moods people
    // actually ask for are TAGS, not genres, and tags are not on this endpoint.
    // Every canonical horror game checked - Phasmophobia, Outlast, Amnesia,
    // Resident Evil 2, Dead by Daylight - returns only Action/Adventure/Indie.
    // So "no horror games" was never true; "Steam does not tell me which ones
    // are horror" is. Those are different sentences and the player deserves the
    // second one.
    const genreExists = [...seen].some((g) => g.toLowerCase().includes(wanted));
    const available = [...seen].sort();

    return {
      totalUnstarted: unstarted.length,
      genre,
      checked,
      failedLookups,
      genreExists,
      availableGenres: available,
      games: matches.slice(0, limit),
      note:
        matches.length > 0
          ? `Genres are Steam's own. Found ${matches.length} matching "${genre}" within the first ${checked} of ${unstarted.length} unstarted games. Pass appids to score_backlog before recommending one.`
          : genreExists
            ? `Checked ${checked} of ${unstarted.length} unstarted games and none listed "${genre}". Say you looked at ${checked} of them rather than implying the whole library was searched.`
            : `Steam does not publish "${genre}" as a genre, so this cannot be answered from genre data at all — it is a community tag, and tags are not available here. Do NOT say the player owns no ${genre} games, because that is not what was checked. Tell them Steam's genre data does not cover ${genre}, and offer the genres it does cover for these games: ${available.join(", ")}.`,
    };
  },
});
