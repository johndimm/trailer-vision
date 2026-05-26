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

type SortField = "order" | "rating" | "title" | "channel";
type SortDir = "asc" | "desc";

export default function HistoryPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [history, setHistory] = useState<StoredRatingEntry[]>([]);
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sortField, setSortField] = useState<SortField>("order");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedSeenRows, setSelectedSeenRows] = useState<Set<number>>(new Set());
  const [selectedUnseenRows, setSelectedUnseenRows] = useState<Set<number>>(new Set());
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

  useLayoutEffect(() => {
    refreshFromStorage();
  }, [refreshFromStorage]);

  useEffect(() => {
    refreshFromStorage();
    const onRefresh = () => refreshFromStorage();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("storage", onRefresh);
    const onVisible = () => {
      if (document.visibilityState === "visible") onRefresh();
    };
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

  const sortedSeen = useMemo(() => {
    const copy = history.map((e, i) => ({ ...e, _index: i }));
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortField === "order") {
        cmp = a._index - b._index;
      } else if (sortField === "rating") {
        cmp = a.userRating - b.userRating;
      } else if (sortField === "title") {
        cmp = a.title.localeCompare(b.title);
      } else {
        const ca = channelMap.get(a.channelId ?? "") ?? "";
        const cb = channelMap.get(b.channelId ?? "") ?? "";
        cmp = ca.localeCompare(cb);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [history, sortField, sortDir, channelMap]);

  const sortedUnseen = useMemo(() => {
    const copy = unseenLog.map((e, i) => ({ ...e, _index: i }));
    copy.sort((a, b) => (a.at < b.at ? 1 : -1));
    return copy;
  }, [unseenLog]);

  const totalCount = history.length + unseenLog.length;

  const deleteSeenEntries = useCallback(
    (rowIndices: number[]) => {
      const toRemove = new Set(
        rowIndices.map((r) => sortedSeen[r]?._index).filter((i): i is number => i != null && i >= 0),
      );
      const next = history.filter((_, i) => !toRemove.has(i));
      saveRatingHistory(next);
      setHistory(next);
      setSelectedSeenRows((prev) => {
        const updated = new Set(prev);
        rowIndices.forEach((r) => updated.delete(r));
        return updated;
      });
    },
    [history, sortedSeen],
  );

  const deleteUnseenEntries = useCallback(
    (rowIndices: number[]) => {
      const toRemove = new Set(
        rowIndices.map((r) => sortedUnseen[r]?._index).filter((i): i is number => i != null && i >= 0),
      );
      const next = unseenLog.filter((_, i) => !toRemove.has(i));
      saveUnseenInterestLog(next);
      setUnseenLog(next);
      setSelectedUnseenRows((prev) => {
        const updated = new Set(prev);
        rowIndices.forEach((r) => updated.delete(r));
        return updated;
      });
    },
    [unseenLog, sortedUnseen],
  );

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "order" || field === "rating" ? "desc" : "asc");
    }
  };

  const reconsider = (e: StoredRatingEntry) => {
    const newHistory = history.filter((h) => h.title !== e.title);
    saveRatingHistory(newHistory);
    setHistory(newHistory);
    localStorage.setItem(
      RECONSIDER_KEY,
      JSON.stringify({
        title: e.title,
        type: e.type,
        year: null,
        director: null,
        predictedRating: e.predictedRating,
        actors: [],
        plot: "",
        posterUrl: e.posterUrl ?? null,
        trailerKey: null,
        rtScore: e.rtScore ?? null,
      }),
    );
    router.push("/");
  };

  const SortBtn = ({ field, label }: { field: SortField; label: string }) => {
    const active = sortField === field;
    return (
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "bg-zinc-900 text-white"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        }`}
      >
        {label}
        {active && (
          <span className="text-xs opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>
        )}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4">

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold text-zinc-900">History</h1>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            {totalCount > 0 && (
              <span>
                {history.length} seen · {unseenLog.length} unseen
              </span>
            )}
            <Link
              href="/channel-history"
              className="font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              By channel →
            </Link>
          </div>
        </div>

        {storageBlocked ? (
          <div className="bg-white rounded-2xl border border-amber-200 shadow-sm p-8 text-center text-sm text-zinc-600 space-y-2">
            <p className="font-medium text-zinc-800">Browser storage isn&apos;t available here</p>
            <p>
              History is saved in this browser only. Embedded or restricted contexts (some mobile /
              in-app browsers) can block it — open Trailer Vision in its own tab to keep ratings.
            </p>
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
          <>
            {history.length > 0 && (
              <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/80">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label="Select all seen"
                        checked={
                          selectedSeenRows.size === sortedSeen.length && sortedSeen.length > 0
                        }
                        onChange={(ev) => {
                          if (ev.target.checked) {
                            setSelectedSeenRows(new Set(sortedSeen.map((_, i) => i)));
                          } else {
                            setSelectedSeenRows(new Set());
                          }
                        }}
                        className="accent-indigo-600"
                      />
                      <p className="text-xs font-semibold text-zinc-600">Seen (red stars)</p>
                    </div>
                    {selectedSeenRows.size > 0 && (
                      <button
                        type="button"
                        onClick={() => deleteSeenEntries([...selectedSeenRows])}
                        className="text-xs font-semibold text-rose-600 hover:text-rose-800 transition-colors"
                      >
                        Delete selected ({selectedSeenRows.size})
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mr-1">Sort</span>
                    <SortBtn field="order" label="Order" />
                    <SortBtn field="rating" label="Rating" />
                    <SortBtn field="title" label="Title" />
                    <SortBtn field="channel" label="Channel" />
                  </div>
                </div>

                <ul className="divide-y divide-zinc-50">
                  {sortedSeen.map((e, i) => {
                    const d = starDelta(e.userRating, e.predictedRating);
                    const chName = e.channelId ? channelMap.get(e.channelId) : undefined;
                    return (
                      <li
                        key={`seen-${e.title}-${e._index}-${i}`}
                        className={`px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 transition-colors ${
                          selectedSeenRows.has(i) ? "bg-indigo-50" : "hover:bg-zinc-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSeenRows.has(i)}
                          onChange={(ev) => {
                            setSelectedSeenRows((prev) => {
                              const next = new Set(prev);
                              if (ev.target.checked) next.add(i);
                              else next.delete(i);
                              return next;
                            });
                          }}
                          className="accent-indigo-600 shrink-0"
                        />
                        {e.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={e.posterUrl}
                            alt={e.title}
                            referrerPolicy="no-referrer"
                            className="w-7 h-10 rounded object-cover flex-shrink-0"
                          />
                        ) : (
                          <div className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => reconsider(e)}
                            className="font-medium text-zinc-800 truncate block text-left hover:text-indigo-600 transition-colors"
                            title="Click to re-rate"
                          >
                            {e.title}
                          </button>
                          <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                            <span>{e.type === "tv" ? "TV" : "Film"}</span>
                            {chName && <span className="text-zinc-500">· {chName}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`w-12 text-right tabular-nums text-sm font-semibold ${
                              d > 0 ? "text-emerald-700" : d < 0 ? "text-rose-700" : "text-zinc-500"
                            }`}
                            title="Your rating minus predicted"
                          >
                            {formatStarDelta(d)}
                          </span>
                          <div className="w-20 flex justify-end">
                            <StaticStars rating={e.userRating} color="red" />
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteSeenEntries([i])}
                            className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0"
                            title="Delete this entry"
                            aria-label="Delete"
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {unseenLog.length > 0 && (
              <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/80">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label="Select all unseen"
                        checked={
                          selectedUnseenRows.size === sortedUnseen.length && sortedUnseen.length > 0
                        }
                        onChange={(ev) => {
                          if (ev.target.checked) {
                            setSelectedUnseenRows(new Set(sortedUnseen.map((_, i) => i)));
                          } else {
                            setSelectedUnseenRows(new Set());
                          }
                        }}
                        className="accent-indigo-600"
                      />
                      <p className="text-xs font-semibold text-zinc-600">Unseen (blue stars)</p>
                    </div>
                    {selectedUnseenRows.size > 0 && (
                      <button
                        type="button"
                        onClick={() => deleteUnseenEntries([...selectedUnseenRows])}
                        className="text-xs font-semibold text-rose-600 hover:text-rose-800 transition-colors"
                      >
                        Delete selected ({selectedUnseenRows.size})
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-1.5">
                    Titles you rated without having seen yet — saved to watchlist or marked not interested.
                  </p>
                </div>
                <ul className="divide-y divide-zinc-50">
                  {sortedUnseen.map((e, i) => {
                    const chName = channelMap.get(e.channelId);
                    return (
                      <li
                        key={`unseen-${e.title}-${e.at}-${e.kind}-${i}`}
                        className={`px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 transition-colors ${
                          selectedUnseenRows.has(i) ? "bg-indigo-50" : "hover:bg-zinc-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedUnseenRows.has(i)}
                          onChange={(ev) => {
                            setSelectedUnseenRows((prev) => {
                              const next = new Set(prev);
                              if (ev.target.checked) next.add(i);
                              else next.delete(i);
                              return next;
                            });
                          }}
                          className="accent-indigo-600 shrink-0"
                        />
                        {e.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={e.posterUrl}
                            alt={e.title}
                            referrerPolicy="no-referrer"
                            className="w-7 h-10 rounded object-cover flex-shrink-0"
                          />
                        ) : (
                          <div className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-zinc-800 truncate block">{e.title}</span>
                          <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                            <span>{e.type === "tv" ? "TV" : "Film"}</span>
                            {chName && <span className="text-zinc-500">· {chName}</span>}
                            <span
                              className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                                e.kind === "want"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-zinc-100 text-zinc-600"
                              }`}
                            >
                              {e.kind === "want"
                                ? watchlistKeys.has(canonicalTitleKey(e.title))
                                  ? "Added"
                                  : "Not on list"
                                : "Not interested"}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2 shrink-0">
                          <div className="w-20 flex justify-end">
                            <StaticStars rating={migrateRatingValue(e.interestStars)} color="blue" />
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteUnseenEntries([i])}
                            className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0"
                            title="Delete this entry"
                            aria-label="Delete"
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
