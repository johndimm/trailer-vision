"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type { WatchlistEntry } from "../page";
import { canonicalTitleKey, entryMatchesChannel, loadUnseenInterestLog, saveUnseenInterestLog } from "../lib/unseenInterestLog";
import { loadRatingHistory, saveRatingHistory, type StoredRatingEntry } from "../lib/storageKeys";
import { Channel, normalizeChannel, ALL_CHANNEL, CHANNELS_KEY, ACTIVE_CHANNEL_KEY } from "../channels/page";
import HistoryView from "../components/HistoryView";
import type { UnseenInterestEntry } from "../lib/unseenInterestLog";

const WATCHLIST_KEY = "movie-recs-watchlist";
const SKIPPED_KEY = "movie-recs-skipped";
const NOT_INTERESTED_KEY = "movie-recs-not-interested";
const SETTINGS_KEY = "movie-recs-settings";

function readLlm(): string {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    const o = s ? JSON.parse(s) as { llm?: string } : {};
    return typeof o.llm === "string" && o.llm ? o.llm : "deepseek";
  } catch { return "deepseek"; }
}

export default function ChannelHistoryPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<StoredRatingEntry[]>([]);
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [minPromoteStars, setMinPromoteStars] = useState(3.5);
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(CHANNELS_KEY);
        let chs: Channel[] = raw ? (JSON.parse(raw) as Channel[]).map(normalizeChannel) : [];
        if (!chs.find((c) => c.id === "all")) chs = [ALL_CHANNEL, ...chs];
        setChannels(chs);
        const urlParam = new URLSearchParams(window.location.search).get("channel");
        const stored = localStorage.getItem(ACTIVE_CHANNEL_KEY);
        const id = (urlParam && chs.find((c) => c.id === urlParam)) ? urlParam
          : (stored && chs.find((c) => c.id === stored)) ? stored
          : chs[0]?.id ?? null;
        setSelectedId(id);
        setHistory(loadRatingHistory());
        setUnseenLog(loadUnseenInterestLog());
      } catch {}
      setMounted(true);
    });
  }, []);

  const selected = channels.find((c) => c.id === selectedId) ?? null;

  // Slice history and unseenLog to just the selected channel
  const channelHistory = useMemo(() => {
    if (!selected) return [];
    return selected.id === "all"
      ? history.filter((h) => !h.channelId || h.channelId === "all")
      : history.filter((h) => h.channelId === selected.id);
  }, [history, selected]);

  const channelUnseen = useMemo(() => {
    if (!selected) return [];
    return unseenLog.filter((e) => entryMatchesChannel(e, selected.id));
  }, [unseenLog, selected]);

  // Deletion: origIndex in channelHistory/channelUnseen must map back to full arrays
  const handleDeleteSeen = useCallback((origIndices: number[]) => {
    // origIndices refer to positions within channelHistory; map back to full history
    const channelEntries = channelHistory;
    const toRemove = new Set(origIndices.map((i) => history.indexOf(channelEntries[i]!)).filter((i) => i >= 0));
    const next = history.filter((_, i) => !toRemove.has(i));
    saveRatingHistory(next);
    setHistory(next);
  }, [history, channelHistory]);

  const handleDeleteUnseen = useCallback((origIndices: number[]) => {
    const channelEntries = channelUnseen;
    const toRemove = new Set(origIndices.map((i) => unseenLog.indexOf(channelEntries[i]!)).filter((i) => i >= 0));
    const next = unseenLog.filter((_, i) => !toRemove.has(i));
    saveUnseenInterestLog(next);
    setUnseenLog(next);
  }, [unseenLog, channelUnseen]);

  const handleUpdateRating = useCallback((title: string, newRating: number | null) => {
    const next = history.map((h) => {
      if (h.title !== title) return h;
      const error = newRating ? Math.abs(newRating - h.predictedRating) : 0;
      return { ...h, userRating: newRating, error };
    });
    saveRatingHistory(next);
    setHistory(next);
  }, [history]);

  const handleUpdateUnseen = useCallback((title: string, newRating: number | null) => {
    const next = unseenLog.map((e) => {
      if (e.title !== title) return e;
      return { ...e, interestStars: newRating };
    });
    saveUnseenInterestLog(next);
    setUnseenLog(next);
  }, [unseenLog]);

  const promoteMatchCount = useMemo(() => {
    if (!mounted || !selected) return 0;
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      const wl: { title: string }[] = wlRaw ? JSON.parse(wlRaw) : [];
      const keys = new Set(wl.map((w) => canonicalTitleKey(w.title)));
      return channelUnseen.filter((e) => !keys.has(canonicalTitleKey(e.title)) && (e.interestStars ?? 0) >= minPromoteStars).length;
    } catch { return 0; }
  }, [mounted, selected, channelUnseen, minPromoteStars]);

  const addToWatchlist = useCallback(() => {
    if (!selected) return;
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      let wl: WatchlistEntry[] = wlRaw ? JSON.parse(wlRaw) : [];
      const wlKeys = new Set(wl.map((w) => canonicalTitleKey(w.title)));
      const candidates = channelUnseen.filter((e) => !wlKeys.has(canonicalTitleKey(e.title)) && (e.interestStars ?? 0) >= minPromoteStars);
      if (!candidates.length) { setPromoteMessage("No matching titles."); setTimeout(() => setPromoteMessage(null), 4000); return; }
      const llm = readLlm();
      const now = new Date().toISOString();
      for (const e of candidates) {
        wl = [{ title: e.title, type: e.type, year: e.year, director: e.director, actors: e.actors, plot: e.plot, posterUrl: e.posterUrl, rtScore: e.rtScore, streaming: [], addedAt: now }, ...wl.filter((w) => w.title !== e.title)];
        wlKeys.add(canonicalTitleKey(e.title));
      }
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(wl));
      const skipOnly = candidates.filter((c) => c.kind === "skip");
      if (skipOnly.length) {
        const rm = new Set(skipOnly.map((c) => canonicalTitleKey(c.title)));
        const sk: string[] = JSON.parse(localStorage.getItem(SKIPPED_KEY) ?? "[]");
        localStorage.setItem(SKIPPED_KEY, JSON.stringify(sk.filter((t) => !rm.has(canonicalTitleKey(t)))));
        const ni: { title: string }[] = JSON.parse(localStorage.getItem(NOT_INTERESTED_KEY) ?? "[]");
        localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(ni.filter((x) => !rm.has(canonicalTitleKey(x.title)))));
      }
      setPromoteMessage(`Added ${candidates.length} title${candidates.length === 1 ? "" : "s"} to watchlist.`);
      setTimeout(() => setPromoteMessage(null), 8000);
      setUnseenLog(loadUnseenInterestLog());
      for (const e of candidates) {
        void fetch("/api/streaming", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: e.title, year: e.year, llm }) })
          .then((r) => r.ok ? r.json() : { services: [] })
          .then(({ services }: { services: string[] }) => {
            if (!services.length) return;
            const r2 = localStorage.getItem(WATCHLIST_KEY);
            const w2: WatchlistEntry[] = r2 ? JSON.parse(r2) : [];
            localStorage.setItem(WATCHLIST_KEY, JSON.stringify(w2.map((w) => w.title === e.title ? { ...w, streaming: services } : w)));
          }).catch(() => {});
      }
    } catch { setPromoteMessage("Could not update watchlist."); setTimeout(() => setPromoteMessage(null), 5000); }
  }, [selected, channelUnseen, minPromoteStars]);

  const toolbarSlot = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5">
        <select value={String(minPromoteStars)} onChange={(e) => setMinPromoteStars(Number(e.target.value))}
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700" title="Min interest stars">
          {[2.5, 3, 3.5, 4, 4.5].map((n) => <option key={n} value={String(n)}>{n}★ min</option>)}
        </select>
        <button type="button" onClick={addToWatchlist} disabled={promoteMatchCount === 0}
          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
          + Watchlist ({promoteMatchCount})
        </button>
      </div>
      {promoteMessage && <span className="text-xs font-medium text-green-700">{promoteMessage}</span>}
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/history" className="text-sm text-zinc-500 hover:text-zinc-800 transition-colors">← History</Link>
            <h1 className="text-xl font-bold text-zinc-900">Channel History</h1>
            {channels.length > 1 && (
              <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {channels.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
              </select>
            )}
          </div>
          {selected && selected.id !== "all" && (
            <Link href={`/channels?select=${selected.id}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
              Edit channel →
            </Link>
          )}
        </div>

        {!selected ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">No channel selected.</div>
        ) : (
          <HistoryView
            history={channelHistory}
            unseenLog={channelUnseen}
            onDeleteSeen={handleDeleteSeen}
            onDeleteUnseen={handleDeleteUnseen}
            onUpdateRating={handleUpdateRating}
            onUpdateUnseen={handleUpdateUnseen}
            toolbarSlot={toolbarSlot}
            emptyMessage="No activity in this channel yet."
          />
        )}
      </div>
    </div>
  );
}
