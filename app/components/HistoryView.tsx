"use client";

import { useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { StaticStars } from "./Stars";
import { EditableStars } from "./EditableStars";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";
import { canonicalTitleKey } from "../lib/canonicalTitleKey";
import { type StoredRatingEntry } from "../lib/storageKeys";
import { type UnseenInterestEntry } from "../lib/unseenInterestLog";

const WATCHLIST_KEY = "movie-recs-watchlist";
const PLAY_KEY = "movie-recs-play";

export type SeenRow   = { kind: "seen";   entry: StoredRatingEntry;  origIndex: number; sortKey: string };
export type UnseenRow = { kind: "unseen"; entry: UnseenInterestEntry; origIndex: number; sortKey: string };
export type UnifiedRow = SeenRow | UnseenRow;

type SortField = "time" | "title" | "rating" | "delta";
type FilterKind = "all" | "rated" | "unseen" | "unrated";

export interface HistoryViewProps {
  /** Full history array — origIndex refers to positions here. */
  history: StoredRatingEntry[];
  /** Full unseen log — origIndex refers to positions here. */
  unseenLog: UnseenInterestEntry[];
  onDeleteSeen: (origIndices: number[]) => void;
  onDeleteUnseen: (origIndices: number[]) => void;
  /** Optional callback to update a seen rating. */
  onUpdateRating?: (title: string, newRating: number | null) => void;
  /** Optional callback to update an unseen interest rating. */
  onUpdateUnseen?: (title: string, newRating: number | null) => void;
  /** Optional callback to play a movie. */
  onPlayMovie?: (entry: StoredRatingEntry | UnseenInterestEntry) => void;
  /** Optional channel map for displaying channel names. */
  channelMap?: Map<string, string>;
  /** Extra content rendered inside the toolbar card (above the filter row). */
  toolbarSlot?: ReactNode;
  emptyMessage?: string;
}

export default function HistoryView({
  history,
  unseenLog,
  onDeleteSeen,
  onDeleteUnseen,
  onUpdateRating,
  onUpdateUnseen,
  onPlayMovie,
  channelMap,
  toolbarSlot,
  emptyMessage = "No activity yet.",
}: HistoryViewProps) {
  const router = useRouter();
  const [sortField, setSortField] = useState<SortField>("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [watchlistKeys, setWatchlistKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      const wl: { title: string }[] = wlRaw ? JSON.parse(wlRaw) : [];
      setWatchlistKeys(new Set(wl.map((w) => canonicalTitleKey(w.title))));
    } catch {
      setWatchlistKeys(new Set());
    }
  }, [unseenLog]);

  const unified = useMemo((): UnifiedRow[] => {
    const seenRows: SeenRow[] = history.map((entry, i) => ({
      kind: "seen",
      entry,
      origIndex: i,
      sortKey: entry.presentedAt ?? `0000-${String(i).padStart(6, "0")}`,
    }));
    const unseenRows: UnseenRow[] = unseenLog.map((entry, i) => ({
      kind: "unseen",
      entry,
      origIndex: i,
      sortKey: entry.at,
    }));

    let all: UnifiedRow[] = [...seenRows, ...unseenRows];

    if (filter === "rated")   all = all.filter((r) => r.kind === "seen" && r.entry.userRating !== null);
    if (filter === "unseen")  all = all.filter((r) => r.kind === "unseen");
    if (filter === "unrated") all = all.filter((r) => r.kind === "seen" && (r.entry as StoredRatingEntry).userRating === null);

    all.sort((a, b) => {
      let cmp = 0;
      if (sortField === "time") {
        cmp = a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
      } else if (sortField === "title") {
        cmp = a.entry.title.localeCompare(b.entry.title);
      } else if (sortField === "rating") {
        const av = a.kind === "seen" ? (a.entry.userRating ?? -1) : ((a.entry as UnseenInterestEntry).interestStars ?? -1);
        const bv = b.kind === "seen" ? (b.entry.userRating ?? -1) : ((b.entry as UnseenInterestEntry).interestStars ?? -1);
        cmp = av - bv;
      } else {
        const ad = a.kind === "seen" ? starDelta(a.entry.userRating ?? 0, (a.entry as StoredRatingEntry).predictedRating) : -99;
        const bd = b.kind === "seen" ? starDelta(b.entry.userRating ?? 0, (b.entry as StoredRatingEntry).predictedRating) : -99;
        cmp = ad - bd;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return all;
  }, [history, unseenLog, filter, sortField, sortDir]);

  const rowKey = (row: UnifiedRow) => `${row.kind}-${row.origIndex}`;

  const deleteSelected = useCallback(() => {
    const seenSet = new Set<number>();
    const unseenSet = new Set<number>();
    for (const k of selectedKeys) {
      if (k.startsWith("seen-"))   seenSet.add(Number(k.slice(5)));
      if (k.startsWith("unseen-")) unseenSet.add(Number(k.slice(7)));
    }
    if (seenSet.size)   onDeleteSeen([...seenSet]);
    if (unseenSet.size) onDeleteUnseen([...unseenSet]);
    setSelectedKeys(new Set());
  }, [selectedKeys, onDeleteSeen, onDeleteUnseen]);

  const deleteSingle = useCallback((row: UnifiedRow) => {
    if (row.kind === "seen")   onDeleteSeen([row.origIndex]);
    else                       onDeleteUnseen([row.origIndex]);
    setSelectedKeys((prev) => { const s = new Set(prev); s.delete(rowKey(row)); return s; });
  }, [onDeleteSeen, onDeleteUnseen]);

  const total = unified.length;
  const ratedCount   = history.filter((e) => e.userRating !== null).length;
  const unseenCount  = unseenLog.length;
  const unratedCount = history.filter((e) => e.userRating === null).length;

  const SortBtn = ({ field, label }: { field: SortField; label: string }) => (
    <button type="button"
      onClick={() => {
        if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        else { setSortField(field); setSortDir(field === "title" ? "asc" : "desc"); }
      }}
      className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        sortField === field ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
      }`}
    >
      {label}
      {sortField === field && <span className="text-xs opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>}
    </button>
  );

  const FilterBtn = ({ value, label }: { value: FilterKind; label: string }) => (
    <button type="button" onClick={() => setFilter(filter === value ? "all" : value)}
      className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
        filter === value
          ? "bg-zinc-900 border-zinc-800 text-white"
          : "border-zinc-300 text-zinc-500 hover:text-zinc-900 hover:border-zinc-500"
      }`}
    >
      {label}
    </button>
  );

  if (history.length === 0 && unseenLog.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/80 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input type="checkbox" aria-label="Select all"
              checked={selectedKeys.size === total && total > 0}
              onChange={(ev) => {
                if (ev.target.checked) setSelectedKeys(new Set(unified.map(rowKey)));
                else setSelectedKeys(new Set());
              }}
              className="accent-indigo-600"
            />
            <span className="text-xs font-semibold text-zinc-600">
              {ratedCount} rated · {unseenCount} unseen{unratedCount > 0 ? ` · ${unratedCount} not rated` : ""}
            </span>
          </div>
          {selectedKeys.size > 0 && (
            <button type="button" onClick={deleteSelected}
              className="text-xs font-semibold text-rose-600 hover:text-rose-800 transition-colors">
              Delete selected ({selectedKeys.size})
            </button>
          )}
        </div>

        {toolbarSlot}

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterBtn value="all"     label="All" />
          <FilterBtn value="rated"   label="Rated" />
          <FilterBtn value="unseen"  label="Unseen" />
          <FilterBtn value="unrated" label="Not rated" />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mr-1">Sort</span>
          <SortBtn field="time"   label="Time" />
          <SortBtn field="title"  label="Title" />
          <SortBtn field="rating" label="Rating" />
          <SortBtn field="delta"  label="vs Audience" />
        </div>
      </div>

      {total === 0 ? (
        <div className="px-4 py-8 text-center text-zinc-400 text-sm">No entries match this filter.</div>
      ) : (
        <ul className="divide-y divide-zinc-50">
          {unified.map((row) => {
            const key = rowKey(row);
            const isSel = selectedKeys.has(key);
            const toggle = (ev: React.ChangeEvent<HTMLInputElement>) =>
              setSelectedKeys((prev) => { const s = new Set(prev); ev.target.checked ? s.add(key) : s.delete(key); return s; });
            const liClass = `px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 transition-colors ${isSel ? "bg-indigo-50" : "hover:bg-zinc-50"}`;

            if (row.kind === "seen") {
              const e = row.entry;
              const isRated = e.userRating !== null;
              const d = isRated ? starDelta(e.userRating!, e.predictedRating) : null;
              const chName = e.channelId ? channelMap?.get(e.channelId) : undefined;
              return (
                <li key={key} className={liClass}>
                  <input type="checkbox" checked={isSel} onChange={toggle} className="accent-indigo-600 shrink-0" />
                  {e.posterUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img
                        src={e.posterUrl}
                        alt={e.title}
                        referrerPolicy="no-referrer"
                        className="w-7 h-10 rounded object-cover flex-shrink-0 cursor-pointer hover:opacity-75"
                        onClick={() => onPlayMovie?.(e)}
                      />
                    : <div
                        className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0 cursor-pointer hover:opacity-75"
                        onClick={() => onPlayMovie?.(e)}
                      />}
                  <div className="flex-1 min-w-0">
                    <span
                      className="font-medium text-zinc-800 truncate block cursor-pointer hover:underline"
                      onClick={() => onPlayMovie?.(e)}
                    >
                      {e.title}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                      <span>{e.type === "tv" ? "TV" : "Film"}</span>
                      {chName && <span className="text-zinc-500">· {chName}</span>}
                      {e.watchFrac != null && e.watchFrac > 0 && <span>{Math.round(e.watchFrac * 100)}% watched</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isRated ? (
                      <>
                        <span className={`w-12 text-right tabular-nums text-sm font-semibold ${d! > 0 ? "text-emerald-700" : d! < 0 ? "text-rose-700" : "text-zinc-500"}`} title="Your rating minus predicted">{formatStarDelta(d!)}</span>
                        <div className="w-20 flex justify-end">
                          {onUpdateRating ? (
                            <EditableStars
                              rating={migrateRatingValue(e.userRating!)}
                              color="red"
                              onChange={(newRating) => onUpdateRating(e.title, newRating)}
                              ariaLabel={`Rating for ${e.title}`}
                            />
                          ) : (
                            <StaticStars rating={migrateRatingValue(e.userRating!)} color="red" />
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="w-32 text-right text-xs text-zinc-400">not rated</span>
                    )}
                    <button type="button" onClick={() => deleteSingle(row)}
                      className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0" title="Delete" aria-label="Delete">×</button>
                  </div>
                </li>
              );
            }

            const e = row.entry;
            const chName = channelMap?.get(e.channelId);
            return (
              <li key={key} className={liClass}>
                <input type="checkbox" checked={isSel} onChange={toggle} className="accent-indigo-600 shrink-0" />
                {e.posterUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img
                      src={e.posterUrl}
                      alt={e.title}
                      referrerPolicy="no-referrer"
                      className="w-7 h-10 rounded object-cover flex-shrink-0 cursor-pointer hover:opacity-75"
                      onClick={() => onPlayMovie?.(e)}
                    />
                  : <div
                      className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0 cursor-pointer hover:opacity-75"
                      onClick={() => onPlayMovie?.(e)}
                    />}
                <div className="flex-1 min-w-0">
                  <span
                    className="font-medium text-zinc-800 truncate block cursor-pointer hover:underline"
                    onClick={() => onPlayMovie?.(e)}
                  >
                    {e.title}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                    <span>{e.type === "tv" ? "TV" : "Film"}</span>
                    {chName && <span className="text-zinc-500">· {chName}</span>}
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${e.kind === "want" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>
                      {e.kind === "want" ? watchlistKeys.has(canonicalTitleKey(e.title)) ? "Added" : "Not on list" : "Not interested"}
                    </span>
                    {e.watchFrac != null && e.watchFrac > 0 && <span>{Math.round(e.watchFrac * 100)}% watched</span>}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 shrink-0">
                  <div className="w-20 flex justify-end">
                    {onUpdateUnseen ? (
                      <EditableStars
                        rating={e.interestStars ? migrateRatingValue(e.interestStars) : null}
                        color="blue"
                        onChange={(newRating) => onUpdateUnseen(e.title, newRating)}
                        ariaLabel={`Interest rating for ${e.title}`}
                      />
                    ) : (
                      <StaticStars rating={e.interestStars ? migrateRatingValue(e.interestStars) : 0} color="blue" />
                    )}
                  </div>
                  <button type="button" onClick={() => deleteSingle(row)}
                    className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0" title="Delete" aria-label="Delete">×</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
