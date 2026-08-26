/**
 * Assertions over the deterministic half of the app.
 *
 * The other scripts in here are live smoke tests: they hit real APIs and
 * print things for a human to eyeball. This one is different — it touches no
 * network, needs no API key, and either passes silently or exits non-zero.
 * Everything it covers is pure logic, which is exactly the part that must not
 * regress: scoring.ts decides every number and category the model is allowed
 * to say, so a mistake here is invisible in the UI and lands in front of the
 * player as a confident wrong answer.
 *
 *   npx tsx scripts/test-logic.ts
 */

import assert from "node:assert/strict";
import { pooledSettled } from "../agent/lib/cache";
import { CATEGORY_LABELS, THRESHOLDS, type Category } from "../agent/lib/categories";
import type { AchievementProgress } from "../agent/lib/steam";
import type { PlaytimeEstimate } from "../agent/lib/playtime";
import {
  findUngroundedNumbers,
  quotableMetrics,
  scoreGame,
  templateReason,
} from "../agent/lib/scoring";

let failures = 0;
let run = 0;

function test(name: string, body: () => void | Promise<void>): Promise<void> {
  run += 1;
  return (async () => {
    try {
      await body();
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(`      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  })();
}

// --- fixtures -------------------------------------------------------------

const achievements = (over: Partial<AchievementProgress> = {}): AchievementProgress => ({
  appid: 1,
  hasAchievements: true,
  earned: 90,
  total: 100,
  percent: 90,
  unearned: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  unknown: false,
  ...over,
});

const playtime = (over: Partial<PlaytimeEstimate> = {}): PlaytimeEstimate => ({
  hoursToBeat: 10,
  hoursTo100: 20,
  source: "howlongtobeat",
  matchedName: "Test Game",
  note: null,
  ...over,
});

/** Every unearned achievement is globally rare — i.e. a rarity wall. */
const RARE = Object.fromEntries("abcdefghij".split("").map((k) => [k, 1]));
/** Every unearned achievement is common. */
const COMMON = Object.fromEntries("abcdefghij".split("").map((k) => [k, 50]));

const base = { appid: 1, name: "Test Game", hoursPlayed: 5 };

const categoryOf = (...args: Parameters<typeof scoreGame>): Category =>
  scoreGame(...args).category;

async function main() {
  // --- rarity wall is a completionist concern only ------------------------
  // Regression: rarityWall was computed with no mode gate, so a player asking
  // "what can I BEAT this weekend" got games pushed to Rarity Wall Ahead over
  // achievements they never said they cared about.

  await test("rarity wall fires in completionist mode", () => {
    const category = categoryOf(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    assert.equal(category, "rarity-wall-ahead");
  });

  await test("rarity wall never fires in beat-once mode", () => {
    const category = categoryOf(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "beat-once",
    );
    assert.notEqual(category, "rarity-wall-ahead");
  });

  // --- Quick Win must match its own legend --------------------------------
  // Regression: quick-win required completionist mode, but a game without
  // achievements is forced to beat-once, so a short achievement-less game
  // could never earn the category the UI legend promised it.

  await test("short game with no achievements is a Quick Win", () => {
    const category = categoryOf(
      {
        ...base,
        // Barely started: with more hours played than the beat time this is
        // legitimately Finish Line, which is checked first and would mask
        // whether the beat-once Quick Win arm works at all.
        hoursPlayed: 1,
        achievements: achievements({ hasAchievements: false, total: 0, earned: 0, percent: null }),
        playtime: playtime({ hoursToBeat: 4, hoursTo100: null }),
      },
      "completionist",
    );
    assert.equal(category, "quick-win");
  });

  await test("long game with no achievements is not a Quick Win", () => {
    const category = categoryOf(
      {
        ...base,
        achievements: achievements({ hasAchievements: false, total: 0, earned: 0, percent: null }),
        playtime: playtime({ hoursToBeat: 80, hoursTo100: null }),
      },
      "completionist",
    );
    assert.notEqual(category, "quick-win");
  });

  // --- honest failure states ----------------------------------------------
  // Regression: every lookup failure collapsed to hasAchievements:false, so a
  // transient error made the app assert "this game has no Steam achievements".

  await test("unknown achievement data does not claim the game has none", () => {
    const scored = scoreGame(
      {
        ...base,
        achievements: achievements({ hasAchievements: false, unknown: true, total: 0, earned: 0, percent: null }),
        playtime: playtime(),
      },
      "completionist",
    );
    assert.equal(scored.facts.achievementsUnknown, true);
    const gaps = scored.facts.dataGaps.join(" ");
    assert.ok(
      !/has no Steam achievements/i.test(gaps),
      `must not assert absence when unknown; got: ${gaps}`,
    );
  });

  await test("confirmed absence still says so plainly", () => {
    const scored = scoreGame(
      {
        ...base,
        achievements: achievements({ hasAchievements: false, unknown: false, total: 0, earned: 0, percent: null }),
        playtime: playtime(),
      },
      "completionist",
    );
    assert.equal(scored.facts.achievementsUnknown, false);
    assert.ok(/no Steam achievements/i.test(scored.facts.dataGaps.join(" ")));
  });

  // --- the hours floor is suppressed, not softened ------------------------

  await test("rare remainder marks hours as a floor and templateReason omits them", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    assert.equal(scored.facts.remainingIsFloor, true);
    assert.ok(
      !/h\b/.test(templateReason(scored)),
      `templateReason must not quote hours when they are a floor: ${templateReason(scored)}`,
    );
  });

  await test("common remainder keeps the hours figure", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: COMMON },
      "completionist",
    );
    assert.equal(scored.facts.remainingIsFloor, false);
    assert.ok(/h\b/.test(templateReason(scored)));
  });

  // --- fixed categories ----------------------------------------------------

  await test("never-started beats every other category except borked", () => {
    assert.equal(
      categoryOf({ ...base, hoursPlayed: 0, playtime: playtime() }, "completionist"),
      "never-started",
    );
  });

  // Categories describe how much work is left and nothing else. Linux support
  // used to short-circuit the whole chain as its own "Proton-Blocked" verdict,
  // which meant one game could be both nearly finished AND unplayable while
  // only the second fact survived. It is reported as context instead.
  await test("Linux support does not change the category", () => {
    const borked = { tier: "borked", score: null, confidence: null, reports: 3 };
    const input = { ...base, achievements: achievements(), playtime: playtime(), rarity: COMMON };

    const withBorked = scoreGame({ ...input, proton: borked }, "completionist");
    const without = scoreGame(input, "completionist");

    assert.equal(withBorked.category, without.category);
    // ...but the tier must still reach the UI, or the warning is simply lost.
    assert.equal(withBorked.facts.protonTier, "borked");
  });

  await test("a borked game that is never started is still Never Started", () => {
    assert.equal(
      categoryOf(
        {
          ...base,
          hoursPlayed: 0,
          playtime: playtime(),
          proton: { tier: "borked", score: null, confidence: null, reports: 3 },
        },
        "completionist",
      ),
      "never-started",
    );
  });

  await test("every category has a label", () => {
    for (const key of Object.keys(CATEGORY_LABELS) as Category[]) {
      assert.ok(CATEGORY_LABELS[key]?.length > 0, `missing label for ${key}`);
    }
  });

  // --- the grounding checker ----------------------------------------------
  // This is what stands between the player and an invented statistic, so its
  // false-positive behaviour matters as much as its true positives: a false
  // positive discards a correct sentence.

  const sifu = { achievementPercent: 95, estHoursRemaining: 1.1, avgRarityUnearned: 1.8, achievementsLeft: 3 };
  const terraria = { achievementPercent: 40, estHoursRemaining: 33, hoursToBeat: 52 };
  const shortlist = [sifu, terraria];

  const grounded: string[] = [
    "Portal 2 is your best bet — you're at 95% with 3 achievements left.",
    "Sifu beats Terraria's 33h remaining; you're 95% done.",
    "Half-Life 2: Episode One, ahead of the other 3 picks.",
    "About 1.1h left.",
    "Roughly 1h to go.",
  ];

  for (const sentence of grounded) {
    await test(`grounded: ${sentence}`, () => {
      assert.deepEqual(findUngroundedNumbers(sentence, shortlist), []);
    });
  }

  const ungrounded: [string, string[]][] = [
    ["You're 47% done with 7 hours left.", ["47%", "7 hours"]],
    // 95 is Sifu's achievement PERCENT — grounded on digits, nonsense as hours.
    ["95 hours left.", ["95 hours"]],
    // 1.1 rounds to 1, never up to 2.
    ["Roughly 2h to go.", ["2h"]],
    ["Just 5 hours and 12% to go.", ["5 hours", "12%"]],
  ];

  for (const [sentence, expected] of ungrounded) {
    await test(`ungrounded: ${sentence}`, () => {
      assert.deepEqual(findUngroundedNumbers(sentence, shortlist), expected);
    });
  }

  await test("checker accepts a single metrics object as well as a list", () => {
    assert.deepEqual(findUngroundedNumbers("95% done.", sifu), []);
  });

  await test("a real templateReason is always self-consistent", () => {
    // The fallback sentence is what replaces ungrounded model prose, so it
    // must never itself trip the checker — otherwise the guard would reject
    // its own replacement text.
    for (const rarity of [RARE, COMMON]) {
      const scored = scoreGame(
        { ...base, achievements: achievements(), playtime: playtime(), rarity },
        "completionist",
      );
      assert.deepEqual(
        findUngroundedNumbers(templateReason(scored), scored.metrics),
        [],
        `templateReason tripped the checker: ${templateReason(scored)}`,
      );
    }
  });

  // --- suppressed figures must not be quotable ----------------------------
  // Regression, found by running a real profile through the agent: the guard
  // was checking prose against the FULL metrics, so "Sifu needs about 1.1
  // hours" was accepted — 1.1 really is estHoursRemaining. But that figure is
  // withheld from the model precisely because it does not hold for a rarity
  // walled game, so accepting it defeats the suppression entirely.

  await test("quotableMetrics drops the hours figure only when it is a floor", () => {
    const walled = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    const normal = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: COMMON },
      "completionist",
    );

    assert.equal(walled.facts.remainingIsFloor, true);
    assert.ok(walled.metrics.estHoursRemaining !== undefined, "fixture must have hours to suppress");
    assert.equal(quotableMetrics(walled).estHoursRemaining, undefined);

    assert.equal(normal.facts.remainingIsFloor, false);
    assert.equal(quotableMetrics(normal).estHoursRemaining, normal.metrics.estHoursRemaining);
  });

  await test("a suppressed hours figure is rejected in prose", () => {
    const walled = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    const hours = walled.metrics.estHoursRemaining;
    const sentence = `It needs about ${hours} hours to finish.`;

    // Checked against the raw metrics it would wrongly pass; against the
    // quotable projection it must not.
    assert.deepEqual(findUngroundedNumbers(sentence, walled.metrics), []);
    assert.deepEqual(findUngroundedNumbers(sentence, quotableMetrics(walled)), [`${hours} hours`]);
  });

  // --- scarcity-weighted range --------------------------------------------
  // Replaces "time remaining is unknown" for rarity-walled games. Allocates the
  // known completionist total across achievements by how scarce each is,
  // instead of assuming every remaining one costs an average amount.

  /**
   * A realistic rarity map covers EVERY achievement, not just the unearned
   * ones — 90 commonly-unlocked achievements the player has, plus the 10 rare
   * ones they do not. Using a map that only contains the unearned set would
   * hand the whole time budget to them and prove nothing.
   */
  const fullRarityMap = (unearnedPercent: number) => {
    const map: Record<string, number> = {};
    for (let i = 0; i < 90; i++) map[`earned${i}`] = 55;
    for (const key of "abcdefghij") map[key] = unearnedPercent;
    return map;
  };

  await test("rare remainder produces a range well above the linear figure", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: fullRarityMap(1) },
      "completionist",
    );
    const { estHoursRemaining, estHoursRemainingLow, estHoursRemainingHigh } = scored.metrics;

    assert.equal(scored.facts.remainingIsFloor, true);
    assert.ok(estHoursRemainingLow !== undefined && estHoursRemainingHigh !== undefined, "expected a range");
    assert.ok(estHoursRemainingLow <= estHoursRemainingHigh, "bounds must be ordered");
    assert.ok(
      estHoursRemainingLow > estHoursRemaining,
      `range should exceed the linear estimate (${estHoursRemainingLow} vs ${estHoursRemaining})`,
    );
  });

  await test("scarcer achievements produce a larger estimate", () => {
    const mk = (pct: number) =>
      scoreGame(
        { ...base, achievements: achievements(), playtime: playtime(), rarity: fullRarityMap(pct) },
        "completionist",
      ).metrics.estHoursRemainingHigh;

    const veryRare = mk(0.5);
    const lessRare = mk(9);
    assert.ok(
      veryRare > lessRare,
      `0.5%-unlock remainder should cost more than 9% (${veryRare} vs ${lessRare})`,
    );
  });

  await test("the range never exceeds the total completionist time", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime({ hoursTo100: 20 }), rarity: fullRarityMap(0.5) },
      "completionist",
    );
    assert.ok(
      scored.metrics.estHoursRemainingHigh <= 20,
      `cannot need more time than the whole game takes: ${scored.metrics.estHoursRemainingHigh}`,
    );
  });

  await test("no rarity data falls back to achievements-left, not a made-up range", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: null },
      "completionist",
    );
    assert.equal(scored.metrics.estHoursRemainingLow, undefined);
    assert.equal(scored.metrics.estHoursRemainingHigh, undefined);
    assert.ok(scored.metrics.achievementsLeft !== undefined, "must still say how many are left");
  });

  await test("a rarity map covering only part of the game produces no range", () => {
    // RARE lists just the 10 unearned achievements, not the other 90. Treating
    // that as the whole game would make the remainder look like 100% of the
    // effort and hand over the entire completionist time.
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    assert.equal(scored.metrics.estHoursRemainingLow, undefined);
    assert.equal(scored.metrics.estHoursRemainingHigh, undefined);
  });

  await test("the range is quotable and its template passes the guard", () => {
    const scored = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: fullRarityMap(1) },
      "completionist",
    );
    const quotable = quotableMetrics(scored);
    // The linear figure stays suppressed; the range replaces it.
    assert.equal(quotable.estHoursRemaining, undefined);
    assert.ok(quotable.estHoursRemainingLow !== undefined);
    assert.deepEqual(findUngroundedNumbers(templateReason(scored), quotable), []);
    assert.match(templateReason(scored), /roughly [\d.]+h to [\d.]+h left/);
  });

  // --- caveats must not undo the suppression ------------------------------
  // Regression, found auditing 42 games from a real library: the floor caveat
  // used to read "the 1.1h figure assumes average difficulty and does not
  // hold". dataGaps are forwarded to the model as `caveats`, so that handed
  // back the exact value quotableMetrics strips — and printed it on the card
  // directly under the line that replaced it.

  await test("the floor caveat never names the suppressed hours figure", () => {
    const walled = scoreGame(
      { ...base, achievements: achievements(), playtime: playtime(), rarity: RARE },
      "completionist",
    );
    const hours = walled.metrics.estHoursRemaining;
    assert.equal(walled.facts.remainingIsFloor, true);
    assert.ok(hours !== undefined, "fixture must produce an hours figure to suppress");

    const caveats = walled.facts.dataGaps.join(" ");
    assert.ok(
      !caveats.includes(`${hours}h`),
      `caveat must not quote the withheld figure; got: ${caveats}`,
    );
    // And nothing in the caveats may trip the guard against the quotable set.
    assert.deepEqual(findUngroundedNumbers(caveats, quotableMetrics(walled)), []);
  });

  await test("a game with no playtime data gets one caveat, not two", () => {
    const scored = scoreGame(
      {
        ...base,
        achievements: achievements(),
        playtime: {
          hoursToBeat: null,
          hoursTo100: null,
          source: "none",
          matchedName: null,
          note: "No HowLongToBeat data found for this game.",
        },
        rarity: COMMON,
      },
      "completionist",
    );
    const aboutPlaytime = scored.facts.dataGaps.filter((gap) => /hours-to-beat|HowLongToBeat/i.test(gap));
    assert.equal(aboutPlaytime.length, 1, `expected one playtime caveat, got ${JSON.stringify(aboutPlaytime)}`);
  });

  await test("an inexact title match is still surfaced", () => {
    const scored = scoreGame(
      {
        ...base,
        achievements: achievements(),
        playtime: playtime({ matchedName: "Some Other Game", note: 'Matched to "Some Other Game" on HowLongToBeat, which is not an exact title match.' }),
        rarity: COMMON,
      },
      "completionist",
    );
    assert.ok(
      scored.facts.dataGaps.some((gap) => /not an exact title match/.test(gap)),
      "a fuzzy-match warning must never be swallowed by the dedupe",
    );
  });

  // --- pooledSettled must isolate failures --------------------------------
  // Regression: pooled() used Promise.all, so one rejected lookup aborted the
  // whole achievement sweep after hundreds of successful ones.

  await test("pooledSettled isolates a rejection and preserves order", async () => {
    const results = await pooledSettled([1, 2, 3, 4, 5], 2, async (n) => {
      if (n === 3) throw new Error("boom");
      return n * 10;
    });

    assert.equal(results.length, 5);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
    assert.equal(results[2].status, "rejected");
    assert.deepEqual(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
      [10, 20, null, 40, 50],
    );
  });

  await test("pooledSettled respects its concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await pooledSettled(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    assert.ok(peak <= 3, `expected at most 3 in flight, saw ${peak}`);
  });

  // --- thresholds are shared, not re-declared -----------------------------

  await test("thresholds drive the categories they name", () => {
    // A game just inside the Long Haul floor must not be Long Haul, and one
    // just outside it must be — proves scoreGame reads THRESHOLDS rather than
    // carrying its own copy of the number.
    const under = categoryOf(
      { ...base, playtime: playtime({ hoursToBeat: THRESHOLDS.LONG_HAUL_HOURS_FLOOR + base.hoursPlayed, hoursTo100: null }) },
      "beat-once",
    );
    const over = categoryOf(
      { ...base, playtime: playtime({ hoursToBeat: THRESHOLDS.LONG_HAUL_HOURS_FLOOR + base.hoursPlayed + 10, hoursTo100: null }) },
      "beat-once",
    );
    assert.notEqual(under, "long-haul");
    assert.equal(over, "long-haul");
  });

  console.log(
    failures === 0
      ? `\n${run} checks passed.`
      : `\n${failures} of ${run} checks FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
