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

/**
 * Effort weights for a single achievement, from its global unlock rate.
 *
 * There is no source anywhere that publishes how long an individual
 * achievement takes — I checked Steam's own Web API, SteamHunters,
 * TrueSteamAchievements, AStats, Exophase and completionist.me. Steam publishes
 * unlock RATES and nothing else, SteamHunters' own documentation states plainly
 * that rarity is not difficulty, and TrueSteamAchievements has no API at all
 * (and blocks automated requests). So this does not attempt to know the real
 * figure.
 *
 * What it does instead is allocate a total we DO know — HowLongToBeat's
 * completionist time for the whole game — across the achievements in
 * proportion to how scarce each one is. That is still a model, but every input
 * is published data rather than an invented constant.
 *
 * Two weightings are used deliberately, because the right curve is unknowable:
 *   - `gentle` (-ln p)    treats a 1%-unlock achievement as ~6.6x an average one
 *   - `steep`  (p^-1.5)  treats it as ~350x

 * The steep exponent was 1 (a plain 1/p) and was widened after comparing both
 * against real games: it put Hollow Knight's last achievement — unlocked by
 * 5.3% of players, and one of the hardest in the game — at no more than 3.1h,
 * and Sifu's remaining three at 1.8% at no more than 3.8h. Those upper bounds
 * were not credible. 1.5 sits between logarithmic and inverse-square; -2 was
 * rejected as too aggressive, since it handed 4 of Neon White's 63
 * achievements 67% of the game's entire completionist time.
 * They bracket the plausible range, and the SPREAD between them is the honest
 * signal: wide spread means "we really don't know". Reporting one number here
 * would assert precision the data cannot support.
 */
const RARITY_FLOOR_PERCENT = 0.1;

function effortWeights(percent: number): { gentle: number; steep: number } {
  // Clamped: Steam reports 0% for achievements nobody has unlocked, which would
  // divide by zero and make one achievement swamp the entire allocation.
  const p = Math.min(100, Math.max(RARITY_FLOOR_PERCENT, percent));
  return { gentle: -Math.log(p / 100), steep: Math.pow(p, -1.5) };
}

/**
 * Hours remaining, allocated by scarcity rather than by a flat percentage.
 *
 * Returns null when the rarity map does not cover enough of the achievement
 * list to be meaningful — in that case the caller keeps the linear estimate
 * rather than inventing one.
 */
function scarcityWeightedRemaining(
  achievements: AchievementProgress | null | undefined,
  rarity: Record<string, number> | null | undefined,
  fullCompletionHours: number | null,
): { low: number; high: number } | null {
  if (!achievements?.hasAchievements || !rarity || fullCompletionHours === null) return null;

  const all = Object.entries(rarity).filter(([, v]) => typeof v === "number");
  if (all.length === 0) return null;

  // The allocation is a SHARE of the whole game's effort, so it is only
  // meaningful if the rarity map actually describes the whole game. A partial
  // map — one covering only the achievements still outstanding, say — would
  // make those look like 100% of the work and hand over the entire completionist
  // time. Steam returns every achievement, so this should not happen; it is
  // guarded because being wrong here means confidently overstating.
  if (achievements.total > 0 && all.length < achievements.total * 0.5) return null;

  // The rarity map covers every achievement in the game; `unearned` is the
  // subset this player still has to do.
  const unearned = new Set(achievements.unearned);
  let totalGentle = 0;
  let totalSteep = 0;
  let leftGentle = 0;
  let leftSteep = 0;
  let matched = 0;

  for (const [apiname, percent] of all) {
    const w = effortWeights(percent);
    totalGentle += w.gentle;
    totalSteep += w.steep;
    if (unearned.has(apiname)) {
      matched += 1;
      leftGentle += w.gentle;
      leftSteep += w.steep;
    }
  }

  // If the rarity map missed most of what is unearned, the allocation would be
  // badly skewed low. Better to fall back than to under-report confidently.
  if (matched === 0 || matched < achievements.unearned.length * 0.5) return null;
  if (totalGentle <= 0 || totalSteep <= 0) return null;

  const gentle = round(fullCompletionHours * (leftGentle / totalGentle));
  const steep = round(fullCompletionHours * (leftSteep / totalSteep));

  return { low: Math.min(gentle, steep), high: Math.max(gentle, steep) };
}

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
  // playtime.note carries its own "No HowLongToBeat data found" message for the
  // same condition, which rendered as two caveats saying one thing. Only the
  // note is skipped — a note about an inexact title match is still worth it.
  else if (playtime?.note) {
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

  /*
   * When the linear figure is known not to hold, try to replace it with
   * something better rather than showing nothing. Suppressing it entirely was
   * correct in the sense that the number was wrong, but it left ~45% of a real
   * library with no time estimate at all, which is the single figure players
   * most want.
   *
   * The range below is not a second opinion on the same guess — it reallocates
   * the same known completionist total by how scarce each remaining
   * achievement is. Where the linear estimate says "5% of the achievements are
   * left so 5% of the time is left", this says "the achievements left are the
   * ones almost nobody unlocks, so they are worth much more than 5% of it".
   */
  const scarcityRange = remainingIsFloor
    ? scarcityWeightedRemaining(achievements, rarity, fullCompletionHours)
    : null;

  if (scarcityRange) {
    metrics.estHoursRemainingLow = scarcityRange.low;
    metrics.estHoursRemainingHigh = scarcityRange.high;
  }

  if (remainingIsFloor && scarcityRange) {
    const left = metrics.achievementsLeft;
    // Deliberately quotes the RANGE and not the linear figure: the range is
    // the defensible number here, and naming the linear one would re-introduce
    // exactly the "about an hour" impression the range exists to correct.
    dataGaps.push(
      // Deliberately terse. This fires on most cards in a typical answer, and
      // the card already shows the range and the unlock rate right above it —
      // a long paragraph repeating them turned every card into a wall of text.
      left !== undefined
        ? `${left} rare achievement${left === 1 ? "" : "s"} left, so this is a range rather than a figure.`
        : "The achievements left are rare, so this is a range rather than a figure.",
    );
  } else if (remainingIsFloor && estHoursRemaining !== null) {
    const left = metrics.achievementsLeft;
    // State the facts rather than a stock adverb. How much longer it takes is
    // genuinely unknown — the rarity is the checkable part, so lead with it.
    //
    // Deliberately does NOT name the hours figure. An earlier version said
    // "the 1.1h figure assumes average difficulty and does not hold", which
    // undid the whole point: dataGaps are forwarded to the model as `caveats`,
    // so quoting the number here handed back the very value quotableMetrics
    // strips — and printed it on the card directly beneath the line that
    // replaced it. A disclaimed number is still a number the reader takes away.
    dataGaps.push(
      left !== undefined
        ? `Time remaining is unknown. ${left} achievement${left === 1 ? "" : "s"} left, unlocked by ${avgRarityUnearned}% of players — far rarer than average, so an hours estimate based on average difficulty would understate it.`
        : `Time remaining is unknown: the achievements left are unlocked by ${avgRarityUnearned}% of players, so any hours estimate based on average difficulty would understate it.`,
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

  if (input.hoursPlayed === 0) {
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
};

/** Best candidates first: category, then least work remaining. */
export function rankGames(games: ScoredGame[]): ScoredGame[] {
  return [...games].sort((a, b) => {
    const byCategory = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (byCategory !== 0) return byCategory;

    // quotableMetrics, not raw metrics: for a rarity-walled game
    // estHoursRemaining is the linear figure this file spends forty lines
    // explaining is understated, and ranking "least work first" by it put the
    // most misleadingly-cheap-looking games at the top of their tier. The
    // scarcity range is the honest ordering signal where one exists.
    const workLeft = (game: ScoredGame) =>
      game.metrics.estHoursRemainingLow ??
      quotableMetrics(game).estHoursRemaining ??
      Number.POSITIVE_INFINITY;

    const aRemaining = workLeft(a);
    const bRemaining = workLeft(b);
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

/**
 * Words that identify WHICH metric a claim is about. Unit alone is not enough:
 * achievementsEarned, achievementsTotal and achievementsLeft all carry the unit
 * "achievements", so a shared value/unit allow-list accepted "90 achievements
 * left" when 90 was the number EARNED and only 10 were left. Same for "%",
 * where the completion percentage and the rarity percentage collide — "4% done"
 * passed while 4 was the global unlock rate and the player was 90% done.
 *
 * A claim near one of these words is checked against that metric specifically.
 * Claims with no such word fall back to the unit check, so ordinary phrasing
 * ("you're at 90%") is not rejected for lacking a keyword.
 */
const METRIC_CONTEXT: { pattern: RegExp; keys: string[] }[] = [
  { pattern: /\b(left|remaining|to go|outstanding)\b/i, keys: ["achievementsLeft"] },
  { pattern: /\b(earned|unlocked already|you have)\b/i, keys: ["achievementsEarned"] },
  { pattern: /\b(in total|total of|altogether)\b/i, keys: ["achievementsTotal"] },
  { pattern: /\b(done|complete|completed|through)\b/i, keys: ["achievementPercent", "storyProgressPercent"] },
  { pattern: /\b(unlock|rarity|rare|players|globally)\b/i, keys: ["avgRarityUnearned"] },
];

/**
 * How much text AFTER a number counts as its context, and only after: the
 * qualifying word essentially always follows the figure ("90% done", "10
 * achievements left", "4% unlock rate"). Looking backwards as well caught
 * unrelated words from earlier in the sentence — the category label alone was
 * enough, with "Rarity Wall Ahead: 90% achievements" binding the 90 to the
 * rarity metric and rejecting templateReason's own output. Kept short for the
 * same reason: wide enough for a trailing word, too narrow to reach the next
 * clause.
 */
const CONTEXT_WINDOW = 14;

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
  /** metric key -> every value that key legitimately holds across the shortlist. */
  const byMetric = new Map<string, Set<number>>();

  for (const game of all) {
    for (const [key, value] of Object.entries(game)) {
      const unit = unitFor(key);
      if (unit === null) continue;

      // Accept the exact value and the way a writer naturally shortens it.
      // Only rounding, deliberately: allowing floor and ceil too let "2h"
      // pass for a real figure of 1.1h, which is the exact kind of inflated
      // claim this check exists to catch.
      const forms = [value, Math.round(value)];
      for (const form of forms) allowed.add(`${form}${unit}`);

      const seen = byMetric.get(key) ?? new Set<number>();
      for (const form of forms) seen.add(form);
      byMetric.set(key, seen);
    }
  }

  /**
   * True when the surrounding words name a specific metric AND the claimed
   * number is not one that metric holds. Deliberately one-directional: it only
   * ever rejects, and only when the text is explicit about what it is
   * describing, so unlabelled phrasing keeps working.
   */
  const contradictsItsContext = (
    value: number,
    index: number,
    unit: Unit,
    raw: string,
  ): boolean => {
    const window = reason.slice(index, index + raw.length + CONTEXT_WINDOW).toLowerCase();

    for (const { pattern, keys } of METRIC_CONTEXT) {
      if (!pattern.test(window)) continue;

      // Unit-aware, or "left" would bind "3 to 7 hours left" to
      // achievementsLeft and reject a perfectly good hours range.
      const known = keys.filter((key) => byMetric.has(key) && unitFor(key) === unit);
      if (known.length === 0) continue;
      // Grounded if it matches any metric this context could refer to.
      if (known.some((key) => byMetric.get(key)!.has(value))) continue;
      return true;
    }
    return false;
  };

  const claims = [
    ...reason.matchAll(
      // Ranges first ("3-7 hours", "3 to 7h"), so the lower bound is checked
      // too — matching only the number adjacent to the unit let a fabricated
      // lower bound ride along beside a real upper one.
      /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*(%|hours?\b|hrs?\b|h\b|achievements?\b)/gi,
    ),
  ].flatMap((match) => {
    const unit = canonicalUnit(match[3]);
    return [match[1], match[2]].map((number) => ({
      raw: `${number}${unit}`,
      value: Number(number),
      key: `${number}${unit}`,
      unit,
      index: match.index ?? 0,
    }));
  });

  const seenSpans = new Set(claims.map((claim) => claim.index));

  for (const match of reason.matchAll(
    /(\d+(?:\.\d+)?)\s*(%|hours?\b|hrs?\b|h\b|achievements?\b)/gi,
  )) {
    const index = match.index ?? 0;
    // Skip numbers already covered as part of a range span above.
    if ([...seenSpans].some((start) => index >= start && index - start < 24)) continue;
    claims.push({
      raw: match[0],
      value: Number(match[1]),
      key: `${match[1]}${canonicalUnit(match[2])}`,
      unit: canonicalUnit(match[2]),
      index,
    });
  }

  return claims
    .filter(
      (claim) =>
        !allowed.has(claim.key) ||
        contradictsItsContext(claim.value, claim.index, claim.unit, claim.raw),
    )
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
  if (
    metrics.estHoursRemainingLow !== undefined &&
    metrics.estHoursRemainingHigh !== undefined
  ) {
    // Both bounds carry an explicit unit so findUngroundedNumbers validates
    // each of them — "3h–7h" would leave the lower bound unchecked.
    parts.push(
      `roughly ${metrics.estHoursRemainingLow}h to ${metrics.estHoursRemainingHigh}h left`,
    );
  } else if (game.facts.remainingIsFloor && metrics.achievementsLeft !== undefined) {
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

  // The NAME first, always. This sentence replaces the model's prose whenever
  // that prose cannot be verified, and it is sometimes the only sentence the
  // player gets. Without the name it read as "Rarity Wall Ahead: 98.4%
  // achievements, roughly 2h to 4.3h left" - a verdict and three figures
  // belonging to no game in particular, in answer to "what should I finish".
  //
  // Safe for findUngroundedNumbers: it ignores bare digits precisely because
  // most of them in this domain are titles ("Portal 2", "Left 4 Dead 2"), so a
  // name cannot be mistaken for an unsupported claim.
  return `${game.name}: ${game.categoryLabel}, ${parts.join(", ")}.`;
}
