/**
 * Hours-to-beat estimates from HowLongToBeat.
 *
 * There is no official API. The site's search endpoint is guarded by a
 * short-lived token bound to the caller's IP and User-Agent, plus a per-request
 * challenge pair. The handshake below mirrors what the site's own client does:
 *
 *   1. GET  /api/search/site/init  -> { token, hpKey, hpVal }
 *   2. POST /api/search/site       with x-auth-token / x-hp-key / x-hp-val
 *                                  headers AND { [hpKey]: hpVal } in the body
 *   3. On 403, the token has expired: re-init once and retry.
 *
 * This is unofficial and can break without notice, so every failure path
 * returns "no data" rather than throwing. The agent is instructed to say it
 * has no hours rather than guess.
 *
 * SteamSpy was evaluated as a fallback and rejected: its `median_forever` and
 * `average_forever` fields return 0 for every game tested, so it carries no
 * playtime signal at all any more.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ORIGIN = "https://howlongtobeat.com";

export type PlaytimeEstimate = {
  hoursToBeat: number | null;
  hoursTo100: number | null;
  source: "howlongtobeat" | "none";
  matchedName: string | null;
  note: string | null;
};

const NO_DATA: PlaytimeEstimate = {
  hoursToBeat: null,
  hoursTo100: null,
  source: "none",
  matchedName: null,
  note: "No HowLongToBeat data found for this game.",
};

type SearchToken = { token: string; hpKey: string; hpVal: string };

/** Tokens are short-lived and IP/UA-bound; held for the process lifetime. */
let cachedToken: SearchToken | null = null;

async function initToken(): Promise<SearchToken | null> {
  try {
    const response = await fetch(`${ORIGIN}/api/search/site/init?t=${Date.now()}`, {
      headers: { "User-Agent": UA, Referer: `${ORIGIN}/` },
      cache: "no-store",
    });
    if (!response.ok) return null;

    const body = (await response.json()) as Partial<SearchToken>;
    if (!body.token || !body.hpKey || !body.hpVal) return null;

    cachedToken = { token: body.token, hpKey: body.hpKey, hpVal: body.hpVal };
    return cachedToken;
  } catch {
    return null;
  }
}

function searchBody(title: string, hpKey: string, hpVal: string) {
  return {
    searchType: "games",
    searchTerms: title.trim().split(/\s+/).filter(Boolean),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: "",
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: null, max: null },
        gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
        rangeYear: { min: "", max: "" },
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
    [hpKey]: hpVal,
  };
}

type HltbGame = {
  game_name?: string;
  /** Seconds. */
  comp_main?: number;
  comp_100?: number;
};

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Steam and HowLongToBeat disagree on punctuation and edition suffixes, so
 * match on a normalized form and fall back to the most popular result.
 */
function pickBestMatch(title: string, games: HltbGame[]): HltbGame | null {
  const target = normalize(title);
  return (
    games.find((game) => normalize(game.game_name ?? "") === target) ??
    games.find((game) => normalize(game.game_name ?? "").startsWith(target)) ??
    games.find((game) => target.startsWith(normalize(game.game_name ?? ""))) ??
    games[0] ??
    null
  );
}

async function search(title: string, allowRetry = true): Promise<HltbGame[] | null> {
  const auth = cachedToken ?? (await initToken());
  if (!auth) return null;

  try {
    const response = await fetch(`${ORIGIN}/api/search/site`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-token": auth.token,
        "x-hp-key": auth.hpKey,
        "x-hp-val": auth.hpVal,
        "User-Agent": UA,
        Referer: `${ORIGIN}/`,
        Origin: ORIGIN,
      },
      body: JSON.stringify(searchBody(title, auth.hpKey, auth.hpVal)),
      cache: "no-store",
    });

    // Expired or rotated token. Re-init once, exactly as their client does.
    if (response.status === 403 && allowRetry) {
      cachedToken = null;
      return search(title, false);
    }
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: HltbGame[] };
    return body.data ?? [];
  } catch {
    return null;
  }
}

const toHours = (seconds?: number) =>
  seconds && seconds > 0 ? Math.round((seconds / 3600) * 10) / 10 : null;

export async function getPlaytimeEstimate(title: string): Promise<PlaytimeEstimate> {
  const games = await search(title);
  if (!games || games.length === 0) return NO_DATA;

  const best = pickBestMatch(title, games);
  if (!best) return NO_DATA;

  const hoursToBeat = toHours(best.comp_main);
  const hoursTo100 = toHours(best.comp_100);
  if (hoursToBeat === null && hoursTo100 === null) return NO_DATA;

  const matchedName = best.game_name ?? null;

  return {
    hoursToBeat,
    hoursTo100,
    source: "howlongtobeat",
    matchedName,
    // Surface a fuzzy match so the agent can flag it rather than quietly
    // reporting another game's hours.
    note:
      matchedName && normalize(matchedName) !== normalize(title)
        ? `Matched to "${matchedName}" on HowLongToBeat, which is not an exact title match.`
        : null,
  };
}
