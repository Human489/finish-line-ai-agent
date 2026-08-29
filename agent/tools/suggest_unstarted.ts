import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getOwnedGames, type OwnedGame } from "../lib/steam";
import {
  findByFacet,
  gameFacets,
  resolveTag,
  suggestTags,
  taggedAppids,
  type Facets,
} from "../lib/tags";

/**
 * Steam's entire store genre vocabulary.
 *
 * Membership of THIS decides whether a word is a genre Steam publishes, rather
 * than whether it happened to appear in the games scanned. Deriving it from the
 * scan was wrong in a way that mattered: on a library where the only Racing
 * games sit past the scan ceiling, "Racing" would have been reported as a genre
 * Steam does not have, which is false and unfalsifiable from the player's side.
 *
 * Steam publishes no endpoint for this list, so it is written down. It changes
 * about never, and being slightly stale only costs a vaguer sentence: an
 * unknown word still gets scanned for, it just is not called a non-genre.
 */
const STEAM_GENRES = [
  "action", "adventure", "casual", "early access", "free to play", "indie",
  "massively multiplayer", "racing", "rpg", "simulation", "sports", "strategy",
  "violent", "gore", "nudity", "sexual content", "documentary", "education",
  "software training", "utilities", "video production", "web publishing",
  "animation & modeling", "audio production", "design & illustration",
  "game development", "photo editing", "accounting",
];

/**
 * Never-started games cost nothing to surface: zero playtime means zero
 * achievements, so no keyed call is needed to categorise them. Used when the
 * started-and-unfinished candidates run dry.
 */
export default defineTool({
  description:
    "List owned games with zero playtime. Use this whenever the player asks what to START or PLAY NEXT — not just when Finish Line candidates run out. This is the tool for 'new game' questions; score_backlog is for 'which game am I closest to finishing'. Steam gives no purchase-date or ranking signal for this list, so treat the order as arbitrary: pick a handful and pass their appids to score_backlog before recommending one, rather than just returning the first result. If the player named a genre, mood or vibe, pass their own word as `genre` and this tool works out whether it is a Steam genre or a Steam tag and filters on it — do NOT try to work that out yourself, and do NOT fetch details game by game to filter a library.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
    limit: z.number().int().min(1).max(30).default(15).describe("How many to return."),
    genre: z
      .string()
      .min(2)
      .optional()
      .describe(
        "What kind of game they asked for, in their own words: 'horror', 'cosy', 'souls-like', 'roguelike', 'strategy'. Checked against both Steam genres and Steam tags, so do not translate it into a genre yourself.",
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

    /*
     * One scan, matching a genre OR a tag.
     *
     * Genres and tags used to be separate passes against separate sources, and
     * both were worse for it. The genre pass walked Steam's own appdetails one
     * game at a time - the endpoint that rate-limits - so it could only ever see
     * the first slice of a library. The tag pass trusted SteamSpy's bulk "all
     * games with tag X" list to choose candidates, and that list is truncated:
     * Horror returns 10,896 games and Roguelike returns 70, so a player with an
     * obscure roguelike was told they owned none.
     *
     * SteamSpy returns genre and tags together in one request, so both are
     * answered by walking the player's own library, which is the only set that
     * was ever relevant. Cached per appid, so a second question is nearly free.
     */
    cache.facets ??= new Map();
    const facetCache = cache.facets as Map<number, Facets>;

    /*
     * Ask SteamSpy which games carry this tag AT ALL, and check those first.
     *
     * One request, and it only reorders the scan - every game is still
     * eligible, so a truncated or noisy hint costs nothing but ordering. It is
     * what makes a 12 second budget enough: the matches are usually in the
     * first batch instead of four hundred games down the library.
     */
    const hintTag = await resolveTag(genre).catch(() => null);
    const hint = hintTag ? await taggedAppids(hintTag).catch(() => new Set<number>()) : new Set<number>();

    const { matches, checked, genresSeen, failed, ranOut } = await findByFacet(
      unstarted.map((game) => game.appid),
      genre,
      limit,
      async (appid) => {
        const known = facetCache.get(appid);
        if (known) return known;
        const facets = await gameFacets(appid);
        facetCache.set(appid, facets);
        return facets;
      },
      hint,
    );

    const byAppid = new Map(unstarted.map((game) => [game.appid, game.name]));
    const available = [...genresSeen].sort();
    const scannedEverything = !ranOut;

    if (matches.length > 0) {
      const viaTag = matches.every((match) => match.matchedBy === "tag");
      return {
        totalUnstarted: unstarted.length,
        genre,
        matchedBy: viaTag ? ("tag" as const) : ("genre" as const),
        checked,
        failedLookups: failed,
        games: matches.map((match) => ({
          appid: match.appid,
          name: byAppid.get(match.appid) ?? String(match.appid),
          genres: match.genres,
          tags: match.tags,
        })),
        note: `Found ${matches.length} matching "${genre}" in the first ${checked} of ${unstarted.length} unstarted games. Pass appids to score_backlog before recommending one.`,
      };
    }

    // Nothing matched. WHY it did not match decides what may be said, so the
    // word is checked against Steam's own vocabularies rather than against the
    // games that happened to be scanned.
    const isSteamGenre = STEAM_GENRES.includes(genre.trim().toLowerCase());

    let canonicalTag: string | null = null;
    let tagCheckFailed = false;
    try {
      canonicalTag = await resolveTag(genre);
    } catch {
      tagCheckFailed = true;
    }

    if (tagCheckFailed && !isSteamGenre) {
      return {
        totalUnstarted: unstarted.length,
        genre,
        checked,
        matchedBy: "tag-check-unavailable" as const,
        availableGenres: available,
        games: [],
        note: `Steam's tag list could not be reached, so it is UNKNOWN whether "${genre}" is a tag. Do NOT say Steam has no such tag and do NOT say the player owns none. Say you could not check tags just now and it is worth trying again.`,
      };
    }

    if (!isSteamGenre && canonicalTag === null) {
      const examples = await suggestTags().catch(() => []);
      return {
        totalUnstarted: unstarted.length,
        genre,
        checked,
        matchedBy: "nothing" as const,
        availableGenres: available,
        exampleTags: examples,
        games: [],
        note: `"${genre}" is neither a Steam genre nor a Steam tag, so there is nothing to filter on. Do NOT say the player owns none. Say Steam does not categorise games that way, then use ask_question to offer a mix of the genres these games do have (${available.join(", ")}) and a few real tags (${examples.join(", ")}).`,
      };
    }

    /*
     * If a big share of the lookups failed, "none of your games match" is not
     * something that was established - it is something that was not checked.
     *
     * SteamSpy went from 18 of 18 lookups succeeding to 5 of 8 over the course
     * of a day's testing, and the tool cheerfully reported that a library with
     * four cosy games in it had none. Same failure this codebase already
     * guards against for achievements: a lookup that did not answer is not a
     * fact about the player.
     */
    if (checked > 0 && failed / checked > 0.25) {
      return {
        totalUnstarted: unstarted.length,
        genre,
        checked,
        failedLookups: failed,
        matchedBy: "tag-check-unavailable" as const,
        availableGenres: available,
        games: [],
        note: `${failed} of the ${checked} games checked could not be looked up, so this search is not reliable. Say you could not check properly just now and it is worth trying again. Do NOT say the player owns nothing matching "${genre}".`,
      };
    }

    const kind = isSteamGenre ? "genre" : "tag";
    const label = canonicalTag ?? genre;
    return {
      totalUnstarted: unstarted.length,
      genre,
      checked,
      failedLookups: failed,
      matchedBy: "none-found" as const,
      scannedEverything,
      availableGenres: available,
      games: [],
      note: scannedEverything
        ? `"${label}" is a real Steam ${kind}, and none of the player's ${unstarted.length} unstarted games carry it. This one IS safe to state as a fact about their library.`
        : `"${label}" is a real Steam ${kind}, but none of the ${checked} games checked carry it, and that is only the first ${checked} of ${unstarted.length} unstarted games. Say exactly that. Do NOT say they own none: the rest were never looked at.`,
    };
  },
});
