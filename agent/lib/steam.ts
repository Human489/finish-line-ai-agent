/**
 * Steam data access.
 *
 * Two hosts with very different rules:
 *   api.steampowered.com   - needs STEAM_WEB_API_KEY, 100k calls/day, burst throttled.
 *   store/community        - keyless, undocumented, rate limited by IP.
 *
 * Every keyed call goes through `keyedFetch`, which retries on 429 with backoff.
 */

const WEB_API = "https://api.steampowered.com";
const COMMUNITY = "https://steamcommunity.com";

export class SteamKeyMissingError extends Error {
  constructor() {
    super(
      "STEAM_WEB_API_KEY is not set. Library and achievement data need a free key from https://steamcommunity.com/dev/apikey",
    );
  }
}

function apiKey(): string {
  const key = process.env.STEAM_WEB_API_KEY;
  if (!key) throw new SteamKeyMissingError();
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function keyedFetch(url: string, attempt = 0): Promise<Response> {
  const response = await fetch(url, { cache: "no-store" });

  if (response.status === 429 && attempt < 4) {
    await sleep(500 * 2 ** attempt);
    return keyedFetch(url, attempt + 1);
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

  const response = await fetch(target, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Steam profile lookup failed (HTTP ${response.status}).`);
  }

  const xml = await response.text();
  const steamId = xml.match(/<steamID64>(\d+)<\/steamID64>/)?.[1];

  if (!steamId) {
    throw new Error(
      `No Steam profile found for "${input}". Check the vanity name or SteamID64.`,
    );
  }

  return {
    steamId,
    privacyState: xml.match(/<privacyState>([^<]+)<\/privacyState>/)?.[1] ?? "unknown",
    personaName: xml.match(/<steamID><!\[CDATA\[([^\]]*)\]\]><\/steamID>/)?.[1],
  };
}

/** Entire library in one keyed call: names, appids and playtime. */
export async function getOwnedGames(steamId: string): Promise<OwnedGame[]> {
  const url =
    `${WEB_API}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${apiKey()}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`;

  const response = await keyedFetch(url);

  if (response.status === 401 || response.status === 403) {
    throw new Error("Steam rejected the API key. Check STEAM_WEB_API_KEY.");
  }
  if (!response.ok) {
    throw new Error(`GetOwnedGames failed (HTTP ${response.status}).`);
  }

  const body = (await response.json()) as {
    response?: { games?: { appid: number; name?: string; playtime_forever?: number }[] };
  };

  const games = body.response?.games;
  if (!games) {
    throw new Error(
      "Steam returned no games. The profile's game details are probably set to private.",
    );
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

  const empty: AchievementProgress = {
    appid,
    hasAchievements: false,
    earned: 0,
    total: 0,
    percent: null,
    unearned: [],
  };

  let response: Response;
  try {
    response = await keyedFetch(url);
  } catch {
    return empty;
  }

  // 400 here means "this game has no achievements" or "stats are private".
  if (!response.ok) return empty;

  const body = (await response.json()) as {
    playerstats?: {
      success?: boolean;
      achievements?: { apiname: string; achieved: number }[];
    };
  };

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
    const response = await fetch(url, { cache: "no-store" });
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
    }).then((r) => r.json()),
    fetch(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`,
      { cache: "no-store" },
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

/** ProtonDB compatibility. Keyless, unofficial. Display only - never scored. */
export async function getProtonRating(appid: number): Promise<ProtonRating | null> {
  try {
    const response = await fetch(
      `https://www.protondb.com/api/v1/reports/summaries/${appid}.json`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;

    const body = (await response.json()) as {
      tier?: string;
      score?: number;
      confidence?: string;
      total?: number;
    };

    if (!body.tier) return null;

    return {
      tier: body.tier,
      score: body.score ?? null,
      confidence: body.confidence ?? null,
      reports: body.total ?? null,
    };
  } catch {
    return null;
  }
}
