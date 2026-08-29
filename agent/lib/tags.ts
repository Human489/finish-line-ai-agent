/**
 * Steam tags: the words people actually use for games.
 *
 * Steam's store genres are a short, coarse list - Action, Adventure, Indie,
 * RPG, Strategy and a few more. Nobody asks for "an Action game"; they ask for
 * something cosy, or a soulslike, or horror. Those are TAGS, and appdetails
 * does not carry them, which is why a horror question used to be unanswerable.
 *
 * Two sources, deliberately split by what each is actually authoritative for:
 *
 *   - Whether a tag EXISTS is answered by Steam itself, from the same tag list
 *     the store's own filters are built from. 430 tags, first-party.
 *   - Which games CARRY a tag is answered by SteamSpy, because Steam publishes
 *     no per-game tag endpoint at all. appdetails returns genres and
 *     categories and stops there.
 *
 * SteamSpy's tag data is crowd-voted and its bulk list is noisy: asking it for
 * everything tagged Horror returns 10,896 games including Apex Legends and
 * PUBG, because a single stray vote counts. Its PER-GAME data is good, though,
 * because it carries vote counts: Phasmophobia's top tag is Horror with 4,450
 * votes, and Apex Legends has no horror tag anywhere near its top. So the bulk
 * list is used only to narrow the field, and every game actually offered is
 * confirmed against its own tag votes.
 */

import { pooledSettled } from "./cache";

const STEAM_TAGS = "https://store.steampowered.com/tagdata/populartags/english";
const STEAMSPY = "https://steamspy.com/api.php";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A tag must be in a game's top few to count.
 *
 * This is the whole defence against "Apex Legends is horror". One person can
 * put any tag on any game; ranking by votes is what separates a game that IS
 * horror from one that somebody once thought was funny to label.
 */
const TAG_RANK_CEILING = 8;

/** How many games to confirm before giving up, so one question stays bounded. */
const MAX_TAG_LOOKUPS = 12;

/**
 * British spellings and the obvious near-misses. Steam's tag is "Cozy", and a
 * player typing "cosy" is not asking a different question.
 */
const SPELLING: Record<string, string> = {
  cosy: "cozy",
  greatsoundtrack: "great soundtrack",
  soulslike: "souls-like",
  soulsborne: "souls-like",
  roguelite: "rogue-lite",
};

let tagCache: { names: Map<string, string>; fetchedAt: number } | null = null;
const TAG_TTL_MS = 60 * 60 * 1000;

function normalise(term: string): string {
  const cleaned = term.trim().toLowerCase();
  return SPELLING[cleaned.replace(/[\s-]/g, "")] ?? cleaned;
}

/** Steam's own tag vocabulary, lowercased name -> canonical name. */
async function steamTagNames(): Promise<Map<string, string>> {
  if (tagCache && Date.now() - tagCache.fetchedAt < TAG_TTL_MS) return tagCache.names;

  const response = await fetch(STEAM_TAGS, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Steam tag list failed (HTTP ${response.status}).`);

  const body = (await response.json()) as { name?: string }[];
  const names = new Map<string, string>();
  for (const tag of body) {
    if (typeof tag.name === "string") names.set(tag.name.toLowerCase(), tag.name);
  }

  tagCache = { names, fetchedAt: Date.now() };
  return names;
}

/**
 * The canonical Steam tag for a player's word, or null if Steam has no such
 * tag. Returning the canonical spelling matters: it is what gets shown back.
 */
export async function resolveTag(term: string): Promise<string | null> {
  const names = await steamTagNames();
  return names.get(normalise(term)) ?? null;
}

/** A handful of real tags to offer when the player's word is not one. */
export async function suggestTags(): Promise<string[]> {
  const names = await steamTagNames();
  // Common enough to be useful as examples, and all confirmed present rather
  // than hardcoded blind - Steam has renamed tags before.
  const wanted = ["Horror", "Cozy", "Souls-like", "Roguelike", "Puzzle", "Story Rich"];
  return wanted.filter((tag) => names.has(tag.toLowerCase()));
}

/** Every appid SteamSpy associates with a tag. Noisy on purpose - see above. */
export async function appidsWithTag(tag: string): Promise<Set<number>> {
  const url = `${STEAMSPY}?request=tag&tag=${encodeURIComponent(tag)}`;
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SteamSpy tag lookup failed (HTTP ${response.status}).`);

  const body = (await response.json()) as Record<string, unknown>;
  const appids = new Set<number>();
  for (const key of Object.keys(body)) {
    const appid = Number(key);
    if (Number.isFinite(appid)) appids.add(appid);
  }
  return appids;
}

/** A game's tags, most-voted first. Empty when SteamSpy has nothing. */
async function topTags(appid: number): Promise<string[]> {
  const response = await fetch(`${STEAMSPY}?request=appdetails&appid=${appid}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return [];

  const body = (await response.json()) as { tags?: Record<string, number> | unknown[] };
  const tags = body.tags;
  // SteamSpy returns {} or [] for a game nobody has tagged, and an object of
  // tag -> vote count otherwise.
  if (!tags || Array.isArray(tags)) return [];

  return Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

export type TagMatch = { appid: number; tags: string[] };

/**
 * Confirm which of these games genuinely carry the tag.
 *
 * Checked in the order given and stopped as soon as `wanted` are confirmed, so
 * a common tag costs a couple of lookups rather than the full budget.
 */
export async function confirmTagged(
  appids: number[],
  tag: string,
  wanted: number,
): Promise<{ matches: TagMatch[]; checked: number }> {
  const target = tag.toLowerCase();
  const budget = appids.slice(0, MAX_TAG_LOOKUPS);
  const matches: TagMatch[] = [];
  let checked = 0;

  // Two at a time. SteamSpy asks for about one request a second on this
  // endpoint, and this is the difference between a bounded answer and hammering
  // somebody's free service for a games recommendation.
  for (let i = 0; i < budget.length && matches.length < wanted; i += 2) {
    const slice = budget.slice(i, i + 2);
    const settled = await pooledSettled(slice, 2, (appid) => topTags(appid));

    settled.forEach((result, index) => {
      checked += 1;
      if (result.status !== "fulfilled") return;
      const rank = result.value.findIndex((name) => name.toLowerCase() === target);
      if (rank >= 0 && rank < TAG_RANK_CEILING) {
        matches.push({ appid: slice[index], tags: result.value.slice(0, 6) });
      }
    });
  }

  return { matches, checked };
}
