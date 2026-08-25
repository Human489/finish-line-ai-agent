/**
 * Times the data layer end to end, without the model, so slow turns can be
 * attributed to Steam, HowLongToBeat, or the LLM rather than guessed at.
 *
 *   npx tsx scripts/time-sweep.ts [vanityOrSteamId]
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

import { pooled } from "../agent/lib/cache";
import { getPlaytimeEstimate } from "../agent/lib/playtime";
import {
  getAchievementProgress,
  getGlobalRarity,
  getOwnedGames,
  getProtonRating,
  resolveSteamId,
} from "../agent/lib/steam";

/** Any public profile. Pass one as an argument or set SMOKE_STEAM_PROFILE. */
const target =
  process.argv[2] ?? process.env.SMOKE_STEAM_PROFILE ?? "gabelogannewell";

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const value = await fn();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return value;
}

async function main() {
  const profile = await time("resolve", () => resolveSteamId(target));
  const library = await time("get_library", () => getOwnedGames(profile.steamId));

  const played = library.filter((g) => g.hoursPlayed > 0);
  console.log(`   ${library.length} games, ${played.length} played\n`);

  const progress = await time(`sweep_achievements (${played.length} games, 10 concurrent)`, () =>
    pooled(played, 10, (game) => getAchievementProgress(profile.steamId, game.appid)),
  );

  const candidates = played
    .map((game, i) => ({ game, progress: progress[i] }))
    .filter((e) => e.progress.hasAchievements && (e.progress.percent ?? 0) < 100)
    .sort((a, b) => (b.progress.percent ?? 0) - (a.progress.percent ?? 0))
    .slice(0, 20);

  console.log(`   ${candidates.length} shortlisted for scoring\n`);

  // Each enrichment source timed separately, so the slow one is obvious.
  await time("  rarity x20 (keyless)", () =>
    pooled(candidates, 5, (c) => getGlobalRarity(c.game.appid)),
  );
  await time("  protondb x20 (keyless)", () =>
    pooled(candidates, 5, (c) => getProtonRating(c.game.appid)),
  );
  const hltb = await time("  howlongtobeat x20", () =>
    pooled(candidates, 5, (c) => getPlaytimeEstimate(c.game.name)),
  );

  const missed = hltb.filter((h) => h.source === "none").length;
  const fuzzy = hltb.filter((h) => h.note !== null).length;
  console.log(`\nHLTB: ${hltb.length - missed}/${hltb.length} matched, ${fuzzy} inexact`);

  console.log("\nTop candidates:");
  for (let i = 0; i < Math.min(8, candidates.length); i++) {
    const c = candidates[i];
    const h = hltb[i];
    console.log(
      `  ${c.game.name} — ${c.progress.percent}% (${c.progress.earned}/${c.progress.total}), ` +
        `${c.game.hoursPlayed}h played, 100% takes ${h.hoursTo100 ?? "?"}h` +
        (h.note ? `  [${h.matchedName}]` : ""),
    );
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
