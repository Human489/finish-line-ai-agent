/**
 * Per-conversation in-memory cache.
 *
 * This is deliberately not a database. It is a Map held in the server process,
 * scoped by session id, and it dies with the process. Nothing is persisted to
 * disk, and nothing outlives a restart.
 */

type SessionCache = {
  library?: unknown;
  steamId?: string;
  achievements: Map<number, unknown>;
  playtime: Map<string, unknown>;
  proton: Map<number, unknown>;
  rarity: Map<number, unknown>;
  details?: Map<number, unknown>;
};

const sessions = new Map<string, SessionCache>();

export function cacheFor(sessionId: string): SessionCache {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      achievements: new Map(),
      playtime: new Map(),
      proton: new Map(),
      rarity: new Map(),
    };
    sessions.set(sessionId, entry);
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
