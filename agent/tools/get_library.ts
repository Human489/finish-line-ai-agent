import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { getOwnedGames, type OwnedGame } from "../lib/steam";

/**
 * One keyed call returns the entire library with names and playtime, so this
 * is cheap regardless of library size. The full list is cached and only a
 * compact summary is returned — dumping 500 games into the model context would
 * waste the window without improving the answer.
 */
export default defineTool({
  description:
    "Fetch the complete Steam library for a SteamID64 in a single call: every owned game with its name and hours played. Returns counts and the most-played games; the full list is held for the other tools.",
  inputSchema: z.object({
    steamId: z.string().regex(/^\d{17}$/).describe("A 17-digit SteamID64."),
  }),
  /** Counts are all the model needs; the sweep supplies the actual candidates. */
  toModelOutput(output: {
    totalGames: number;
    playedGames: number;
    neverStartedGames: number;
    totalHoursPlayed: number;
  }) {
    return {
      type: "text" as const,
      value:
        `Library: ${output.totalGames} games, ${output.playedGames} played, ` +
        `${output.neverStartedGames} never started, ${output.totalHoursPlayed}h total. ` +
        `Call sweep_achievements next.`,
    };
  },
  async execute({ steamId }, ctx) {
    const games = await getOwnedGames(steamId);
    const cache = cacheFor(ctx.session.id);
    cache.library = games;
    cache.steamId = steamId;

    const played = games.filter((game) => game.hoursPlayed > 0);
    const neverStarted = games.filter((game) => game.hoursPlayed === 0);

    const totalHours =
      Math.round(games.reduce((sum, game) => sum + game.hoursPlayed, 0) * 10) / 10;

    const summarise = (game: OwnedGame) => ({
      appid: game.appid,
      name: game.name,
      hoursPlayed: game.hoursPlayed,
    });

    return {
      steamId,
      totalGames: games.length,
      playedGames: played.length,
      neverStartedGames: neverStarted.length,
      totalHoursPlayed: totalHours,
      mostPlayed: [...played]
        .sort((a, b) => b.hoursPlayed - a.hoursPlayed)
        .slice(0, 15)
        .map(summarise),
      note: "Full library cached for this conversation. Call sweep_achievements next to measure completion across every played game.",
    };
  },
});
