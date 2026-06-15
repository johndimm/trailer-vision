import { safeGetItem, safeSetItem } from "./storageKeys";

export { canonicalTitleKey } from "./canonicalTitleKey";

export const UNSEEN_INTEREST_LOG_KEY = "movie-recs-unseen-interest-log";

export type UnseenInterestEntry = {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
  interestStars: number | null;
  kind: "want" | "skip";
  channelId: string;
  at: string;
  watchFrac?: number;
};

function isValidEntry(x: unknown): x is Omit<UnseenInterestEntry, "channelId"> & { channelId?: string } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title) return false;
  if (o.type !== "movie" && o.type !== "tv") return false;
  if (o.interestStars !== null && (typeof o.interestStars !== "number" || !Number.isFinite(o.interestStars))) return false;
  if (o.kind !== "want" && o.kind !== "skip") return false;
  if (typeof o.at !== "string") return false;
  return true;
}

function normalizeEntry(x: unknown): UnseenInterestEntry | null {
  if (!isValidEntry(x)) return null;
  const o = x as Record<string, unknown>;
  return {
    ...x,
    channelId: typeof x.channelId === "string" && x.channelId ? x.channelId : "all",
    watchFrac: typeof o.watchFrac === "number" && Number.isFinite(o.watchFrac) ? o.watchFrac : undefined,
  };
}

export function loadUnseenInterestLog(): UnseenInterestEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = safeGetItem(UNSEEN_INTEREST_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeEntry).filter((e): e is UnseenInterestEntry => e != null);
  } catch {
    return [];
  }
}

export function pushUnseenInterestEntry(entry: UnseenInterestEntry): void {
  const cur = loadUnseenInterestLog();
  cur.push(entry);
  safeSetItem(UNSEEN_INTEREST_LOG_KEY, JSON.stringify(cur));
}

export function saveUnseenInterestLog(entries: UnseenInterestEntry[]): void {
  safeSetItem(UNSEEN_INTEREST_LOG_KEY, JSON.stringify(entries));
}

export function entryMatchesChannel(entry: UnseenInterestEntry, channelId: string): boolean {
  if (channelId === "all") return !entry.channelId || entry.channelId === "all";
  return entry.channelId === channelId;
}
