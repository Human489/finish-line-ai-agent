/**
 * Steam data access.
 *
 * Two hosts with very different rules:
 *   api.steampowered.com   - needs STEAM_WEB_API_KEY, 100k calls/day, burst throttled.
 *   store/community        - keyless, undocumented, rate limited by IP.
 *
 * Every call goes through `steamFetch`, which retries a 429 or a 5xx with backoff.
 */

/**
 * Bounds every outbound call. `fetch` rejects on a transport error but waits
 * forever on a server that accepts and then goes quiet, which would hang a
 * tool step with no way out — the queue delivery around it gets retried, the
 * in-flight step does not. Steam is reliable enough that this is a backstop
 * rather than a routine path, but resolveSteamId is the first call of every
 * conversation and is also reachable unauthenticated via /api/steam/verify.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const WEB_API = "https://api.steampowered.com";
const COMMUNITY = "https://steamcommunity.com";

export class SteamKeyMissingError extends Error {
  constructor() {
    super(
      "STEAM_WEB_API_KEY is not set. Library and achievement data need a free key from https://steamcommunity.com/dev/apikey",
    );
  }
}

/**
 * The key exists but Steam refused it: revoked, expired or malformed.
 *
 * Typed rather than a bare Error so callers can classify it without matching
 * on message text. The message names no environment variable: this reaches an
 * unauthenticated HTTP route, and a stranger has no business learning the
 * server's configuration from an error. The operator finds the cause in the
 * server logs, where the status code is already recorded.
 */
export class SteamKeyRejectedError extends Error {
  constructor() {
    super("Steam refused this server's API key.");
  }
}

/**
 * Steam answered, but not with an answer: a 5xx, a gateway error, an outage.
 *
 * Typed separately from the two key errors and from the private-library case
 * because all three used to collapse into one visitor-facing sentence, and the
 * advice for each is different. Telling someone to check their privacy
 * settings during a Steam outage sends them to fix something that is not
 * broken.
 */
export class SteamUnavailableError extends Error {
  constructor(status: number) {
    super(`Steam returned HTTP ${status}.`);
  }
}

/** Public profile, private game details - the one case that IS the visitor's to fix. */
export class SteamLibraryPrivateError extends Error {
  constructor() {
    super("Steam returned no games list for this profile.");
  }
}

/** No such vanity name or SteamID64. Safe to repeat back to whoever asked. */
export class SteamProfileNotFoundError extends Error {
  constructor(readonly input: string) {
    super(`No Steam profile found for "${input}".`);
  }
}

function apiKey(): string {
  const key = process.env.STEAM_WEB_API_KEY;
  if (!key) throw new SteamKeyMissingError();
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every Steam call goes through this: retries a throttle or a server error
 * before letting it become the visitor's problem.
 *
 * 5xx is retried as well as 429 because both are Steam having a moment rather
 * than anything wrong with the request. This app runs on serverless, where the
 * outbound IP is shared with whoever else is on that instance, so being
 * throttled through no fault of your own is a normal event rather than an edge
 * case. A player reported "Steam did not respond properly just now" on a
 * profile that resolves perfectly a second later, which is exactly this.
 *
 * Only status codes are retried. A 401 or 403 is a key problem and will fail
 * identically every time, and a 404 means what it says.
 */
async function steamFetch(url: string, attempt = 0): Promise<Response> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const worthRetrying = response.status === 429 || response.status >= 500;
  if (worthRetrying && attempt < 3) {
    await sleep(400 * 2 ** attempt);
    return steamFetch(url, attempt + 1);
  }

  return response;
}

export type OwnedGame = {
  appid: number;
  name: string;
  /** Hours, rounded to one decimal. Steam reports minutes. */
  hoursPlayed: number;
};

/** Accepts a vanity name, a full profile URL, or a raw SteamID64. Keyless. */
export async function resolveSteamId(
  input: string,
): Promise<{ steamId: string; privacyState: string; personaName?: string }> {
  const trimmed = input.trim();

  const urlMatch = trimmed.match(
    /steamcommunity\.com\/(id|profiles)\/([^/?#]+)/i,
  );
  const candidate = urlMatch ? urlMatch[2] : trimmed;
  const isSteamId64 = /^\d{17}$/.test(candidate);

  const target = isSteamId64
    ? `${COMMUNITY}/profiles/${candidate}/?xml=1`
    : `${COMMUNITY}/id/${encodeURIComponent(candidate)}/?xml=1`;

  // Was a bare fetch with no retry at all, which is how a single throttled
  // request became a dead end on the very first screen.
  const response = await steamFetch(target);
  if (!response.ok) {
    throw new SteamUnavailableError(response.status);
  }

  const xml = await response.text();
  const steamId = xml.match(/<steamID64>(\d+)<\/steamID64>/)?.[1];

  if (!steamId) {
    throw new SteamProfileNotFoundError(input);
  }

  return {
    steamId,
    privacyState: xml.match(/<privacyState>([^<]+)<\/privacyState>/)?.[1] ?? "unknown",
    // Non-greedy up to the actual `]]></steamID>` terminator: a `[^\]]*` body
    // truncates any persona name that itself contains a `]` (e.g. "[EU] Name").
    personaName: xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/)?.[1],
  };
}

/** Entire library in one keyed call: names, appids and playtime. */
export async function getOwnedGames(steamId: string): Promise<OwnedGame[]> {
  const url =
    `${WEB_API}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${apiKey()}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`;

  const response = await steamFetch(url);

  if (response.status === 401 || response.status === 403) {
    throw new SteamKeyRejectedError();
  }
  if (!response.ok) {
    throw new SteamUnavailableError(response.status);
  }

  const body = (await response.json()) as {
    response?: { games?: { appid: number; name?: string; playtime_forever?: number }[] };
  };

  const games = body.response?.games;
  if (!games) {
    throw new SteamLibraryPrivateError();
  }

  return games.map((game) => ({
    appid: game.appid,
    name: game.name ?? `App ${game.appid}`,
    hoursPlayed: Math.round(((game.playtime_forever ?? 0) / 60) * 10) / 10,
  }));
}

export type AchievementProgress = {
  appid: number;
  hasAchievements: boolean;
  earned: number;
  total: number;
  /** 0-100, or null when the game has no achievements. */
  percent: number | null;
  unearned: string[];
  /** True when we could not determine whether this game has achievements (network/parse failure, or Steam refused). Distinct from a confirmed "has none". */
  unknown: boolean;
};

/**
 * One keyed call per game. GetPlayerAchievements already returns every
 * achievement with an `achieved` flag, so the totals come from the same
 * response and GetSchemaForGame is not needed for the percentage.
 */
export async function getAchievementProgress(
  steamId: string,
  appid: number,
): Promise<AchievementProgress> {
  const url =
    `${WEB_API}/ISteamUserStats/GetPlayerAchievements/v1/` +
    `?key=${apiKey()}&steamid=${steamId}&appid=${appid}&l=en&format=json`;

  // "Confirmed none" - Steam answered and there is genuinely nothing to earn.
  const empty: AchievementProgress = {
    appid,
    hasAchievements: false,
    earned: 0,
    total: 0,
    percent: null,
    unearned: [],
    unknown: false,
  };

  // "Could not tell" - a transient failure, not a fact about the game. Kept
  // distinct from `empty` so downstream scoring never claims "no achievements"
  // off the back of a dropped connection or a malformed body.
  const unknown: AchievementProgress = { ...empty, unknown: true };

  let response: Response;
  try {
    response = await steamFetch(url);
  } catch {
    return unknown;
  }

  let body: {
    playerstats?: {
      success?: boolean;
      error?: string;
      achievements?: { apiname: string; achieved: number }[];
    };
  };
  // Parsed even on a non-2xx, because Steam says which kind of failure it is.
  // A game with no achievements answers 400 with
  //   {"playerstats":{"error":"Requested app has no stats","success":false}}
  // which is a definite answer, not a refusal — verified against Half-Life
  // (appid 70). Treating every 400 as "unknown" made the common case (an old
  // game that simply has no achievements) look like a failed lookup, which
  // then showed up as a spurious "the sweep is partial" warning.
  try {
    body = await response.json();
  } catch {
    return unknown;
  }

  const noStats = /has no stats/i.test(body.playerstats?.error ?? "");
  if (noStats) return empty;
  // Any other non-2xx really is a refusal we cannot interpret.
  if (!response.ok) return unknown;

  const achievements = body.playerstats?.achievements;
  if (!body.playerstats?.success || !achievements || achievements.length === 0) {
    return empty;
  }

  const earned = achievements.filter((a) => a.achieved === 1).length;

  return {
    appid,
    hasAchievements: true,
    earned,
    total: achievements.length,
    percent: Math.round((earned / achievements.length) * 1000) / 10,
    unearned: achievements.filter((a) => a.achieved !== 1).map((a) => a.apiname),
    unknown: false,
  };
}

/** Global unlock rate per achievement. Keyless - costs no quota at all. */
export async function getGlobalRarity(
  appid: number,
): Promise<Record<string, number>> {
  const url =
    `${WEB_API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/` +
    `?gameid=${appid}&format=json`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return {};

    const body = (await response.json()) as {
      achievementpercentages?: { achievements?: { name: string; percent: number | string }[] };
    };

    const entries = body.achievementpercentages?.achievements ?? [];
    return Object.fromEntries(entries.map((a) => [a.name, Number(a.percent)]));
  } catch {
    return {};
  }
}

export type GameDetails = {
  appid: number;
  name: string | null;
  genres: string[];
  /** Steam's own review bucket, e.g. "Overwhelmingly Positive". Null if too few reviews. */
  reviewSummary: string | null;
  totalReviews: number;
};

/**
 * Genre and rating, from two keyless store endpoints. This is what makes a
 * genre or rating request answerable from real data instead of the model
 * guessing from a game's name.
 */
export async function getGameDetails(appid: number): Promise<GameDetails> {
  const empty: GameDetails = {
    appid,
    name: null,
    genres: [],
    reviewSummary: null,
    totalReviews: 0,
  };

  const [detailsResult, reviewsResult] = await Promise.allSettled([
    fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=gb`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then((r) => r.json()),
    fetch(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`,
      { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    ).then((r) => r.json()),
  ]);

  if (detailsResult.status === "fulfilled") {
    const entry = detailsResult.value?.[String(appid)];
    if (entry?.success) {
      empty.name = entry.data?.name ?? null;
      empty.genres = (entry.data?.genres ?? []).map(
        (g: { description?: string }) => g.description ?? "",
      ).filter(Boolean);
    }
  }

  if (reviewsResult.status === "fulfilled") {
    const summary = reviewsResult.value?.query_summary;
    if (summary?.total_reviews > 0) {
      empty.reviewSummary = summary.review_score_desc ?? null;
      empty.totalReviews = summary.total_reviews;
    }
  }

  return empty;
}

export type ProtonRating = {
  tier: string;
  score: number | null;
  confidence: string | null;
  reports: number | null;
};

/**
 * "ProtonDB has nothing on this game" and "ProtonDB did not answer" are
 * different, and returning null for both said the first when only the second
 * was true.
 *
 * Same distinction AchievementProgress.unknown already makes for Steam. A
 * player on a game with hundreds of Linux reports was told its compatibility
 * was undocumented whenever ProtonDB happened to time out.
 */
export type ProtonLookup =
  | { status: "ok"; rating: ProtonRating }
  | { status: "none" }
  | { status: "unknown" };

/** ProtonDB compatibility. Keyless, unofficial. Display only - never scored. */
export async function getProtonRating(appid: number): Promise<ProtonLookup> {
  try {
    const response = await fetch(
      `https://www.protondb.com/api/v1/reports/summaries/${appid}.json`,
      { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    // 404 is ProtonDB saying it has no reports for this appid, which is an
    // answer. Anything else is it failing to answer, which is not.
    if (response.status === 404) return { status: "none" };
    if (!response.ok) return { status: "unknown" };

    const body = (await response.json()) as {
      tier?: string;
      score?: number;
      confidence?: string;
      total?: number;
    };

    if (!body.tier) return { status: "none" };

    return {
      status: "ok",
      rating: {
        tier: body.tier,
        score: body.score ?? null,
        confidence: body.confidence ?? null,
        reports: body.total ?? null,
      },
    };
  } catch {
    // Timeout, network failure, unparseable body: all "did not answer".
    return { status: "unknown" };
  }
}
