/**
 * Steam tags: the words people actually use for games.
 *
 * Steam's store genres are a short, coarse list - Action, Adventure, Indie,
 * RPG, Strategy and a few more. Nobody asks for "an Action game"; they ask for
 * something cosy, or a soulslike, or horror. Those are TAGS, and appdetails
 * does not carry them, which is why a horror question used to be unanswerable.
 *
 * Two sources, deliberately split by what each is actually authoritative for:
 *
 *   - Whether a tag EXISTS is answered by Steam itself, from the same tag list
 *     the store's own filters are built from. 430 tags, first-party.
 *   - Which games CARRY a tag is answered by SteamSpy, because Steam publishes
 *     no per-game tag endpoint at all. appdetails returns genres and
 *     categories and stops there.
 *
 * SteamSpy's tag data is crowd-voted and its bulk list is noisy: asking it for
 * everything tagged Horror returns 10,896 games including Apex Legends and
 * PUBG, because a single stray vote counts. Its PER-GAME data is good, though,
 * because it carries vote counts: Phasmophobia's top tag is Horror with 4,450
 * votes, and Apex Legends has no horror tag anywhere near its top. So the bulk
 * list is used only to narrow the field, and every game actually offered is
 * confirmed against its own tag votes.
 */

import { pooledSettled } from "./cache";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STEAM_TAGS = "https://store.steampowered.com/tagdata/populartags/english";
const STEAMSPY = "https://steamspy.com/api.php";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Much shorter for the per-game scan, because it runs hundreds of times.
 *
 * The deadline below is only checked BETWEEN batches, so a batch where every
 * request stalls costs the full timeout before anything notices. At 10s that
 * turned a 9 second budget into a 20 second one; at 3s the overshoot is small
 * enough to be honest about.
 */
const SCAN_TIMEOUT_MS = 3_000;

/**
 * A tag must be in a game's top few to count.
 *
 * This is the whole defence against "Apex Legends is horror". One person can
 * put any tag on any game; ranking by votes is what separates a game that IS
 * horror from one that somebody once thought was funny to label.
 */
const TAG_RANK_CEILING = 8;

/**
 * How many of the player's games one question may look at.
 *
 * Was 12, against a bulk list of "everything tagged X" used to pick which 12.
 * That list turned out to be truncated and popularity-skewed - Horror returns
 * 10,896 games, Roguelike returns 70 - so a player with an obscure roguelike
 * was told they had none. Measured instead: 18 per-game lookups at concurrency
 * 4 complete in half a second with no failures, so the library is now scanned
 * directly and the bulk list is not used at all.
 *
 * 800 rather than 200 because 200 was still a sample, not a search: a library
 * with 460 unstarted games had more than half of it never looked at, and a
 * player who owns exactly one roguelike was told there were none. The scan
 * stops the moment it has enough, so a common word still costs a handful of
 * lookups and only a genuinely rare one walks the whole library. Every result
 * is cached per appid, so the second question about a library costs nothing.
 */
const MAX_LOOKUPS = 800;
const LOOKUP_CONCURRENCY = 12;

/**
 * Wall-clock ceiling on one search, whatever the game budget says.
 *
 * Raising the budget to cover a whole library fixed the wrong answers and
 * introduced a worse problem: a word that is not in the library walks all of it
 * before saying so, and the player sits watching nothing happen. A count is the
 * wrong unit for "how long will this take" - the right one is time.
 *
 * On a hit this rarely matters, because the scan stops as soon as it has
 * enough. It binds on the miss, which is exactly the case that used to hang.
 */
const TIME_BUDGET_MS = 12_000;

/**
 * SteamSpy's "every game with tag X" list, used ONLY to decide what to look at
 * first.
 *
 * It is not trustworthy as an answer: it is truncated and popularity-skewed,
 * returning 10,896 games for Horror and 70 for Roguelike, and it counts a
 * single stray vote, which is how Apex Legends ends up in the horror list. It
 * is excellent as a hint, though, because a game that appears in it is far more
 * likely to be a real match than an arbitrary game from the library.
 *
 * This matters because of the time budget. Scanning a 460-game library in
 * library order found cosy games when the budget was measured in games and
 * stopped finding them when it became measured in seconds - the matches were
 * simply further down the list than the clock now reaches. Checking the likely
 * candidates first puts them within the first batch or two instead.
 */
export async function taggedAppids(tag: string): Promise<Set<number>> {
  const response = await fetch(`${STEAMSPY}?request=tag&tag=${encodeURIComponent(tag)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return new Set();

  const body = (await response.json()) as Record<string, unknown>;
  const appids = new Set<number>();
  for (const key of Object.keys(body)) {
    const appid = Number(key);
    if (Number.isFinite(appid)) appids.add(appid);
  }
  return appids;
}

/**
 * A hand-written map of near-misses, kept ONLY for when Steam's tag list cannot
 * be fetched. It is a poor substitute: it fixes the spellings someone thought
 * of, and "cosy" cost a real bug before anyone thought of it. When the
 * vocabulary is available, bestTagMatch does this properly.
 */
const SPELLING: Record<string, string> = {
  cosy: "cozy",
  soulslike: "souls-like",
  soulsborne: "souls-like",
};

/** Lowercased, with the punctuation people vary on removed. */
function fold(term: string): string {
  return term.trim().toLowerCase().replace(/[\s\-_'']/g, "");
}

/** Levenshtein, bounded: anything past `limit` is not a candidate anyway. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The Steam tag a player most likely meant, or null if nothing is close.
 *
 * Pure, so it can be tested without the network. Tried in order of confidence:
 * an exact fold, a plural, then a small edit distance. The distance step is
 * what turns a whole class of bug into a non-event - "cosy" for Cozy,
 * "roguelike" for Rogue-like, a doubled letter, a missing hyphen - rather than
 * waiting for each one to be reported and added to a list by hand.
 *
 * Deliberately strict about what it will NOT match. A word has to be at least
 * four characters before fuzzy matching applies, and the allowance is one edit
 * for short words and two for long ones, so "zoological accounting" stays
 * unmatched instead of being bent into "Accounting" - which would answer a
 * question nobody asked.
 */
export function bestTagMatch(term: string, vocabulary: string[]): string | null {
  const wanted = fold(term);
  if (wanted.length === 0) return null;

  const folded = vocabulary.map((name) => ({ name, key: fold(name) }));

  const exact = folded.find((tag) => tag.key === wanted);
  if (exact) return exact.name;

  const singular = wanted.replace(/s$/, "");
  const plural = folded.find((tag) => tag.key === singular || tag.key.replace(/s$/, "") === singular);
  if (plural) return plural.name;

  // Four, not five: "cosy" is four characters and is the exact case that
  // started this. One edit is a tight allowance at that length.
  if (wanted.length < 4) return null;
  const limit = wanted.length >= 8 ? 2 : 1;

  let best: { name: string; score: number } | null = null;
  for (const tag of folded) {
    const score = distance(wanted, tag.key, limit);
    if (score <= limit && (best === null || score < best.score)) {
      best = { name: tag.name, score };
    }
  }
  return best?.name ?? null;
}

let tagCache: { names: Map<string, string>; fetchedAt: number } | null = null;
const TAG_TTL_MS = 60 * 60 * 1000;

/**
 * The player's word, spelling-corrected, for use as a SteamSpy tag.
 *
 * Exported so the candidate hint can be built WITHOUT Steam's tag list. That
 * list lives on store.steampowered.com, which throttles this app's serverless
 * IP, and when the fetch failed the hint came back empty, the scan fell back to
 * library order, and cosy games four hundred entries down were never reached.
 * SteamSpy's tag endpoint is case-insensitive, so the raw word is enough.
 */
export function tagTerm(term: string): string {
  return normalise(term);
}

/**
 * The player's word, corrected against Steam's real tag vocabulary when it can
 * be reached, and against the hand-written map when it cannot.
 *
 * Returns a lowercased term for matching. SteamSpy's tag endpoint is
 * case-insensitive, so the case does not matter to it.
 */
export async function correctedTerm(term: string): Promise<string> {
  try {
    const names = await steamTagNames();
    const match = bestTagMatch(term, [...names.values()]);
    if (match) return match.toLowerCase();
  } catch {
    // Steam's tag list is on the host that throttles this app. Falling back to
    // the hand-written map is worse but not nothing.
  }
  return normalise(term);
}

function normalise(term: string): string {
  const cleaned = term.trim().toLowerCase();
  return SPELLING[cleaned.replace(/[\s-]/g, "")] ?? cleaned;
}

/** Steam's own tag vocabulary, lowercased name -> canonical name. */
async function steamTagNames(): Promise<Map<string, string>> {
  if (tagCache && Date.now() - tagCache.fetchedAt < TAG_TTL_MS) return tagCache.names;

  const response = await fetch(STEAM_TAGS, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Steam tag list failed (HTTP ${response.status}).`);

  const body = (await response.json()) as { name?: string }[];
  const names = new Map<string, string>();
  for (const tag of body) {
    if (typeof tag.name === "string") names.set(tag.name.toLowerCase(), tag.name);
  }

  tagCache = { names, fetchedAt: Date.now() };
  return names;
}

/**
 * The canonical Steam tag for a player's word, or null if Steam has no such
 * tag. Returning the canonical spelling matters: it is what gets shown back.
 */
export async function resolveTag(term: string): Promise<string | null> {
  const names = await steamTagNames();
  // Same matcher the scan uses. Looking the word up exactly here while the scan
  // corrected it meant a typo was searched for correctly and then reported as
  // "Steam does not cover rougelike" - with Roguelike offered as a button in
  // the same sentence.
  return bestTagMatch(term, [...names.values()]) ?? names.get(normalise(term)) ?? null;
}

/** A handful of real tags to offer when the player's word is not one. */
export async function suggestTags(): Promise<string[]> {
  const names = await steamTagNames();
  // Common enough to be useful as examples, and all confirmed present rather
  // than hardcoded blind - Steam has renamed tags before.
  const wanted = ["Horror", "Cozy", "Souls-like", "Roguelike", "Puzzle", "Story Rich"];
  return wanted.filter((tag) => names.has(tag.toLowerCase()));
}

export type Facets = { genres: string[]; tags: string[] };

/**
 * One game's genres AND its tags, in a single request.
 *
 * Both come back together, which is why the genre scan uses this too. It used
 * to walk Steam's own appdetails one game at a time, which is the endpoint that
 * rate-limits, so a genre question could only ever look at the first slice of a
 * library before being throttled.
 *
 * Tags are returned most-voted first: the order is what separates a game that
 * IS horror from one somebody once labelled that way for a joke.
 */
export async function gameFacets(appid: number, attempt = 0): Promise<Facets> {
  const response = await fetch(`${STEAMSPY}?request=appdetails&appid=${appid}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });

  // One retry. Measured mid-session: SteamSpy went from 18 of 18 lookups
  // succeeding to 5 of 8, having been scanned hard all day. A flaky third party
  // silently dropping a third of the library is how "you own no cosy games"
  // gets said about a library with four of them.
  if (!response.ok && attempt === 0) {
    await sleep(250);
    return gameFacets(appid, 1);
  }
  if (!response.ok) throw new Error(`SteamSpy lookup failed (HTTP ${response.status}).`);

  const body = (await response.json()) as {
    genre?: string;
    tags?: Record<string, number> | unknown[];
  };

  const genres =
    typeof body.genre === "string"
      ? body.genre.split(",").map((part) => part.trim()).filter(Boolean)
      : [];

  // SteamSpy returns {} or [] for a game nobody has tagged.
  const raw = body.tags;
  const tags =
    raw && !Array.isArray(raw)
      ? Object.entries(raw)
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name)
      : [];

  return { genres, tags };
}

export type TagMatch = { appid: number; genres: string[]; tags: string[]; matchedBy: "genre" | "tag" };

/**
 * Walk the player's games looking for one word, as a genre OR a tag.
 *
 * Stops as soon as `wanted` are found, so a common word costs a handful of
 * lookups and only a rare one spends the budget. Results are cached by the
 * caller, so asking a second question about the same library is nearly free.
 */
export async function findByFacet(
  appids: number[],
  term: string,
  wanted: number,
  lookup: (appid: number) => Promise<Facets>,
  hint: Set<number> = new Set(),
): Promise<{
  matches: TagMatch[];
  checked: number;
  genresSeen: Set<string>;
  failed: number;
  ranOut: boolean;
}> {
  const target = fold(term);
  const singular = target.replace(/s$/, "");

  /*
   * A tag matches if the whole tag matches, OR any word of it does.
   *
   * Steam does not have one roguelike tag, it has several: Rogue-like,
   * Rogue-lite, Action Roguelike and Roguelike Deckbuilder. Comparing whole
   * names meant Cult of the Lamb ("Action Roguelike") and Slay the Spire
   * ("Roguelike Deckbuilder") were not roguelikes as far as this was concerned,
   * which is nonsense to anyone who has played them. Same for horror:
   * Psychological Horror and Survival Horror are horror.
   *
   * Matched per WORD rather than as a substring, which matters: "Art" is a real
   * tag and a substring match would find it inside "Cartoon".
   */
  const hits = (name: string): boolean => {
    const whole = fold(name);
    if (whole === target || whole === singular) return true;
    return name
      .split(/\s+/)
      .some((word) => fold(word) === target || fold(word) === singular);
  };

  // Likely candidates first, then everything else. Same set of games either
  // way - only the order changes, so nothing is excluded by the hint being
  // wrong or incomplete, it just takes longer to reach.
  const likely = appids.filter((appid) => hint.has(appid));
  const rest = appids.filter((appid) => !hint.has(appid));
  const budget = [...likely, ...rest].slice(0, MAX_LOOKUPS);

  const matches: TagMatch[] = [];
  const genresSeen = new Set<string>();
  const deadline = Date.now() + TIME_BUDGET_MS;
  let checked = 0;
  let failed = 0;
  // When the source itself is down or throttling us, every remaining lookup
  // will fail the same way. Two dead batches is enough to know.
  let consecutiveFailures = 0;

  for (
    let i = 0;
    i < budget.length && matches.length < wanted && Date.now() < deadline;
    i += LOOKUP_CONCURRENCY
  ) {
    const slice = budget.slice(i, i + LOOKUP_CONCURRENCY);
    const settled = await pooledSettled(slice, LOOKUP_CONCURRENCY, lookup);
    if (settled.every((result) => result.status !== "fulfilled")) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) {
        checked += slice.length;
        failed += slice.length;
        break;
      }
    }

    settled.forEach((result, index) => {
      checked += 1;
      if (result.status !== "fulfilled") {
        failed += 1;
        return;
      }
      consecutiveFailures = 0;

      const { genres, tags } = result.value;
      genres.forEach((g) => genresSeen.add(g));

      const genreHit = genres.some((g) => hits(g));
      // A tag only counts near the top of the game's own votes. One person can
      // put any tag on any game, and this is what keeps Apex Legends - which
      // really does carry a horror tag - out of a horror recommendation.
      const tagRank = tags.findIndex((t) => hits(t));
      const tagHit = tagRank >= 0 && tagRank < TAG_RANK_CEILING;

      if (genreHit || tagHit) {
        matches.push({
          appid: slice[index],
          genres,
          tags: tags.slice(0, 6),
          matchedBy: genreHit ? "genre" : "tag",
        });
      }
    });
  }

  // ranOut says the search was cut short, so the caller can tell the player
  // "none of the ones I looked at" instead of "you own none".
  return { matches, checked, genresSeen, failed, ranOut: checked < appids.length };
}
