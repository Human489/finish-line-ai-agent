import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooled } from "../lib/cache";
import { getPlaytimeEstimate, type PlaytimeEstimate } from "../lib/playtime";
import {
  getAchievementProgress,
  getGlobalRarity,
  getOwnedGames,
  getProtonRating,
  type AchievementProgress,
  type OwnedGame,
  type ProtonRating,
} from "../lib/steam";
import {
  rankGames,
  scoreGame,
  templateReason,
  type Mode,
  type ScoredGame,
} from "../lib/scoring";

/**
 * The verdict tool. Enrichment beyond Steam (HowLongToBeat especially) cannot
 * be run across a whole library without getting blocked, so this deliberately
 * operates on a shortlist.
 *
 * The category returned here is final. The model is not permitted to choose,
 * change or soften it — see instructions.md.
 */
const MAX_GAMES = 20;
const CONCURRENCY = 5;

export default defineTool({
  description:
    "Score a shortlist of games and assign each a final category (Finish Line, Quick Win, Rarity Wall Ahead, Keep Going, Never Started, Long Haul, Proton-Blocked). This performs all the arithmetic. The category it returns is the verdict — never recompute or override it. Call this last.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
    appids: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_GAMES)
      .describe(
        `The games to score, at most ${MAX_GAMES}. Pick these from the sweep_achievements candidates.`,
      ),
    mode: z
      .enum(["completionist", "beat-once"])
      .default("completionist")
      .describe(
        "completionist ranks by achievement completion; beat-once ranks by story progress. Games without achievements always use beat-once.",
      ),
  }),
  /**
   * The model gets one flat line of facts per game — everything it is allowed
   * to say, and nothing else. The UI still receives the full scored objects on
   * `action.result`, so nothing is lost from the transcript.
   */
  toModelOutput(output: {
    mode: string;
    scored: (ScoredGame & { fallbackReason: string })[];
    reasonRules: string;
  }) {
    return {
      type: "json" as const,
      value: {
        mode: output.mode,
        // No fallbackReason here: it restates the card, and the model is now
        // told not to. It stays on the full output for the UI contract.
        games: output.scored.map((game) => ({
          name: game.name,
          verdict: game.categoryLabel,
          ...game.metrics,
          proton: game.facts.protonTier,
          caveats: game.facts.dataGaps.length > 0 ? game.facts.dataGaps : undefined,
        })),
        rules: output.reasonRules,
      },
    };
  },
  async execute({ steamId, appids, mode }, ctx) {
    const cache = cacheFor(ctx.session.id);

    let library = cache.library as OwnedGame[] | undefined;
    if (!library) {
      library = await getOwnedGames(steamId);
      cache.library = library;
    }

    const byAppid = new Map(library.map((game) => [game.appid, game]));
    const targets = appids
      .map((appid) => byAppid.get(appid))
      .filter((game): game is OwnedGame => game !== undefined);

    const missing = appids.filter((appid) => !byAppid.has(appid));

    const scored = await pooled(targets, CONCURRENCY, async (game) => {
      const [achievements, rarity, playtime, proton] = await Promise.all([
        (async () => {
          const cached = cache.achievements.get(game.appid) as
            | AchievementProgress
            | undefined;
          if (cached) return cached;
          const fresh = await getAchievementProgress(steamId, game.appid);
          cache.achievements.set(game.appid, fresh);
          return fresh;
        })(),
        (async () => {
          const cached = cache.rarity.get(game.appid) as
            | Record<string, number>
            | undefined;
          if (cached) return cached;
          const fresh = await getGlobalRarity(game.appid);
          cache.rarity.set(game.appid, fresh);
          return fresh;
        })(),
        (async () => {
          const cached = cache.playtime.get(game.name) as PlaytimeEstimate | undefined;
          if (cached) return cached;
          const fresh = await getPlaytimeEstimate(game.name);
          cache.playtime.set(game.name, fresh);
          return fresh;
        })(),
        (async () => {
          const cached = cache.proton.get(game.appid) as ProtonRating | null | undefined;
          if (cached !== undefined) return cached;
          const fresh = await getProtonRating(game.appid);
          cache.proton.set(game.appid, fresh);
          return fresh;
        })(),
      ]);

      return scoreGame(
        {
          appid: game.appid,
          name: game.name,
          hoursPlayed: game.hoursPlayed,
          achievements,
          playtime,
          proton,
          rarity,
        },
        mode as Mode,
      );
    });

    const ranked = rankGames(scored);

    return {
      mode,
      scored: ranked.map((game) => ({
        ...game,
        // The numbers the model is allowed to quote for this game, and a
        // ready-made sentence to fall back on.
        allowedNumbers: Object.values(game.metrics),
        fallbackReason: templateReason(game),
      })),
      unknownAppids: missing,
      reasonRules:
        "Every game below is ALREADY shown to the player as a card with its name, category, numbers and Linux tier. Do not repeat any of that. Write one or two short sentences TOTAL naming your top pick and the single reason it beats the others — not one sentence per game, and no lists or headings. Any number you do mention must be one of that game's own values above. Never change a verdict.",
    };
  },
});
