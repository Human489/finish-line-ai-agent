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
  correctedTerm,
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
    scope: z
      .enum(["unstarted", "all"])
      .default("unstarted")
      .describe(
        "Which games to search. 'unstarted' is the default and means never launched. Use 'all' when the player is not asking for something NEW - 'a roguelike I own', 'do I have any horror games' - because a game they have already played is a perfectly good answer to that.",
      ),
    genre: z
      .string()
      .min(2)
      .optional()
      .describe(
        "What kind of game they asked for, in their own words: 'horror', 'cosy', 'souls-like', 'roguelike', 'strategy'. Checked against both Steam genres and Steam tags, so do not translate it into a genre yourself.",
      ),
  }),
  async execute({ steamId, limit, genre, scope }, ctx) {
    const cache = cacheFor(ctx.session.id);

    let library = cache.library as OwnedGame[] | undefined;
    if (!library) {
      library = await getOwnedGames(steamId);
      cache.library = library;
    }

    /*
     * "Unstarted" was the only thing this could search, which made half the
     * question unanswerable. Asked for a roguelike they already owned, the
     * model had no tool for it and fell back to recognising titles - naming one
     * game out of several, from memory, which is exactly the guessing the rest
     * of this app refuses to do.
     */
    // Named for what it holds, which depends on scope. It was called
    // `unstarted` throughout, and every note written against it said "never
    // launched" - true of the default, a fabrication under scope: "all".
    const pool =
      scope === "all" ? library : library.filter((game) => game.hoursPlayed === 0);
    const poolLabel = scope === "all" ? "games in this library" : "unstarted games";

    if (genre === undefined) {
      return {
        totalUnstarted: pool.length,
        games: pool.slice(0, limit).map((game) => ({
          appid: game.appid,
          name: game.name,
        })),
        note:
          scope === "all"
            ? "These come from the whole library, so some may already have been played. Pass appids to score_backlog for progress, hours-to-beat and Linux compatibility before recommending one."
            : "These have never been launched. Pass appids to score_backlog for hours-to-beat and Linux compatibility before recommending one.",
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
    // Corrected once, then used for BOTH the hint and the match test. Building
    // them from different strings is precisely how "cosy" searched the whole
    // library for a tag that does not exist while holding a list of the games
    // that carry the one that does.
    const term = await correctedTerm(genre);
    const hint = await taggedAppids(term).catch(() => new Set<number>());

    /*
     * The CORRECTED word, not the raw one.
     *
     * The hint was already built from tagTerm(genre) - "cosy" becomes "cozy" -
     * while the match test still compared against the raw word. Steam's tag is
     * "Cozy", so the scan checked every game in the library against a string
     * that appears nowhere and reported, with a straight face, that none of
     * them are cosy. tagTerm leaves any word it does not correct alone, so
     * genres pass through untouched.
     */
    const { matches, checked, genresSeen, failed, ranOut } = await findByFacet(
      pool.map((game) => game.appid),
      term,
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

    const byAppid = new Map(pool.map((game) => [game.appid, game.name]));
    const available = [...genresSeen].sort();
    /*
     * Every game was ATTEMPTED and every attempt SUCCEEDED. Both halves matter.
     *
     * This was just !ranOut, which only means the scan reached the end of the
     * list. Anything up to a quarter of those lookups could have failed - the
     * branch above only refuses the claim past 25% - and the note below still
     * told the model that "none of your games carry it" was safe to state as
     * fact. On a 460-game library that is up to ninety games never actually
     * confirmed, asserted as confirmed.
     */
    const scannedEverything = !ranOut && failed === 0;

    if (matches.length > 0) {
      const viaTag = matches.every((match) => match.matchedBy === "tag");
      return {
        totalUnstarted: pool.length,
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
        note: `Found ${matches.length} matching "${genre}" in the first ${checked} of ${pool.length} unstarted games. Pass appids to score_backlog before recommending one.`,
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
        totalUnstarted: pool.length,
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
        totalUnstarted: pool.length,
        genre,
        checked,
        matchedBy: "nothing" as const,
        availableGenres: available,
        exampleTags: examples,
        games: [],
        note: `"${genre}" is neither a Steam genre nor a Steam tag, so there is nothing to filter on. Do NOT say the player owns none. Say Steam does not categorise games that way, then you MUST call ask_question rather than listing alternatives in a sentence - the player gets buttons and a box to type in, which a list in prose does not give them. Offer a mix of the genres these games do have (${available.join(", ")}) and a few real tags (${examples.join(", ")}).`,
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
        totalUnstarted: pool.length,
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
      totalUnstarted: pool.length,
      genre,
      checked,
      failedLookups: failed,
      matchedBy: "none-found" as const,
      scannedEverything,
      availableGenres: available,
      games: [],
      note: scannedEverything
        ? `"${label}" is a real Steam ${kind}, and none of the player's ${pool.length} ${poolLabel} carry it. Every one was checked and every check succeeded, so this IS safe to state as a fact about that set - but say which set, not "your library" if only unstarted games were searched.`
        : `"${label}" is a real Steam ${kind}, but none of the ${checked} games checked carry it, and that is only the first ${checked} of ${pool.length} unstarted games. Say exactly that. Do NOT say they own none: the rest were never looked at.`,
    };
  },
});
