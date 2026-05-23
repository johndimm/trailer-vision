/** Legacy single-queue key; migrated to per-channel keys on read. */
export const LEGACY_PREFETCH_QUEUE_KEY = "movie-recs-prefetch-queue";

const PREFETCH_QUEUE_PREFIX = "movie-recs-prefetch-queue";
const CURRENT_MOVIE_PREFIX = "movie-recs-current";

/** Per-channel currently displayed title card (restored when switching back to the channel). */
export function currentMovieStorageKey(channelId: string): string {
  const id = channelId?.trim() ? channelId.trim() : "all";
  return `${CURRENT_MOVIE_PREFIX}:${id}`;
}

export function isCurrentMovieStorageKey(key: string): boolean {
  return key.startsWith(`${CURRENT_MOVIE_PREFIX}:`);
}

export function clearChannelPersistedData(channelId: string): void {
  if (typeof window === "undefined") return;
  const id = channelId?.trim();
  if (!id || id === "all") return;
  try {
    localStorage.removeItem(prefetchQueueStorageKey(id));
    localStorage.removeItem(currentMovieStorageKey(id));
  } catch {
    /* ignore */
  }
}

export function clearChannelsPersistedData(ids: Iterable<string>): void {
  for (const id of ids) clearChannelPersistedData(id);
}

/** Per-channel prefetch queue in localStorage (JSON array of title cards). */
export function prefetchQueueStorageKey(channelId: string): string {
  const id = channelId?.trim() ? channelId.trim() : "all";
  return `${PREFETCH_QUEUE_PREFIX}:${id}`;
}

export function isPrefetchQueueStorageKey(key: string): boolean {
  return key === LEGACY_PREFETCH_QUEUE_KEY || key.startsWith(`${PREFETCH_QUEUE_PREFIX}:`);
}

/** Every localStorage key that stores a prefetch queue (for export / reset). */
export function listPrefetchQueueStorageKeys(): string[] {
  if (typeof window === "undefined") return [];
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isPrefetchQueueStorageKey(k)) out.push(k);
  }
  return out.sort();
}

export function clearAllPrefetchQueueKeys(): void {
  for (const k of listPrefetchQueueStorageKeys()) {
    localStorage.removeItem(k);
  }
}
