/**
 * Single source of truth for the seven backlog categories: their labels,
 * their user-facing descriptions, and the numeric thresholds that decide
 * them. Previously these were duplicated across scoring.ts, app/page.tsx and
 * agent/instructions.md, and the drift between copies already caused a live
 * bug (Quick Win's stated definition not matching what scoreGame actually
 * awarded). This file is imported by both server code (scoring.ts) and a
 * "use client" component (app/page.tsx), so it must have ZERO imports and no
 * server-only runtime dependency.
 */

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

/** Exact wording shown in the UI legend (app/page.tsx CATEGORIES). */
export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  "finish-line": "60%+ done, about five hours or less left. The best use of a session.",
  "quick-win": "Completable in eight hours or less.",
  "rarity-wall-ahead":
    "The achievements you have left are ones very few players ever unlock, so the last stretch will be a real grind. A warning, not a reason to give up.",
  "keep-going": "Started, real progress, more to do.",
  "never-started": "Owned, never launched.",
  "long-haul": "More than thirty hours remaining.",
  "proton-blocked":
    'Reported as not working on Linux / Steam Deck (ProtonDB rates it "Borked").',
};

export const THRESHOLDS = {
  /** Minimum progress percent for Finish Line eligibility. */
  FINISH_LINE_PROGRESS_PERCENT: 60,
  /** Maximum estimated hours remaining for Finish Line eligibility. */
  FINISH_LINE_HOURS_CEILING: 5,
  /** Maximum total completion hours (completionist or beat-once, depending on mode) for Quick Win eligibility. */
  QUICK_WIN_HOURS_CEILING: 8,
  /** Minimum estimated hours remaining for a game to be considered Long Haul. */
  LONG_HAUL_HOURS_FLOOR: 30,
  /** Below this global-unlock percentage, remaining achievements are rare enough to trigger a rarity wall. */
  RARITY_WALL_UNLOCK_CEILING: 10,
  /** When no completionist time is published, multiply the main-story hours by this to estimate one. */
  COMPLETIONIST_MULTIPLIER: 2.5,
} as const;
