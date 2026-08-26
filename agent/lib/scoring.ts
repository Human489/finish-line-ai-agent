/**
 * Deterministic backlog scoring.
 *
 * Every number the agent is allowed to say comes from here. The model never
 * performs arithmetic and never chooses a category: it receives the computed
 * verdict as a fixed field and may only write a short reason around it.
 */

import type { PlaytimeEstimate } from "./playtime";
import type { AchievementProgress, ProtonRating } from "./steam";
import type { Category } from "./categories";
import { CATEGORY_LABELS, THRESHOLDS } from "./categories";

export type Mode = "completionist" | "beat-once";

// Re-exported so existing importers of scoring.ts keep working; the source
// of truth now lives in categories.ts (see that file's header comment).
export type { Category };
export { CATEGORY_LABELS };

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
    /**
     * True when estHoursRemaining is a lower bound rather than an estimate,
     * because the achievements left are rare enough that linear extrapolation
     * understates the real effort. Must be shown as "at least", never as "~".
     */
    remainingIsFloor: boolean;
    /**
     * True when we could not determine whether this game has achievements at
     * all (a failed/partial Steam lookup), as opposed to a confirmed absence.
     * The UI and dataGaps wording must not claim "no achievements" in this
     * case — that would be a confident false statement about the library.
     */
    achievementsUnknown: boolean;
    dataGaps: string[];
  };
};

const round = (value: number) => Math.round(value * 10) / 10;

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
    // Concrete and checkable — this is what gets shown when the hours figure
    // is known to be unreliable.
    metrics.achievementsLeft = achievements.total - achievements.earned;
  } else if (achievements?.unknown) {
    // Steam did not confirm this either way (network/parse failure, or Steam
    // refused). Saying "no achievements" here would be a confident false
    // statement about the user's library, so the gap must stay honest about
    // the uncertainty instead.
    dataGaps.push(
      "Steam did not return achievement data for this game, so it may have achievements that are not counted here; it is scored on story completion only.",
    );
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
    fullCompletionHours = round(hoursToBeat * THRESHOLDS.COMPLETIONIST_MULTIPLIER);
    dataGaps.push(
      `No completionist time available; estimated as ${THRESHOLDS.COMPLETIONIST_MULTIPLIER}x the ${hoursToBeat}h main story.`,
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

  const avgRarityUnearned = meanRarityOfUnearned(achievements, rarity);
  if (avgRarityUnearned !== null) metrics.avgRarityUnearned = avgRarityUnearned;

  /*
   * Remaining time is extrapolated linearly: if you are 95% of the way through
   * the achievements, this assumes 5% of the completionist time is left.
   *
   * That assumes every remaining achievement costs about what an average one
   * did, which is only true while what is left is commonly unlocked. In a
   * completionist run the last few achievements are usually the hardest by a
   * wide margin, so for a game like Sifu — 95% done, but the remainder unlocked
   * by under 2% of players — linear extrapolation produces a confidently wrong
   * "about an hour" for what is realistically many times that.
   *
   * We cannot know the real figure: no source publishes per-achievement
   * difficulty. So rather than invent a multiplier, the number is treated as a
   * FLOOR whenever the remaining achievements are rare, and labelled as such
   * everywhere it is shown.
   */
  let estHoursRemaining: number | null = null;
  let remainingIsFloor = false;

  if (
    effectiveMode === "completionist" &&
    fullCompletionHours !== null &&
    progressPercent !== null
  ) {
    estHoursRemaining = round(
      Math.max(0, fullCompletionHours * ((100 - progressPercent) / 100)),
    );
    // Below ~10% global unlock, linear extrapolation reliably understates.
    remainingIsFloor =
      avgRarityUnearned !== null && avgRarityUnearned < THRESHOLDS.RARITY_WALL_UNLOCK_CEILING;
  } else if (hoursToBeat !== null) {
    estHoursRemaining = round(Math.max(0, hoursToBeat - input.hoursPlayed));
  }

  if (estHoursRemaining !== null) metrics.estHoursRemaining = estHoursRemaining;

  if (remainingIsFloor && estHoursRemaining !== null) {
    const left = metrics.achievementsLeft;
    // State the facts rather than a stock adverb. How much longer it takes is
    // genuinely unknown — the rarity is the checkable part, so lead with it.
    dataGaps.push(
      left !== undefined
        ? `Time remaining is unknown. ${left} achievement${left === 1 ? "" : "s"} left, unlocked by ${avgRarityUnearned}% of players; the ${estHoursRemaining}h figure assumes average difficulty and does not hold for achievements this rare.`
        : `Time remaining is unknown: the achievements left are unlocked by ${avgRarityUnearned}% of players, so the ${estHoursRemaining}h figure does not hold.`,
    );
  }

  const overinvestment =
    hoursToBeat !== null && hoursToBeat > 0
      ? round(input.hoursPlayed / hoursToBeat)
      : null;
  if (overinvestment !== null) metrics.overinvestmentRatio = overinvestment;

  // Rarity wall only applies in completionist mode: in beat-once the player
  // is measured against story progress, so achievement rarity is not part of
  // the question being asked. Without this gate, a user who only asked "what
  // can I beat this weekend" could have a game pushed into Rarity Wall Ahead
  // over achievements they never said they cared about — the same
  // avgRarityUnearned < threshold test that (correctly) already gates
  // remainingIsFloor above, just not applied consistently until now.
  const rarityWall =
    effectiveMode === "completionist" &&
    avgRarityUnearned !== null &&
    avgRarityUnearned < THRESHOLDS.RARITY_WALL_UNLOCK_CEILING;

  // --- Category assignment: first match wins, fully deterministic. ---
  let category: Category;

  if (proton?.tier?.toLowerCase() === "borked") {
    category = "proton-blocked";
  } else if (input.hoursPlayed === 0) {
    category = "never-started";
  } else if (
    progressPercent !== null &&
    progressPercent >= THRESHOLDS.FINISH_LINE_PROGRESS_PERCENT &&
    estHoursRemaining !== null &&
    estHoursRemaining <= THRESHOLDS.FINISH_LINE_HOURS_CEILING &&
    !rarityWall
  ) {
    category = "finish-line";
  } else if (
    effectiveMode === "completionist" &&
    fullCompletionHours !== null &&
    fullCompletionHours <= THRESHOLDS.QUICK_WIN_HOURS_CEILING &&
    !rarityWall
  ) {
    category = "quick-win";
  } else if (
    // Beat-once arm: the "Quick Win" legend promises "completable in eight
    // hours or less" with no achievement caveat, so a game with no (or
    // unknown) achievements must be able to qualify too — judged on the
    // hours needed to beat it rather than a completionist figure that does
    // not apply in this mode. (rarityWall is always false here after the
    // gate above, so the guard is kept only for symmetry with the branch
    // above and to stay robust if that ever changes.)
    effectiveMode === "beat-once" &&
    hoursToBeat !== null &&
    hoursToBeat <= THRESHOLDS.QUICK_WIN_HOURS_CEILING &&
    !rarityWall
  ) {
    category = "quick-win";
  } else if (rarityWall) {
    category = "rarity-wall-ahead";
  } else if (estHoursRemaining !== null && estHoursRemaining > THRESHOLDS.LONG_HAUL_HOURS_FLOOR) {
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
      remainingIsFloor,
      achievementsUnknown: achievements?.unknown ?? false,
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
 * Anti-waffle check: every statistic in a written reason must be one the
 * scorer actually produced. Returns the offending claims so the caller can
 * fall back to `templateReason` instead of surfacing an invented figure.
 *
 * Only numbers that carry a UNIT are checked ("92.1%", "5h", "3 achievements").
 * A bare digit run is deliberately ignored, because in this domain most bare
 * digits are not claims at all — they are game titles ("Portal 2",
 * "Half-Life 2"), counts of the model's own picks ("the other 3"), or
 * ordinals. The previous version matched every digit in the sentence, so it
 * flagged "Portal 2" as an invented statistic and would have rejected a
 * perfectly good answer.
 *
 * Checking the unit as well as the value also catches a failure the value
 * alone cannot: if `achievementPercent` is 73 and the model writes "73 hours
 * left", the digits are grounded but the claim is nonsense. That now fails.
 */

/** Which unit a metric is allowed to be quoted in, keyed by metric name. */
function unitFor(metricKey: string): Unit | null {
  const key = metricKey.toLowerCase();
  if (key.includes("percent") || key.includes("rarity")) return "%";
  if (key.includes("hours")) return "h";
  if (key.includes("achievements")) return "achievements";
  // Ratios and raw counts have no unit the model can attach, so there is
  // nothing to validate against.
  return null;
}

type Unit = "%" | "h" | "achievements";

/** Normalises the unit as written into the canonical form used above. */
function canonicalUnit(written: string): Unit {
  const unit = written.toLowerCase();
  if (unit === "%") return "%";
  if (unit.startsWith("achievement")) return "achievements";
  return "h";
}

export function findUngroundedNumbers(
  reason: string,
  metrics: Record<string, number> | Record<string, number>[],
): string[] {
  // The model writes ONE comparative sentence across the whole shortlist
  // ("Sifu beats Terraria's 33h"), so a number is grounded if it belongs to
  // any scored game, not just the top one. Checking per-game in isolation
  // would flag every legitimate comparison.
  const all = Array.isArray(metrics) ? metrics : [metrics];

  const allowed = new Set<string>();
  for (const game of all) {
    for (const [key, value] of Object.entries(game)) {
      const unit = unitFor(key);
      if (unit === null) continue;

      // Accept the exact value and the way a writer naturally shortens it.
      // Only rounding, deliberately: allowing floor and ceil too let "2h"
      // pass for a real figure of 1.1h, which is the exact kind of inflated
      // claim this check exists to catch.
      for (const form of [value, Math.round(value)]) {
        allowed.add(`${form}${unit}`);
      }
    }
  }

  const claims = reason.matchAll(
    /(\d+(?:\.\d+)?)\s*(%|hours?\b|hrs?\b|h\b|achievements?\b)/gi,
  );

  return [...claims]
    .map((match) => ({ raw: match[0], key: `${match[1]}${canonicalUnit(match[2])}` }))
    .filter((claim) => !allowed.has(claim.key))
    .map((claim) => claim.raw);
}

/**
 * The metrics a game may legitimately be quoted with.
 *
 * This is NOT the same as `game.metrics`. When `remainingIsFloor` is set, the
 * hours figure is known not to hold and is withheld from the model entirely —
 * so it must also be withheld from the grounding check, or the check would
 * accept the very number the suppression exists to keep off the screen. A
 * model that produced "about 1.1 hours" for a rarity-walled game would be
 * quoting a real value from `metrics` and would pass, which defeats the point.
 *
 * Both `toModelOutput` and the render-time guard project through here so the
 * two can never disagree about what is quotable.
 */
export function quotableMetrics(game: {
  metrics: Record<string, number>;
  facts: { remainingIsFloor?: boolean };
}): Record<string, number> {
  if (!game.facts.remainingIsFloor) return game.metrics;
  const quotable = { ...game.metrics };
  delete quotable.estHoursRemaining;
  return quotable;
}

/** Deterministic sentence used when the model has nothing trustworthy to add. */
export function templateReason(game: ScoredGame): string {
  const parts: string[] = [];
  const { metrics } = game;

  if (metrics.achievementPercent !== undefined) {
    parts.push(`${metrics.achievementPercent}% achievements`);
  }
  if (game.facts.remainingIsFloor && metrics.achievementsLeft !== undefined) {
    // Deliberately no hours figure: it is known not to hold here.
    const left = metrics.achievementsLeft;
    parts.push(`${left} rare achievement${left === 1 ? "" : "s"} left`);
  } else if (metrics.estHoursRemaining !== undefined) {
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
