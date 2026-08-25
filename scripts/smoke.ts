import { getGlobalRarity, getProtonRating, resolveSteamId } from "../agent/lib/steam";
import { getPlaytimeEstimate } from "../agent/lib/playtime";
import { scoreGame, templateReason, findUngroundedNumbers } from "../agent/lib/scoring";

/**
 * Any public Steam profile works. Pass one as an argument, or set
 * SMOKE_STEAM_PROFILE. Defaults to Gabe Newell's public profile so the script
 * runs out of the box without hardcoding anyone's personal account.
 *
 *   npx tsx scripts/smoke.ts <vanityNameOrSteamID64>
 */
const TARGET =
  process.argv[2] ?? process.env.SMOKE_STEAM_PROFILE ?? "gabelogannewell";

async function main() {
  console.log(`--- resolveSteamId (vanity: ${TARGET}) ---`);
  const profile = await resolveSteamId(TARGET);
  console.log(profile);

  console.log("\n--- resolveSteamId (profile URL) ---");
  console.log(
    await resolveSteamId(`https://steamcommunity.com/id/${TARGET}/`),
  );

  console.log("\n--- ProtonDB (Witcher 3, 292030) ---");
  const proton = await getProtonRating(292030);
  console.log(proton);

  console.log("\n--- Global rarity (Witcher 3) ---");
  const rarity = await getGlobalRarity(292030);
  const rarityKeys = Object.keys(rarity);
  console.log("achievements:", rarityKeys.length, "sample:", rarityKeys.slice(0, 3).map((k) => [k, rarity[k]]));

  console.log("\n--- Playtime: Hollow Knight ---");
  const hk = await getPlaytimeEstimate("Hollow Knight");
  console.log(hk);

  console.log("\n--- Playtime: Celeste ---");
  console.log(await getPlaytimeEstimate("Celeste"));

  console.log("\n--- scoreGame: near-complete game ---");
  const scored = scoreGame(
    {
      appid: 367520,
      name: "Hollow Knight",
      hoursPlayed: 40,
      achievements: {
        appid: 367520,
        hasAchievements: true,
        earned: 58,
        total: 63,
        percent: 92.1,
        unearned: ["A", "B", "C", "D", "E"],
      },
      playtime: hk,
      proton,
      rarity: { A: 30, B: 25, C: 40, D: 22, E: 35 },
    },
    "completionist",
  );
  console.log(JSON.stringify(scored, null, 2));
  console.log("template:", templateReason(scored));

  console.log("\n--- scoreGame: rarity wall ---");
  const wall = scoreGame(
    {
      appid: 367520,
      name: "Grindy Game",
      hoursPlayed: 40,
      achievements: {
        appid: 1,
        hasAchievements: true,
        earned: 58,
        total: 63,
        percent: 92.1,
        unearned: ["A", "B"],
      },
      playtime: hk,
      proton,
      rarity: { A: 0.4, B: 1.2 },
    },
    "completionist",
  );
  console.log(wall.categoryLabel, wall.metrics);

  console.log("\n--- scoreGame: no achievements, never started ---");
  const fresh = scoreGame(
    { appid: 2, name: "Untouched", hoursPlayed: 0, achievements: null, playtime: hk, proton: null, rarity: null },
    "completionist",
  );
  console.log(fresh.categoryLabel, fresh.mode, fresh.facts.dataGaps);

  console.log("\n--- anti-waffle validator ---");
  console.log("grounded  ->", findUngroundedNumbers(`You are ${scored.metrics.achievementPercent}% done.`, scored.metrics));
  console.log("invented  ->", findUngroundedNumbers("You are 47% done with 3 hours left.", scored.metrics));
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
