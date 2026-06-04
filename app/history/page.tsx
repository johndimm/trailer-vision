"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { StaticStars } from "../components/Stars";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";
import { canonicalTitleKey } from "../lib/canonicalTitleKey";
import {
  canUseLocalStorage,
  loadRatingHistory,
  saveRatingHistory,
  type StoredRatingEntry,
} from "../lib/storageKeys";
import {
  loadUnseenInterestLog,
  saveUnseenInterestLog,
  type UnseenInterestEntry,
} from "../lib/unseenInterestLog";
import { Channel, normalizeChannel, CHANNELS_KEY } from "../channels/page";

const RECONSIDER_KEY = "movie-recs-reconsider";
const WATCHLIST_KEY = "movie-recs-watchlist";

type SeenRow  = { kind: "seen";   entry: StoredRatingEntry;   origIndex: number; sortKey: string };
type UnseenRow = { kind: "unseen"; entry: UnseenInterestEntry; origIndex: number; sortKey: string };
type UnifiedRow = SeenRow | UnseenRow;

export default function HistoryPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [history, setHistory] = useState<StoredRatingEntry[]>([]);
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);

  const refreshFromStorage = useCallback(() => {
    if (!canUseLocalStorage()) {
      setStorageBlocked(true);
      setHistory([]);
      setUnseenLog([]);
      setChannels([]);
      setHydrated(true);
      return;
    }
    setStorageBlocked(false);
    try {
      setHistory(loadRatingHistory());
      setUnseenLog(loadUnseenInterestLog());
      const ch = localStorage.getItem(CHANNELS_KEY);
      if (ch) setChannels((JSON.parse(ch) as Channel[]).map(normalizeChannel));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useLayoutEffect(() => { refreshFromStorage(); }, [refreshFromStorage]);

  useEffect(() => {
    refreshFromStorage();
    const onRefresh = () => refreshFromStorage();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("storage", onRefresh);
    const onVisible = () => { if (document.visibilityState === "visible") onRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("storage", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshFromStorage]);

  useEffect(() => {
    if (pathname === "/history") refreshFromStorage();
  }, [pathname, refreshFromStorage]);

  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of channels) m.set(ch.id, ch.name);
    return m;
  }, [channels]);

  const watchlistKeys = useMemo(() => {
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      const wl: { title: string }[] = wlRaw ? JSON.parse(wlRaw) : [];
      return new Set(wl.map((w) => canonicalTitleKey(w.title)));
    } catch {
      return new Set<string>();
    }
  }, [unseenLog]);

  // Merge both lists into one chronological list.
  // Seen entries use presentedAt (new) or array-index-based synthetic key for old entries.
  // Unseen entries use their at timestamp.
  const unified = useMemo((): UnifiedRow[] => {
    const seenRows: SeenRow[] = history.map((entry, i) => ({
      kind: "seen",
      entry,
      origIndex: i,
      // Pad index so lexicographic sort works for legacy entries without presentedAt
      sortKey: entry.presentedAt ?? `0000-${String(i).padStart(6, "0")}`,
    }));
    const unseenRows: UnseenRow[] = unseenLog.map((entry, i) => ({
      kind: "unseen",
      entry,
      origIndex: i,
      sortKey: entry.at,
    }));
    const all: UnifiedRow[] = [...seenRows, ...unseenRows];
    all.sort((a, b) => {
      const cmp = a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return all;
  }, [history, unseenLog, sortDir]);

  const rowKey = (row: UnifiedRow) => `${row.kind}-${row.origIndex}`;

  const deleteSelected = useCallback(() => {
    if (selectedKeys.size === 0) return;
    const seenToRemove = new Set<number>();
    const unseenToRemove = new Set<number>();
    for (const k of selectedKeys) {
      if (k.startsWith("seen-")) seenToRemove.add(Number(k.slice(5)));
      else if (k.startsWith("unseen-")) unseenToRemove.add(Number(k.slice(7)));
    }
    if (seenToRemove.size > 0) {
      const next = history.filter((_, i) => !seenToRemove.has(i));
      saveRatingHistory(next);
      setHistory(next);
    }
    if (unseenToRemove.size > 0) {
      const next = unseenLog.filter((_, i) => !unseenToRemove.has(i));
      saveUnseenInterestLog(next);
      setUnseenLog(next);
    }
    setSelectedKeys(new Set());
  }, [history, unseenLog, selectedKeys]);

  const deleteSingle = useCallback((row: UnifiedRow) => {
    if (row.kind === "seen") {
      const next = history.filter((_, i) => i !== row.origIndex);
      saveRatingHistory(next);
      setHistory(next);
    } else {
      const next = unseenLog.filter((_, i) => i !== row.origIndex);
      saveUnseenInterestLog(next);
      setUnseenLog(next);
    }
    setSelectedKeys((prev) => { const s = new Set(prev); s.delete(rowKey(row)); return s; });
  }, [history, unseenLog]);

  const reconsider = useCallback((e: StoredRatingEntry, origIndex: number) => {
    const next = history.filter((_, i) => i !== origIndex);
    saveRatingHistory(next);
    setHistory(next);
    localStorage.setItem(RECONSIDER_KEY, JSON.stringify({
      title: e.title, type: e.type, year: null, director: null,
      predictedRating: e.predictedRating, actors: [], plot: "",
      posterUrl: e.posterUrl ?? null, trailerKey: null, rtScore: e.rtScore ?? null,
    }));
    router.push("/");
  }, [history, router]);

  const totalCount = unified.length;
  const ratedCount = history.filter((e) => e.userRating !== null).length;
  const unseenCount = unseenLog.length;
  const unratedCount = history.filter((e) => e.userRating === null).length;

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4">

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold text-zinc-900">History</h1>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            {totalCount > 0 && (
              <span>
                {ratedCount} rated · {unseenCount} unseen{unratedCount > 0 ? ` · ${unratedCount} not rated` : ""}
              </span>
            )}
            <Link href="/channel-history" className="font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
              By channel →
            </Link>
          </div>
        </div>

        {storageBlocked ? (
          <div className="bg-white rounded-2xl border border-amber-200 shadow-sm p-8 text-center text-sm text-zinc-600 space-y-2">
            <p className="font-medium text-zinc-800">Browser storage isn&apos;t available here</p>
            <p>History is saved in this browser only. Open Trailer Vision in its own tab to keep ratings.</p>
          </div>
        ) : !hydrated ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">
            Loading history…
          </div>
        ) : totalCount === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm space-y-2">
            <p>No activity yet. Rate titles on the Player page — red stars for seen, blue for unseen.</p>
            <p className="text-xs text-zinc-400">
              History stays in this browser and doesn&apos;t sync from localhost or other devices.
              Use Settings → Export backup to move data between environments.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/80 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selectedKeys.size === totalCount && totalCount > 0}
                  onChange={(ev) => {
                    if (ev.target.checked) setSelectedKeys(new Set(unified.map(rowKey)));
                    else setSelectedKeys(new Set());
                  }}
                  className="accent-indigo-600"
                />
                <span className="text-xs font-semibold text-zinc-600">{totalCount} titles</span>
              </div>
              <div className="flex items-center gap-2">
                {selectedKeys.size > 0 && (
                  <button
                    type="button"
                    onClick={deleteSelected}
                    className="text-xs font-semibold text-rose-600 hover:text-rose-800 transition-colors"
                  >
                    Delete selected ({selectedKeys.size})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
                  className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1"
                  title={sortDir === "desc" ? "Newest first" : "Oldest first"}
                >
                  {sortDir === "desc" ? "Newest first" : "Oldest first"}
                  <span className="opacity-70">{sortDir === "desc" ? "↓" : "↑"}</span>
                </button>
              </div>
            </div>

            {/* Unified list */}
            <ul className="divide-y divide-zinc-50">
              {unified.map((row) => {
                const key = rowKey(row);
                const isSelected = selectedKeys.has(key);

                if (row.kind === "seen") {
                  const e = row.entry;
                  const isRated = e.userRating !== null;
                  const d = isRated ? starDelta(e.userRating!, e.predictedRating) : null;
                  const chName = e.channelId ? channelMap.get(e.channelId) : undefined;
                  return (
                    <li
                      key={key}
                      className={`px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 transition-colors ${isSelected ? "bg-indigo-50" : "hover:bg-zinc-50"}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(ev) => setSelectedKeys((prev) => {
                          const s = new Set(prev);
                          ev.target.checked ? s.add(key) : s.delete(key);
                          return s;
                        })}
                        className="accent-indigo-600 shrink-0"
                      />
                      {e.posterUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={e.posterUrl} alt={e.title} referrerPolicy="no-referrer"
                          className="w-7 h-10 rounded object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => reconsider(e, row.origIndex)}
                          className="font-medium text-zinc-800 truncate block text-left hover:text-indigo-600 transition-colors"
                          title="Click to re-rate"
                        >
                          {e.title}
                        </button>
                        <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                          <span>{e.type === "tv" ? "TV" : "Film"}</span>
                          {chName && <span className="text-zinc-500">· {chName}</span>}
                          {e.watchFrac != null && e.watchFrac > 0 && (
                            <span title="Trailer watched">{Math.round(e.watchFrac * 100)}% watched</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isRated ? (
                          <>
                            <span
                              className={`w-12 text-right tabular-nums text-sm font-semibold ${d! > 0 ? "text-emerald-700" : d! < 0 ? "text-rose-700" : "text-zinc-500"}`}
                              title="Your rating minus predicted"
                            >
                              {formatStarDelta(d!)}
                            </span>
                            <div className="w-20 flex justify-end">
                              <StaticStars rating={migrateRatingValue(e.userRating!)} color="red" />
                            </div>
                          </>
                        ) : (
                          <span className="w-32 text-right text-xs text-zinc-400">not rated</span>
                        )}
                        <button type="button" onClick={() => deleteSingle(row)}
                          className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0"
                          title="Delete" aria-label="Delete">×</button>
                      </div>
                    </li>
                  );
                }

                // unseen row
                const e = row.entry;
                const chName = channelMap.get(e.channelId);
                return (
                  <li
                    key={key}
                    className={`px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 transition-colors ${isSelected ? "bg-indigo-50" : "hover:bg-zinc-50"}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(ev) => setSelectedKeys((prev) => {
                        const s = new Set(prev);
                        ev.target.checked ? s.add(key) : s.delete(key);
                        return s;
                      })}
                      className="accent-indigo-600 shrink-0"
                    />
                    {e.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.posterUrl} alt={e.title} referrerPolicy="no-referrer"
                        className="w-7 h-10 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-zinc-800 truncate block">{e.title}</span>
                      <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                        <span>{e.type === "tv" ? "TV" : "Film"}</span>
                        {chName && <span className="text-zinc-500">· {chName}</span>}
                        <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                          e.kind === "want" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                        }`}>
                          {e.kind === "want"
                            ? watchlistKeys.has(canonicalTitleKey(e.title)) ? "Added" : "Not on list"
                            : "Not interested"}
                        </span>
                        {e.watchFrac != null && e.watchFrac > 0 && (
                          <span title="Trailer watched">{Math.round(e.watchFrac * 100)}% watched</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 shrink-0">
                      <div className="w-20 flex justify-end">
                        <StaticStars rating={migrateRatingValue(e.interestStars)} color="blue" />
                      </div>
                      <button type="button" onClick={() => deleteSingle(row)}
                        className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0"
                        title="Delete" aria-label="Delete">×</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
