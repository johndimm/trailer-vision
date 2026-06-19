"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
import HistoryView from "../components/HistoryView";

const PLAY_KEY = "movie-recs-play";
const PLAYLIST_KEY = "movie-recs-playlist";

export default function HistoryPage() {
  const pathname = usePathname();
  const router = useRouter();
  const [history, setHistory] = useState<StoredRatingEntry[]>([]);
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);

  const refresh = useCallback(() => {
    if (!canUseLocalStorage()) { setStorageBlocked(true); setHydrated(true); return; }
    setStorageBlocked(false);
    setHistory(loadRatingHistory());
    setUnseenLog(loadUnseenInterestLog());
    try {
      const ch = localStorage.getItem(CHANNELS_KEY);
      if (ch) setChannels((JSON.parse(ch) as Channel[]).map(normalizeChannel));
    } catch {}
    setHydrated(true);
  }, []);

  useLayoutEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    refresh();
    const onRefresh = () => refresh();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("storage", onRefresh);
    const onVisible = () => { if (document.visibilityState === "visible") onRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("storage", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useEffect(() => { if (pathname === "/history") refresh(); }, [pathname, refresh]);

  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of channels) m.set(ch.id, ch.name);
    return m;
  }, [channels]);

  const handleDeleteSeen = useCallback((origIndices: number[]) => {
    const toRemove = new Set(origIndices);
    const next = history.filter((_, i) => !toRemove.has(i));
    saveRatingHistory(next);
    setHistory(next);
  }, [history]);

  const handleDeleteUnseen = useCallback((origIndices: number[]) => {
    const toRemove = new Set(origIndices);
    const next = unseenLog.filter((_, i) => !toRemove.has(i));
    saveUnseenInterestLog(next);
    setUnseenLog(next);
  }, [unseenLog]);

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

  const handlePlayMovie = useCallback((entry: StoredRatingEntry | UnseenInterestEntry) => {
    localStorage.setItem(PLAY_KEY, JSON.stringify(entry));
    router.push("/");
  }, [router]);

  const handlePlayPlaylist = useCallback((entries: (StoredRatingEntry | UnseenInterestEntry)[]) => {
    const movies = entries.map((e) => ({
      title: e.title,
      type: e.type,
      year: (e as UnseenInterestEntry).year ?? null,
      director: (e as UnseenInterestEntry).director ?? null,
      predictedRating: (e as StoredRatingEntry).predictedRating ?? 3,
      actors: (e as UnseenInterestEntry).actors ?? [],
      plot: (e as UnseenInterestEntry).plot ?? "",
      posterUrl: e.posterUrl ?? null,
      trailerKey: null,
      rtScore: (e as StoredRatingEntry).rtScore ?? null,
      reason: null,
      streaming: [],
      categories: (e as StoredRatingEntry).categories,
    }));
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify(movies));
    router.push("/");
  }, [router]);

  const totalCount = history.length + unseenLog.length;

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold text-zinc-900">History</h1>
          <Link href="/channel-history" className="text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
            By channel →
          </Link>
        </div>

        {storageBlocked ? (
          <div className="bg-white rounded-2xl border border-amber-200 shadow-sm p-8 text-center text-sm text-zinc-600 space-y-2">
            <p className="font-medium text-zinc-800">Browser storage isn&apos;t available here</p>
            <p>Open Trailer Vision in its own tab to keep ratings.</p>
          </div>
        ) : !hydrated ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">Loading history…</div>
        ) : totalCount === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm space-y-2">
            <p>No activity yet. Rate titles on the Player page — red stars for seen, blue for unseen.</p>
            <p className="text-xs">History stays in this browser. Use Settings → Export backup to move data between devices.</p>
          </div>
        ) : (
          <HistoryView
            history={history}
            unseenLog={unseenLog}
            onDeleteSeen={handleDeleteSeen}
            onDeleteUnseen={handleDeleteUnseen}
            onUpdateRating={handleUpdateRating}
            onUpdateUnseen={handleUpdateUnseen}
            onPlayMovie={handlePlayMovie}
            onPlayPlaylist={handlePlayPlaylist}
            channelMap={channelMap}
          />
        )}
      </div>
    </div>
  );
}
