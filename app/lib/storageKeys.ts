import { migrateRatingValue, normalizePredictedRating } from "./ratingScale";

/** Legacy single-queue key; migrated to per-channel keys on read. */
export const LEGACY_PREFETCH_QUEUE_KEY = "movie-recs-prefetch-queue";

export const RATING_HISTORY_KEY = "movie-recs-history";

/** True when localStorage read/write works in this browsing context. */
export function canUseLocalStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const probe = "__tv_ls_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function safeGetItem(key: string): string | null {
  if (!canUseLocalStorage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

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

// ── Rating history (movie-recs-history) ─────────────────────────────────────

export interface StoredRatingEntry {
  title: string;
  type: "movie" | "tv";
  /** null = presented but not yet rated */
  userRating: number | null;
  predictedRating: number;
  error: number;
  rtScore?: string | null;
  channelId?: string;
  posterUrl?: string | null;
  ratingMode?: "seen" | "unseen";
  watchFrac?: number;
  /** ISO timestamp of when this title was first presented */
  presentedAt?: string;
  /** Genre/category tags assigned by the LLM at recommendation time */
  categories?: string[];
}

function toRatingNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseRatingEntry(x: unknown): StoredRatingEntry | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) return null;

  // null / absent userRating = presented but not rated
  const userRaw = (o.userRating === null || o.userRating === undefined)
    ? null
    : toRatingNumber(o.userRating);
  // If userRating was present but not a valid number, reject
  if (o.userRating !== null && o.userRating !== undefined && userRaw === null) return null;

  const predRaw = toRatingNumber(o.predictedRating);
  const u = userRaw != null ? migrateRatingValue(userRaw) : null;
  const p = predRaw != null ? migrateRatingValue(predRaw) : normalizePredictedRating(undefined);

  return {
    title: o.title.trim(),
    type: o.type === "tv" ? "tv" : "movie",
    userRating: u,
    predictedRating: p,
    error: u != null ? Math.abs(u - p) : 0,
    rtScore: typeof o.rtScore === "string" || o.rtScore === null ? (o.rtScore as string | null) : undefined,
    channelId: typeof o.channelId === "string" ? o.channelId : undefined,
    posterUrl: typeof o.posterUrl === "string" || o.posterUrl === null ? (o.posterUrl as string | null) : undefined,
    ratingMode: o.ratingMode === "unseen" ? "unseen" : o.ratingMode === "seen" ? "seen" : undefined,
    watchFrac: typeof o.watchFrac === "number" && Number.isFinite(o.watchFrac) ? o.watchFrac : undefined,
    presentedAt: typeof o.presentedAt === "string" ? o.presentedAt : undefined,
    categories: Array.isArray(o.categories)
      ? (o.categories as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined,
  };
}

/** Read and normalize seen ratings from localStorage. Returns [] on missing or corrupt data. */
export function loadRatingHistory(): StoredRatingEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = safeGetItem(RATING_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRatingEntry).filter((e): e is StoredRatingEntry => e != null);
  } catch {
    return [];
  }
}

export function saveRatingHistory(entries: StoredRatingEntry[]): void {
  safeSetItem(RATING_HISTORY_KEY, JSON.stringify(entries));
}

