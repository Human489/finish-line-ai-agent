import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooledSettled } from "../lib/cache";
import { getGameDetails, type GameDetails } from "../lib/steam";

/** Same ceiling as score_backlog's shortlist: this exists to enrich one. */
const MAX_GAMES = 6;

/**
 * Genre and Steam's own review rating, from two keyless store endpoints.
 * This is what makes a genre/rating request ("a horror game", "something
 * well-reviewed") answerable from real data instead of the model guessing
 * from a title alone.
 *
 * Takes a LIST, because it used to take one appid and that was the single
 * biggest source of wasted model requests. Every tool call is a full request
 * against a free-tier daily cap, so "something well-reviewed and short" cost
 * one request per candidate: seven tool calls for a four-game answer. The
 * instructions said "check a few candidates, not every unstarted game", and
 * prose is the wrong place to enforce a budget - `score_backlog` has never had
 * this problem because its schema simply refuses more than four games.
 *
 * The lookups run concurrently and are cached per appid, so a batch of six
 * costs about what one used to.
 */
export default defineTool({
  description:
    "Get genres and Steam review ratings (e.g. 'Overwhelmingly Positive') for up to 6 games at once. Use this to check whether candidates actually match a genre, mood or rating the player asked for, BEFORE recommending one. Pass every candidate you care about in a SINGLE call — do not call this once per game.",
  inputSchema: z.object({
    appids: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_GAMES)
      .describe(
        `The Steam appids to look up, at most ${MAX_GAMES}, in one call. Pass the whole shortlist rather than calling this repeatedly.`,
      ),
  }),
  async execute({ appids }, ctx) {
    const cache = cacheFor(ctx.session.id);
    cache.details ??= new Map();
    const cached = cache.details as Map<number, GameDetails>;

    // Deduped: the model sometimes repeats an appid inside one list, and a
    // duplicate lookup is a wasted request even when it is cheap.
    const wanted = [...new Set(appids)];

    const settled = await pooledSettled(wanted, 6, async (appid) => {
      const known = cached.get(appid);
      if (known) return known;
      const details = await getGameDetails(appid);
      cached.set(appid, details);
      return details;
    });

    const games: GameDetails[] = [];
    const failedLookups: number[] = [];

    settled.forEach((result, index) => {
      if (result.status === "fulfilled") games.push(result.value);
      // A failed lookup is reported rather than dropped: "no genres" and "the
      // store did not answer" are different, and only one of them means the
      // game has no genres.
      else failedLookups.push(wanted[index]);
    });

    // A game whose store lookup failed is reported separately from one that
    // genuinely has no genres. Both come back with an empty list, and only one
    // of them is a fact about the game.
    const unreadable = games.filter((game) => game.lookupFailed).map((game) => game.appid);

    return {
      // lookupFailed is dropped from each game and surfaced once below, so the
      // model reads one clear statement rather than a flag per row.
      games: games.map((game) => ({
        appid: game.appid,
        name: game.name,
        genres: game.genres,
        reviewSummary: game.reviewSummary,
        totalReviews: game.totalReviews,
      })),
      failedLookups: failedLookups.length > 0 ? failedLookups : undefined,
      couldNotRead: unreadable.length > 0 ? unreadable : undefined,
      note:
        unreadable.length > 0
          ? `The Steam store did not answer for ${unreadable.join(", ")}. Their genres and review scores are UNKNOWN, not absent - do not say a game is not in a genre when it is on this list.`
          : undefined,
    };
  },
});
