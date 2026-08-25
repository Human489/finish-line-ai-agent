import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor, pooled } from "../lib/cache";
import {
  getAchievementProgress,
  getOwnedGames,
  type AchievementProgress,
  type OwnedGame,
} from "../lib/steam";

const CONCURRENCY = 10;

/**
 * Achievement data has no batch endpoint, so this is one keyed call per played
 * game. That is cheap against the 100k/day quota but must be paced to avoid
 * burst throttling, hence the bounded pool.
 *
 * Games with zero playtime are skipped entirely: no playtime means no
 * achievements, so they cost nothing to categorise.
 *
 * Runs once per conversation and is cached, so follow-up questions are instant.
 */
export default defineTool({
  description:
    "Measure achievement completion across every played game in the library. This is the accurate, full sweep — it takes a while on a large library but only runs once per conversation. Call it after get_library.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
  }),
  /**
   * The UI wants the streaming snapshots and the full candidate list; the model
   * only needs the shortlist it will pass to score_backlog. Sending it the whole
   * object makes every subsequent step of the loop slower and dearer.
   */
  toModelOutput(output: {
    completed: number;
    total: number;
    summary: {
      playedGames: number;
      neverStartedGames: number;
      gamesWithAchievements: number;
      alreadyPerfected: number;
      candidates: { appid: number; name: string; achievementPercent: number | null }[];
    } | null;
  }) {
    if (!output.summary) {
      return {
        type: "text" as const,
        value: `Sweeping achievements: ${output.completed}/${output.total} games.`,
      };
    }

    const { summary } = output;
    return {
      type: "json" as const,
      value: {
        playedGames: summary.playedGames,
        neverStartedGames: summary.neverStartedGames,
        gamesWithAchievements: summary.gamesWithAchievements,
        alreadyPerfected: summary.alreadyPerfected,
        // Name, appid and completion only — enough to choose a shortlist.
        candidates: summary.candidates.slice(0, 20).map((game) => ({
          appid: game.appid,
          name: game.name,
          percent: game.achievementPercent,
        })),
        note: "Unfinished games, most complete first. Pass the appids you care about to score_backlog in ONE call. Do not sweep again.",
      },
    };
  },
  async *execute({ steamId }, ctx) {
    const cache = cacheFor(ctx.session.id);

    let library = cache.library as OwnedGame[] | undefined;
    if (!library) {
      library = await getOwnedGames(steamId);
      cache.library = library;
    }

    const played = library.filter((game) => game.hoursPlayed > 0);
    const neverStarted = library.length - played.length;

    yield {
      phase: "sweeping" as const,
      completed: 0,
      total: played.length,
      recent: [] as { name: string; percent: number | null }[],
      summary: null,
    };

    const recent: { name: string; percent: number | null }[] = [];
    let completed = 0;

    const results = await pooled(played, CONCURRENCY, async (game) => {
      const cached = cache.achievements.get(game.appid) as
        | AchievementProgress
        | undefined;
      const progress = cached ?? (await getAchievementProgress(steamId, game.appid));
      cache.achievements.set(game.appid, progress);

      completed += 1;
      if (progress.hasAchievements) {
        recent.unshift({ name: game.name, percent: progress.percent });
        recent.length = Math.min(recent.length, 5);
      }

      return { game, progress };
    });

    // Snapshot after the pool drains. Intermediate yields inside the pool would
    // interleave unpredictably; eve treats snapshots as last-write-wins anyway.
    yield {
      phase: "sweeping" as const,
      completed,
      total: played.length,
      recent: [...recent],
      summary: null,
    };

    const withAchievements = results.filter((entry) => entry.progress.hasAchievements);
    const perfected = withAchievements.filter((entry) => entry.progress.percent === 100);

    const candidates = withAchievements
      .filter((entry) => (entry.progress.percent ?? 0) < 100)
      .sort((a, b) => (b.progress.percent ?? 0) - (a.progress.percent ?? 0))
      .slice(0, 40)
      .map((entry) => ({
        appid: entry.game.appid,
        name: entry.game.name,
        hoursPlayed: entry.game.hoursPlayed,
        achievementPercent: entry.progress.percent,
        earned: entry.progress.earned,
        total: entry.progress.total,
      }));

    yield {
      phase: "complete" as const,
      completed,
      total: played.length,
      recent: [],
      summary: {
        playedGames: played.length,
        neverStartedGames: neverStarted,
        gamesWithAchievements: withAchievements.length,
        gamesWithoutAchievements: played.length - withAchievements.length,
        alreadyPerfected: perfected.length,
        candidates,
        note: "Candidates are unfinished games ranked by achievement completion. Pass the interesting appids to score_backlog for hours-remaining and a verdict.",
      },
    };
  },
});
