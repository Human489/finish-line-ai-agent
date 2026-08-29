import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooledSettled } from "../lib/cache";
import { getGameDetails, getOwnedGames, type GameDetails, type OwnedGame } from "../lib/steam";
import { appidsWithTag, confirmTagged, resolveTag, suggestTags } from "../lib/tags";

/** Genres are checked in batches, stopping as soon as enough games match. */
const GENRE_BATCH = 40;
/** Hard ceiling on how many games one genre question may look up. */
const GENRE_MAX_SCAN = 200;

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
    // Two different failures, and they were being reported as one.
    //   - not a Steam genre at all ("horror", "roguelike", "cosy"): a community
    //     tag, and tags are not on this endpoint. No scan would ever find it.
    //   - a real genre that this scan did not reach: only the sample is
    //     exhausted, not the library.
    // Matched against the WHOLE requested phrase, not any substring of it.
    // `wanted.includes(g)` was wrong in a way that showed up immediately:
    // "zoological accounting" contains "accounting", which is a real Steam
    // genre, so a nonsense phrase was reported as a genuine genre nobody owned.
    // Singular/plural is the only flex worth having ("RPGs", "strategy games"
    // arrive as "rpgs"/"strategy").
    const singular = wanted.replace(/s$/, "");
    const isSteamGenre =
      STEAM_GENRES.some((g) => g === wanted || g === singular || g.replace(/s$/, "") === singular) ||
      [...seen].some((g) => {
        const seenLower = g.toLowerCase();
        return seenLower === wanted || seenLower === singular;
      });
    const scannedEverything = checked >= unstarted.length;
    const available = [...seen].sort();

    /*
     * Steam's genres did not answer it, so try Steam's TAGS.
     *
     * Done inside this tool rather than by asking the model to try a second
     * one: every tool call is a full model request, and "genre, then tag, then
     * explain" as three round-trips is three requests for one question.
     *
     * Only reached when the word is not a genre at all. A real genre that
     * simply matched nothing is a different answer, and re-asking it as a tag
     * would muddle "you own none" with "Steam files that differently".
     */
    if (matches.length === 0 && !isSteamGenre) {
      /*
       * "Could not check" and "does not exist" are different answers.
       *
       * This was `.catch(() => null)`, which collapsed them: when Steam's tag
       * list did not load, the tool reported that Steam has no such tag, and
       * the app told a player "Steam doesn't categorise games as cosy" about a
       * tag Steam publishes. A lookup failure dressed up as a fact is the exact
       * mistake AchievementProgress.unknown exists to prevent elsewhere.
       */
      let canonicalTag: string | null = null;
      let tagCheckFailed = false;
      try {
        canonicalTag = await resolveTag(genre);
      } catch {
        tagCheckFailed = true;
      }

      if (tagCheckFailed) {
        return {
          totalUnstarted: unstarted.length,
          genre,
          checked,
          matchedBy: "tag-check-unavailable" as const,
          availableGenres: available,
          games: [],
          note: `Steam's tag list could not be reached, so it is UNKNOWN whether "${genre}" is a tag. Do NOT say Steam has no such tag and do NOT say the player owns none. Say you could not check tags just now and it is worth trying again, and offer the genres you did manage to check: ${available.join(", ")}.`,
        };
      }

      if (canonicalTag === null) {
        const examples = await suggestTags().catch(() => []);
        return {
          totalUnstarted: unstarted.length,
          genre,
          checked,
          matchedBy: "nothing" as const,
          availableGenres: available,
          exampleTags: examples,
          games: [],
          note: `"${genre}" is neither a Steam genre nor a Steam tag, so there is nothing to filter on. Do NOT say the player owns none. Say Steam does not categorise games that way, then use ask_question to offer a mix of the genres these games have (${available.join(", ")}) and a few real tags (${examples.join(", ")}).`,
        };
      }

      let tagged: Set<number>;
      try {
        tagged = await appidsWithTag(canonicalTag);
      } catch {
        // Same distinction again: the tag is real, the lookup is what failed.
        return {
          totalUnstarted: unstarted.length,
          genre,
          matchedBy: "tag-check-unavailable" as const,
          tag: canonicalTag,
          checked: 0,
          availableGenres: available,
          games: [],
          note: `"${canonicalTag}" IS a real Steam tag, but the lookup of which games carry it failed. Say you could not check it just now. Do NOT say the player owns no ${canonicalTag} games.`,
        };
      }
      const candidates = unstarted.filter((game) => tagged.has(game.appid));
      const { matches: confirmed, checked: tagChecks } = await confirmTagged(
        candidates.map((game) => game.appid),
        canonicalTag,
        limit,
      );

      const byAppid = new Map(unstarted.map((game) => [game.appid, game.name]));
      return {
        totalUnstarted: unstarted.length,
        genre,
        matchedBy: "tag" as const,
        tag: canonicalTag,
        candidatesWithTag: candidates.length,
        checked: tagChecks,
        availableGenres: available,
        games: confirmed.map((match) => ({
          appid: match.appid,
          name: byAppid.get(match.appid) ?? String(match.appid),
          genres: match.tags,
        })),
        note:
          confirmed.length > 0
            ? `"${canonicalTag}" is a Steam TAG rather than a genre, and these are confirmed to carry it near the top of their own tag votes. Pass appids to score_backlog before recommending one.`
            : `"${canonicalTag}" is a real Steam tag, but none of the ${tagChecks} of the player's unstarted games checked actually carry it prominently. Say that, and do not claim they own none unless candidatesWithTag is 0.`,
      };
    }

    return {
      totalUnstarted: unstarted.length,
      genre,
      checked,
      failedLookups,
      genreExists: isSteamGenre,
      matchedBy: matches.length > 0 ? ("genre" as const) : ("nothing" as const),
      scannedEverything,
      availableGenres: available,
      games: matches.slice(0, limit),
      note:
        matches.length > 0
          ? `Genres are Steam's own. Found ${matches.length} matching "${genre}" within the first ${checked} of ${unstarted.length} unstarted games. Pass appids to score_backlog before recommending one.`
          : !isSteamGenre
            ? `Steam does not publish "${genre}" as a genre, so this cannot be answered from genre data at all — it is a community tag, and tags are not available here. Do NOT say the player owns no ${genre} games, because that is not what was checked. Tell them Steam's genre data does not cover ${genre}, and offer the genres it does cover for these games: ${available.join(", ")}.`
            : scannedEverything
              ? `"${genre}" is a real Steam genre, and none of the player's ${unstarted.length} unstarted games list it. This one IS safe to state as a fact about their library.`
              : `"${genre}" is a real Steam genre, but none of the ${checked} games checked list it, and that is only the first ${checked} of ${unstarted.length} unstarted games. Say exactly that. Do NOT say they own no ${genre} games: the rest were never looked at.`,
    };
  },
});
