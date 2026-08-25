/**
 * Deterministic backlog scoring.
 *
 * Every number the agent is allowed to say comes from here. The model never
 * performs arithmetic and never chooses a category: it receives the computed
 * verdict as a fixed field and may only write a short reason around it.
 */

import type { PlaytimeEstimate } from "./playtime";
import type { AchievementProgress, ProtonRating } from "./steam";

export type Mode = "completionist" | "beat-once";

export type Category =
  | "proton-blocked"
  | "finish-line"
  | "quick-win"
  | "rarity-wall-ahead"
  | "keep-going"
  | "never-started"
  | "long-haul";

export const CATEGORY_LABELS: Record<Category, string> = {
  "proton-blocked": "Proton-Blocked",
  "finish-line": "Finish Line",
  "quick-win": "Quick Win",
  "rarity-wall-ahead": "Rarity Wall Ahead",
  "keep-going": "Keep Going",
  "never-started": "Never Started",
  "long-haul": "Long Haul",
};

export type ScoreInput = {
  appid: number;
  name: string;
  hoursPlayed: number;
  achievements?: AchievementProgress | null;
  playtime?: PlaytimeEstimate | null;
  proton?: ProtonRating | null;
  /** apiname -> global unlock percentage. */
  rarity?: Record<string, number> | null;
};

export type ScoredGame = {
  appid: number;
  name: string;
  category: Category;
  categoryLabel: string;
  mode: Mode;
  metrics: Record<string, number>;
  /** Non-numeric context the model may mention but must not treat as a number. */
  facts: {
    protonTier: string | null;
    playtimeSource: PlaytimeEstimate["source"];
    playtimeNote: string | null;
    hasAchievements: boolean;
    dataGaps: string[];
  };
};

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * When a game has no completionist figure, estimate it from the main-story
 * time. The multiplier is an explicit assumption, surfaced as a data gap so
 * the model can flag the estimate as approximate.
 */
const COMPLETIONIST_MULTIPLIER = 2.5;

function meanRarityOfUnearned(
  achievements: AchievementProgress | null | undefined,
  rarity: Record<string, number> | null | undefined,
): number | null {
  if (!achievements?.hasAchievements || !rarity) return null;

  const values = achievements.unearned
    .map((apiname) => rarity[apiname])
    .filter((value): value is number => typeof value === "number");

  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function scoreGame(input: ScoreInput, mode: Mode): ScoredGame {
  const { achievements, playtime, proton, rarity } = input;
  const metrics: Record<string, number> = { hoursPlayed: input.hoursPlayed };
  const dataGaps: string[] = [];

  const hasAchievements = achievements?.hasAchievements ?? false;
  // A game with no achievements can never be scored as a completionist, so it
  // is routed to beat-once regardless of the requested mode.
  const effectiveMode: Mode = hasAchievements ? mode : "beat-once";

  if (hasAchievements && achievements) {
    metrics.achievementPercent = achievements.percent ?? 0;
    metrics.achievementsEarned = achievements.earned;
    metrics.achievementsTotal = achievements.total;
  } else {
    dataGaps.push(
      "This game has no Steam achievements, so it is scored on story completion only.",
    );
  }

  const hoursToBeat = playtime?.hoursToBeat ?? null;
  const hoursTo100 = playtime?.hoursTo100 ?? null;

  if (hoursToBeat !== null) metrics.hoursToBeat = hoursToBeat;
  if (hoursTo100 !== null) metrics.hoursTo100 = hoursTo100;

  let fullCompletionHours = hoursTo100;
  if (fullCompletionHours === null && hoursToBeat !== null) {
    fullCompletionHours = round(hoursToBeat * COMPLETIONIST_MULTIPLIER);
    dataGaps.push(
      `No completionist time available; estimated as ${COMPLETIONIST_MULTIPLIER}x the ${hoursToBeat}h main story.`,
    );
  }
  if (playtime?.source === "none") {
    dataGaps.push("No hours-to-beat data found for this game.");
  }
  if (playtime?.note) {
    dataGaps.push(playtime.note);
  }

  // Progress: achievement percentage when we have it, otherwise playtime
  // measured against the main-story time.
  let progressPercent: number | null = null;
  if (
    effectiveMode === "completionist" &&
    achievements?.percent !== null &&
    achievements?.percent !== undefined
  ) {
    progressPercent = achievements.percent;
  } else if (hoursToBeat !== null && hoursToBeat > 0) {
    progressPercent = round(Math.min(100, (input.hoursPlayed / hoursToBeat) * 100));
    metrics.storyProgressPercent = progressPercent;
  }

  let estHoursRemaining: number | null = null;
  if (
    effectiveMode === "completionist" &&
    fullCompletionHours !== null &&
    progressPercent !== null
  ) {
    estHoursRemaining = round(
      Math.max(0, fullCompletionHours * ((100 - progressPercent) / 100)),
    );
  } else if (hoursToBeat !== null) {
    estHoursRemaining = round(Math.max(0, hoursToBeat - input.hoursPlayed));
  }
  if (estHoursRemaining !== null) metrics.estHoursRemaining = estHoursRemaining;

  const avgRarityUnearned = meanRarityOfUnearned(achievements, rarity);
  if (avgRarityUnearned !== null) metrics.avgRarityUnearned = avgRarityUnearned;

  const overinvestment =
    hoursToBeat !== null && hoursToBeat > 0
      ? round(input.hoursPlayed / hoursToBeat)
      : null;
  if (overinvestment !== null) metrics.overinvestmentRatio = overinvestment;

  const rarityWall = avgRarityUnearned !== null && avgRarityUnearned < 10;

  // --- Category assignment: first match wins, fully deterministic. ---
  let category: Category;

  if (proton?.tier?.toLowerCase() === "borked") {
    category = "proton-blocked";
  } else if (input.hoursPlayed === 0) {
    category = "never-started";
  } else if (
    progressPercent !== null &&
    progressPercent >= 60 &&
    estHoursRemaining !== null &&
    estHoursRemaining <= 5 &&
    !rarityWall
  ) {
    category = "finish-line";
  } else if (
    effectiveMode === "completionist" &&
    fullCompletionHours !== null &&
    fullCompletionHours <= 8 &&
    !rarityWall
  ) {
    category = "quick-win";
  } else if (rarityWall) {
    category = "rarity-wall-ahead";
  } else if (estHoursRemaining !== null && estHoursRemaining > 30) {
    category = "long-haul";
  } else {
    category = "keep-going";
  }

  return {
    appid: input.appid,
    name: input.name,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    mode: effectiveMode,
    metrics,
    facts: {
      protonTier: proton?.tier ?? null,
      playtimeSource: playtime?.source ?? "none",
      playtimeNote: playtime?.note ?? null,
      hasAchievements,
      dataGaps,
    },
  };
}

const CATEGORY_RANK: Record<Category, number> = {
  "finish-line": 0,
  "quick-win": 1,
  "keep-going": 2,
  "rarity-wall-ahead": 3,
  "long-haul": 4,
  "never-started": 5,
  "proton-blocked": 6,
};

/** Best candidates first: category, then least work remaining. */
export function rankGames(games: ScoredGame[]): ScoredGame[] {
  return [...games].sort((a, b) => {
    const byCategory = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (byCategory !== 0) return byCategory;

    const aRemaining = a.metrics.estHoursRemaining ?? Number.POSITIVE_INFINITY;
    const bRemaining = b.metrics.estHoursRemaining ?? Number.POSITIVE_INFINITY;
    if (aRemaining !== bRemaining) return aRemaining - bRemaining;

    return (b.metrics.achievementPercent ?? 0) - (a.metrics.achievementPercent ?? 0);
  });
}

/**
 * Anti-waffle check: every number in a written reason must be a number the
 * scorer actually produced. Returns the offending values so the caller can
 * reject the sentence instead of surfacing an invented statistic.
 */
export function findUngroundedNumbers(
  reason: string,
  metrics: Record<string, number>,
): string[] {
  const allowed = new Set(
    Object.values(metrics).flatMap((value) => [
      String(value),
      String(Math.round(value)),
    ]),
  );

  return [...reason.matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => match[0])
    .filter((value) => !allowed.has(value));
}

/** Deterministic sentence used when the model has nothing trustworthy to add. */
export function templateReason(game: ScoredGame): string {
  const parts: string[] = [];
  const { metrics } = game;

  if (metrics.achievementPercent !== undefined) {
    parts.push(`${metrics.achievementPercent}% achievements`);
  }
  if (metrics.estHoursRemaining !== undefined) {
    parts.push(`~${metrics.estHoursRemaining}h left`);
  }
  if (metrics.avgRarityUnearned !== undefined) {
    parts.push(
      `remaining achievements average ${metrics.avgRarityUnearned}% global unlock`,
    );
  }
  if (parts.length === 0) {
    parts.push(`${metrics.hoursPlayed}h played`);
  }

  return `${game.categoryLabel}: ${parts.join(", ")}.`;
}
