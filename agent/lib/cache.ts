/**
 * Per-conversation in-memory cache.
 *
 * This is deliberately not a database. It is a Map held in the server process,
 * scoped by session id, and it dies with the process. Nothing is persisted to
 * disk, and nothing outlives a restart.
 *
 * It is bounded now: at most MAX_SESSIONS entries, each expiring after
 * SESSION_TTL_MS of inactivity. Without this, a long-running process (e.g. an
 * always-on dev/preview deployment) accumulates one entry per conversation
 * forever, each holding a full Steam library plus several per-appid maps.
 * Eviction is lazy - on the next `cacheFor` call - rather than a background
 * timer, so this file adds no interval/setInterval and no new dependency.
 */

type SessionCache = {
  library?: unknown;
  steamId?: string;
  achievements: Map<number, unknown>;
  playtime: Map<string, unknown>;
  proton: Map<number, unknown>;
  rarity: Map<number, unknown>;
  details?: Map<number, unknown>;
  /** Genres and tags per appid, so a second genre question rescans nothing. */
  facets?: Map<number, unknown>;
  /**
   * The best document search this conversation has managed, so a later, weaker
   * search cannot erase it. Observed live: a first search cleared the relevance
   * floor with the right document, the model searched again, the second came
   * back below the floor, and it concluded the documents did not cover the
   * question — discarding evidence it had already been given.
   */
  bestDocSearch?: unknown;
  /** Updated on every `cacheFor` call; drives both TTL and LRU eviction. */
  lastAccess: number;
};

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes

const sessions = new Map<string, SessionCache>();

/**
 * Drop expired entries, then - if still over the cap - drop the least
 * recently used survivors. Runs on every call instead of on a timer so the
 * cache never needs its own background process.
 */
function evictStale(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }

  if (sessions.size <= MAX_SESSIONS) return;

  const byLastAccess = [...sessions.entries()].sort(
    (a, b) => a[1].lastAccess - b[1].lastAccess,
  );
  const overflow = sessions.size - MAX_SESSIONS;
  for (let i = 0; i < overflow; i++) {
    sessions.delete(byLastAccess[i][0]);
  }
}

export function cacheFor(sessionId: string): SessionCache {
  evictStale();

  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      achievements: new Map(),
      playtime: new Map(),
      proton: new Map(),
      rarity: new Map(),
      lastAccess: Date.now(),
    };
    sessions.set(sessionId, entry);
  } else {
    entry.lastAccess = Date.now();
  }
  return entry;
}

/** Run tasks with a bounded number in flight, preserving input order. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Same bounded-concurrency, order-preserving pool as `pooled`, but a single
 * worker rejection does not abort its siblings. sweep_achievements runs this
 * over hundreds of games on the slowest operation in the app (one keyed HTTP
 * call per game); `pooled`'s Promise.all would let one flaky game fail the
 * whole sweep after most of the work already succeeded.
 */
export async function pooledSettled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
