"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useId, useMemo, memo } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import type { Channel } from "./channels/page";
import { ALL_CHANNEL, normalizeChannel, CHANNELS_KEY, ACTIVE_CHANNEL_KEY } from "./channels/page";
import { insertChannelAfterAll, hydrateChannelsOnLoad, normalizeChannelList } from "./lib/channelBulkActions";
import { channelDraftFromPrompt } from "./lib/channelFromPrompt";
import { queueNewChannelFromGraphNode } from "./lib/newChannelFromGraphNode";
import {
  queueNewChannelFromMovie,
} from "./lib/queueNewChannelFromMovie";
import type { MovieChannelSeedInput } from "./lib/movieToChannelSeeds";
import RTBadge from "./components/RTBadge";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { clampStarRating, migrateRatingValue } from "./lib/ratingScale";
import {
  LEGACY_PREFETCH_QUEUE_KEY,
  prefetchQueueStorageKey,
  currentMovieStorageKey,
  clearChannelPersistedData,
} from "./lib/storageKeys";
import {
  applyFactoryBootstrap,
  hasNoChannelsPersisted,
  isFactoryStarterPackFullyMerged,
  mergeFactoryChannelsAndQueues,
} from "./lib/factoryChannels";
import { canonicalTitleKey } from "./lib/canonicalTitleKey";
import { filmWorkSearchTerm } from "./lib/filmWorkSearchTerm";
import TrailerVisionConstellationsEmbed from "./components/TrailerVisionConstellationsEmbed";
import { pushUnseenInterestEntry, loadUnseenInterestLog, type UnseenInterestEntry } from "./lib/unseenInterestLog";
import { safeSetItem } from "./lib/storageKeys";

function migrateRatingEntry(e: RatingEntry): RatingEntry {
  if (e.userRating === null) return e;
  const u = migrateRatingValue(e.userRating);
  const p = migrateRatingValue(e.predictedRating);
  return { ...e, userRating: u, predictedRating: p, error: Math.abs(u - p) };
}

// ── YouTube IFrame API minimal type shim ──────────────────────────────────────
declare global {
  interface Window {
    YT: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, unknown>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number; target: YTPlayer }) => void;
            /** 2 invalid param, 5 HTML5, 100 not found/removed, 101/150 embed not allowed */
            onError?: (e: { data: number; target: YTPlayer }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getVolume(): number;
  isMuted(): boolean;
  setVolume(v: number): void;
  unMute(): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  seekTo?(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
  getPlayerState?(): number;
  playVideo?(): void;
}

// Loads https://www.youtube.com/iframe_api once; resolves when YT.Player is available.
let _ytApiLoaded = false;
let _ytApiReady = false;
const _ytReadyCallbacks: Array<() => void> = [];

function flushYtReady() {
  if (!window.YT?.Player) return;
  if (_ytApiReady) return;
  _ytApiReady = true;
  _ytReadyCallbacks.forEach((cb) => cb());
  _ytReadyCallbacks.length = 0;
}

function loadYouTubeApi(): Promise<void> {
  return new Promise((resolve) => {
    if (_ytApiReady && window.YT?.Player) {
      resolve();
      return;
    }
    _ytReadyCallbacks.push(resolve);
    if (_ytApiLoaded) {
      // Script tag already injected but callback may be delayed or blocked -- poll for YT.
      const t = window.setInterval(() => {
        if (window.YT?.Player) {
          window.clearInterval(t);
          flushYtReady();
        }
      }, 50);
      window.setTimeout(() => window.clearInterval(t), 20_000);
      return;
    }
    _ytApiLoaded = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      flushYtReady();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    // If the script was cached and YT appears before the global callback runs.
    window.setTimeout(() => {
      if (window.YT?.Player) flushYtReady();
    }, 0);
  });
}

/** Server merges full rating list in memory; client avoids resending it every request (delta / reuse). */
const LS_LLM_SESSION = "movie-recs-llm-session-id";
const LS_LLM_SYNCED = "movie-recs-llm-history-synced";

function getLlmSessionId(): string {
  let id = localStorage.getItem(LS_LLM_SESSION);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_LLM_SESSION, id);
  }
  return id;
}

function getSyncedRatingCount(): number {
  const n = Number.parseInt(localStorage.getItem(LS_LLM_SYNCED) || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function setSyncedRatingCount(n: number) {
  localStorage.setItem(LS_LLM_SYNCED, String(n));
}

function buildHistorySyncPayload(hist: RatingEntry[]): Record<string, unknown> {
  const sessionId = getLlmSessionId();
  let synced = getSyncedRatingCount();
  if (synced > hist.length) synced = 0;

  if (hist.length === 0) {
    return { sessionId, historySync: "full", history: [] };
  }
  if (synced === 0) {
    return { sessionId, historySync: "full", history: hist };
  }
  if (synced < hist.length) {
    return {
      sessionId,
      historySync: "delta",
      baseLength: synced,
      historyAppend: hist.slice(synced),
    };
  }
  return {
    sessionId,
    historySync: "reuse",
    baseLength: hist.length,
  };
}

export interface RatingEntry {
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
  presentedAt?: string;
  /** Genre/category tags assigned by the LLM at recommendation time */
  categories?: string[];
}

function getHistoryEntryForTitle(hist: RatingEntry[], title: string): RatingEntry | undefined {
  const key = canonicalTitleKey(title);
  for (let i = hist.length - 1; i >= 0; i--) {
    if (canonicalTitleKey(hist[i]!.title) === key) return hist[i];
  }
  return undefined;
}

type DisplayRating = { stars: number; mode: "seen" | "unseen" };

function getDisplayRatingForTitle(
  title: string,
  hist: RatingEntry[],
  session: Record<string, DisplayRating>,
  unseenLog: UnseenInterestEntry[],
): DisplayRating | undefined {
  const key = canonicalTitleKey(title);
  const fromHist = getHistoryEntryForTitle(hist, title);
  if (fromHist?.userRating != null && fromHist.userRating > 0) {
    return {
      stars: fromHist.userRating,
      mode: fromHist.ratingMode === "unseen" ? "unseen" : "seen",
    };
  }
  const fromSession = session[key];
  if (fromSession && fromSession.stars > 0) return fromSession;
  for (let i = unseenLog.length - 1; i >= 0; i--) {
    const e = unseenLog[i]!;
    if (canonicalTitleKey(e.title) === key && e.interestStars > 0) {
      return { stars: e.interestStars, mode: "unseen" };
    }
  }
  return undefined;
}

interface CurrentMovie {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  predictedRating: number;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  trailerKey: string | null;
  rtScore: string | null;
  reason: string | null;
  streaming?: string[];
  categories?: string[];
}

export interface WatchlistEntry {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
  streaming: string[];
  addedAt: string;
}

/** Titles per LLM POST (server max is 8). */
const LLM_BATCH_SIZE = 5;
/** Max concurrent LLM fetches while filling the upcoming queue. */
const MAX_REPLENISH_IN_FLIGHT = 2;
/** Cap upcoming queue length; daisy-chain stops at this depth (target ~5–10 visible). */
const HIGH_WATER_MARK = 8;

/**
 * Rotating lenses that force the LLM to explore different corners of cinema on each batch.
 * Without this it defaults to the same few hundred popular titles.
 */
const DIVERSITY_LENSES = [
  "films from the 1940s or 1950s",
  "films from the 1960s or 1970s",
  "films from the 1980s",
  "films from the 1990s",
  "films from the 2000s",
  "films from the 2010s or 2020s",
  "non-English language films (French, Italian, Spanish, German, etc.)",
  "Japanese cinema (anime or live-action)",
  "South Korean cinema",
  "Bollywood or Indian cinema (Hindi, Tamil, Bengali, or other Indian-language films)",
  "Persian / Iranian cinema",
  "Scandinavian or Eastern European cinema",
  "Latin American or Middle Eastern or African cinema",
  "British cinema",
  "documentary films",
  "horror or psychological thriller",
  "science fiction or speculative fiction",
  "comedy or satire",
  "animation (any country, any era)",
  "cult classics or midnight movies",
  "festival darlings (Cannes, Venice, Sundance, TIFF)",
  "overlooked or underseen gems with low name recognition",
  "director-driven auteur films",
  "crime, noir, or heist films",
  "war films or historical epics",
  "romance or coming-of-age stories",
];

/** YouTube search for clips when the card has no embedded trailer (poster-only layout). */
function youtubeSearchUrlForMovie(title: string, type: "movie" | "tv", year: number | null): string {
  const q = [title, year != null ? String(year) : null, type === "tv" ? "TV series trailer" : "movie trailer"]
    .filter(Boolean)
    .join(" ");
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

function MovieTitleChannelLink({
  movie,
  onCreateChannel,
  headingClassName,
}: {
  movie: MovieChannelSeedInput & { trailerKey?: string | null };
  onCreateChannel: (movie: MovieChannelSeedInput) => void;
  headingClassName: string;
}) {
  return (
    <h2 className={headingClassName}>
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onCreateChannel(movie)}
          title="Create a channel from this title"
          className="min-w-0 break-words text-left hover:text-indigo-400 transition-colors"
        >
          {movie.title}
        </button>
        {!movie.trailerKey && (
          <a
            href={youtubeSearchUrlForMovie(movie.title, movie.type, movie.year ?? null)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-sm text-zinc-400 hover:text-indigo-400"
            aria-label={`Search YouTube for ${movie.title} trailer`}
          >
            ↗
          </a>
        )}
      </span>
    </h2>
  );
}

function loadCurrentMovieForChannel(channelId: string): CurrentMovie | null {
  try {
    const raw = localStorage.getItem(currentMovieStorageKey(channelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CurrentMovie & { savedForChannelId?: string };
    if (!parsed?.title) return null;
    // Drop entries from before channel tagging, or cross-saved by the old persist-on-switch bug.
    if (parsed.savedForChannelId !== channelId) return null;
    const { savedForChannelId: _tag, ...movie } = parsed;
    return movie;
  } catch {
    return null;
  }
}

function persistCurrentMovieForChannel(channelId: string, movie: CurrentMovie | null): void {
  if (!channelId?.trim()) return;
  try {
    const key = currentMovieStorageKey(channelId);
    if (movie?.title) {
      localStorage.setItem(key, JSON.stringify({ ...movie, savedForChannelId: channelId }));
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

const STORAGE_KEY = "movie-recs-history";
const SKIPPED_KEY = "movie-recs-skipped";
/** Titles advanced with "Next" -- excluded from picks, not a rating or "not interested". */
const PASSED_KEY = "movie-recs-passed";
const WATCHLIST_KEY = "movie-recs-watchlist";
const NOTSEEN_KEY = "movie-recs-notseen";
const NOT_INTERESTED_KEY = "movie-recs-not-interested"; // {title, rtScore}[] for high-RT taste signal
const TASTE_SUMMARY_KEY = "movie-recs-taste-summary";   // string: LLM's running taste profile
const SETTINGS_KEY = "movie-recs-settings";
const RECONSIDER_KEY = "movie-recs-reconsider";
/** Per channel + title: last trailer watch position (0–1) when you leave the channel, restored when you return. */
const TRAILER_RESUME_KEY = "movie-recs-trailer-resume-frac";

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return fallback;
    const obj = JSON.parse(s);
    return key in obj ? (obj[key] as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: unknown): void {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    const obj = s ? (JSON.parse(s) as Record<string, unknown>) : {};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...obj, [key]: value }));
  } catch {}
}

interface NotSeenEvent {
  afterRating: number;
  kind: "want" | "skip";
}

/** Resolve mouse/touch X position within a button to a half-star value (0.5 increments). */
function halfStarValue(clientX: number, rect: DOMRect, n: number): number {
  return clientX - rect.left < rect.width / 2 ? n - 0.5 : n;
}

/** A row of 5 clickable stars supporting half-star precision. */
const StarRow = memo(function StarRow({
  filled,
  color,
  label,
  onRate,
  compact = false,
  /** Smaller controls when Prev/Next share the row (mobile) -- keeps stars from overlapping */
  careerNavTight = false,
  hideLabel = false,
}: {
  filled: number;
  color: "red" | "blue";
  label: string;
  onRate: (stars: number) => void;
  /** Tighter label + stars for single-line toolbar layout */
  compact?: boolean;
  careerNavTight?: boolean;
  /** Fullscreen toolbar: mode comes from Interest/Rating segment, not a second label. */
  hideLabel?: boolean;
}) {
  const [hover, setHover] = useState(0);
  /** Value from last click -- keeps stars lit after pointer leaves (hover clears on mouseleave). */
  const [committed, setCommitted] = useState(0);
  useEffect(() => {
    setCommitted(filled);
    setHover(0);
  }, [filled]);
  const active = hover || filled || committed;
  const filledColor = color === "red" ? "text-red-500" : "text-blue-500";

  const starSizeClass =
    compact && careerNavTight
      ? "text-2xl sm:text-4xl"
      : compact
        ? "text-5xl sm:text-6xl"
        : "text-3xl";
  const labelClass =
    compact && careerNavTight
      ? "text-left text-xs w-14 sm:w-16 sm:text-sm"
      : compact
        ? "text-left text-sm w-16 sm:w-20 sm:text-base"
        : "text-right text-sm w-28";
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center ${compact ? "justify-center gap-x-2 gap-y-1 sm:gap-x-3 sm:gap-y-0" : "gap-3"}`}
    >
      {!hideLabel && (
        <span
          className={`font-medium text-zinc-200 shrink-0 leading-snug ${labelClass}`}
        >
          {label}
        </span>
      )}
      <div className={`flex min-w-0 shrink items-center ${compact ? "gap-0.5 sm:gap-1" : "gap-1"}`} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            /* pointerdown preventDefault: blocks focus() scroll on tap (mouse + touch); keyboard still uses keydown to focus */
            onPointerDown={(e) => e.preventDefault()}
            onMouseMove={(e) => setHover(halfStarValue(e.clientX, e.currentTarget.getBoundingClientRect(), n))}
            onClick={(e) => {
              const v = halfStarValue(e.clientX, e.currentTarget.getBoundingClientRect(), n);
              setCommitted(v);
              onRate(v);
            }}
            className={`relative leading-none select-none ${starSizeClass}`}
            style={{ touchAction: "manipulation" }}
          >
            <span className="text-zinc-600">★</span>
            {active >= n && (
              <span className={`absolute inset-0 ${filledColor}`}>★</span>
            )}
            {active >= n - 0.5 && active < n && (
              <span className={`absolute inset-0 overflow-hidden ${filledColor}`} style={{ width: "50%" }}>★</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
});

/** Auto-hide fullscreen chrome after idle (YouTube-style). */
const FULLSCREEN_CONTROLS_HIDE_MS = 4000;

/** Compact Interest / Rating toggle for fullscreen toolbar (film-and-music style). */
const SeenModeSegment = memo(function SeenModeSegment({
  value,
  onChange,
  ghost = false,
}: {
  value: "unseen" | null;
  onChange: (v: "unseen" | null) => void;
  /** Transparent overlay styling for fullscreen video. */
  ghost?: boolean;
}) {
  return (
    <div
      className={`inline-flex shrink-0 overflow-hidden rounded-lg border shadow-lg ${
        ghost ? "border-zinc-500 bg-black/80" : "border-zinc-600"
      }`}
      role="group"
      aria-label="Have you seen this title?"
    >
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => onChange("unseen")}
        className={`px-3 py-1.5 text-sm font-semibold transition-colors touch-manipulation min-h-[44px] ${
          value === "unseen"
            ? ghost
              ? "bg-blue-600 text-white"
              : "bg-blue-600 text-white"
            : ghost
              ? "bg-zinc-800/90 text-zinc-200 hover:bg-zinc-700"
              : "bg-transparent text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Interest
      </button>
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => onChange(null)}
        className={`border-l px-3 py-1.5 text-sm font-semibold transition-colors touch-manipulation min-h-[44px] ${
          ghost ? "border-zinc-500" : "border-zinc-600"
        } ${
          value === null
            ? ghost
              ? "bg-red-600 text-white"
              : "bg-red-600 text-white"
            : ghost
              ? "bg-zinc-800/90 text-zinc-200 hover:bg-zinc-700"
              : "bg-transparent text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Rating
      </button>
    </div>
  );
});

const chevronPathNext =
  "M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z";
const chevronPathPrev =
  "M17 10a.75.75 0 01-.75.75H6.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L6.612 9.25H16.25A.75.75 0 0117 10z";

const PassNextButton = memo(function PassNextButton({
  onPass,
  compact = false,
  prominent = false,
  /** Trailer strip: next to star row -- larger than compact, emerald (not indigo poster Next) */
  muted = false,
  /** Fullscreen overlay: text-only ghost on transparent background */
  ghost = false,
  /** Poster / career: match Prev/Next as mirrored pair (icon on outer side). */
  direction = "next",
  disabled = false,
}: {
  onPass: () => void;
  compact?: boolean;
  /** Larger, hero-style -- use when Next is the primary control above the rating row */
  prominent?: boolean;
  muted?: boolean;
  ghost?: boolean;
  direction?: "next" | "prev";
  /** Kept enabled for layout; no-op at start of list (e.g. career first film). */
  disabled?: boolean;
}) {
  const isPrev = direction === "prev";
  const sizing = ghost
    ? "gap-1.5 rounded-lg px-4 py-2.5 text-sm font-medium min-h-[44px] min-w-[5rem] sm:min-w-[5.5rem] sm:px-5"
    : prominent
      ? "gap-2 rounded-xl px-8 py-3.5 text-base font-semibold shadow-lg sm:px-10 sm:py-4 sm:text-lg min-h-[44px] min-w-[5rem]"
      : compact
        ? "gap-1 rounded-lg px-3 py-2 text-xs shadow-md min-h-[44px] min-w-[4.5rem]"
        : muted
          ? "gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium shadow-sm min-h-[36px] min-w-[3.25rem] sm:rounded-xl sm:gap-2 sm:px-5 sm:py-2 sm:text-base sm:min-h-[44px] sm:min-w-[4.5rem]"
          : "gap-2 rounded-xl px-5 py-3 text-sm font-bold shadow-lg sm:px-6 sm:py-3.5 sm:text-base min-h-[44px] min-w-[5rem]";
  const iconClass = prominent
    ? "h-5 w-5 sm:h-6 sm:w-6"
    : compact
      ? "h-4 w-4"
      : ghost
        ? "h-5 w-5"
        : muted
          ? "h-5 w-5"
          : "h-5 w-5";
  const surface = ghost
    ? "border border-zinc-500 bg-zinc-900/95 text-white shadow-lg hover:bg-zinc-800 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-0 focus-visible:ring-offset-black"
    : compact
      ? "border border-zinc-600 bg-zinc-800 text-white hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
      : muted
        ? "border border-emerald-400/40 bg-emerald-600/90 text-white shadow-sm hover:bg-emerald-500 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        : "border-2 border-indigo-200/90 bg-indigo-600 text-white shadow-lg shadow-indigo-950/40 hover:border-white/90 hover:bg-indigo-500 hover:shadow-xl active:scale-[0.98] active:brightness-95 focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900";
  const iconColor = ghost ? "text-white" : muted ? "text-zinc-200" : "text-white";
  const icon = (
    <svg className={`${iconColor} ${iconClass}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d={isPrev ? chevronPathPrev : chevronPathNext} clipRule="evenodd" />
    </svg>
  );
  const label = isPrev ? "Prev" : "Next";
  const nextTitle = isPrev
    ? (disabled ? "First title in this list" : "Previous title")
    : (disabled ? "No more titles in this list" : "Go to the next title");
  const nextAria = isPrev
    ? (disabled ? "No previous title" : "Previous title")
    : (disabled ? "No next title" : "Next title");
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPass}
      className={`inline-flex items-center justify-center shrink-0 touch-manipulation transition-all select-none ${surface} focus-visible:outline-none ${sizing} ${
        disabled ? "cursor-not-allowed opacity-40" : ""
      }`}
      title={nextTitle}
      aria-label={nextAria}
    >
      {isPrev ? (
        <>
          {icon}
          {label}
        </>
      ) : (
        <>
          {label}
          {icon}
        </>
      )}
    </button>
  );
});

/** Native radios: "Seen it" vs "Not yet" -- mutually exclusive, proper keyboard + SR semantics. */
const SeenOrNotRadios = memo(function SeenOrNotRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: "unseen" | null;
  onChange: (v: "unseen" | null) => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0 m-0">
      <legend className="sr-only">Have you seen this title?</legend>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:gap-6">
        <label
          className={`inline-flex cursor-pointer touch-manipulation items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] sm:text-xs font-medium transition-colors ${
            value === null
              ? "border-zinc-600 bg-zinc-800 text-white shadow-sm"
              : "border-transparent text-zinc-500 hover:bg-zinc-800/60"
          }`}
        >
          <input
            type="radio"
            name={name}
            className="h-3.5 w-3.5 shrink-0 accent-zinc-900 sm:h-4 sm:w-4"
            checked={value === null}
            onChange={() => onChange(null)}
          />
          <span>Seen it</span>
        </label>
        <label
          className={`inline-flex cursor-pointer touch-manipulation items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] sm:text-xs font-medium transition-colors ${
            value === "unseen"
              ? "border-zinc-600 bg-zinc-800 text-white shadow-sm"
              : "border-transparent text-zinc-500 hover:bg-zinc-800/60"
          }`}
        >
          <input
            type="radio"
            name={name}
            className="h-3.5 w-3.5 shrink-0 accent-zinc-900 sm:h-4 sm:w-4"
            checked={value === "unseen"}
            onChange={() => onChange("unseen")}
          />
          <span>Not yet</span>
        </label>
      </div>
    </fieldset>
  );
});

// Persists volume across trailer cards (module-level, not localStorage -- session only)
let _lastVolume: number | null = null;

/** Reserves the same space as the loaded movie card so initial fetch does not reflow the layout. */
function MovieCardSkeleton({ mode }: { mode: "trailers" | "posters" }) {
  const ratingBlock = (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 px-2 py-2 sm:px-3 sm:py-2.5">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-700" />
          <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-700" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
          <div className="h-12 w-56 max-w-[min(100%,22rem)] animate-pulse rounded-lg bg-zinc-800 sm:h-14 sm:w-64" />
          <div className="h-10 w-20 animate-pulse rounded-lg bg-zinc-700" />
        </div>
      </div>
    </div>
  );

  if (mode === "trailers") {
    const trailerBarSkeleton = (
      <div className="border-b border-zinc-800/90 bg-zinc-950/60 py-2.5 sm:py-3" aria-hidden>
        <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-2">
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-800" />
            <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-800" />
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="mx-auto h-10 max-w-md flex-1 animate-pulse rounded-lg bg-zinc-800" />
            <div className="h-11 w-20 shrink-0 animate-pulse rounded-xl bg-zinc-800" />
          </div>
        </div>
      </div>
    );
    return (
      <div className="bg-zinc-900" aria-busy="true" aria-label="Loading movie">
        <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-zinc-900">
          <div className="absolute inset-0 animate-pulse bg-zinc-700/50" aria-hidden />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-zinc-500">Loading…</span>
          </div>
        </div>
        {trailerBarSkeleton}
        <div className="flex flex-col gap-4 p-4 sm:pb-6 sm:p-6">
          <div className="flex min-w-0 items-start justify-between gap-3 animate-pulse">
            <div className="min-w-0 flex-1 space-y-3">
              <div className="h-3 w-28 rounded bg-zinc-700" />
              <div className="h-8 max-w-lg rounded bg-zinc-700" />
            </div>
            <div className="flex gap-2 pt-0.5">
              <div className="h-7 w-24 rounded bg-zinc-800" />
              <div className="h-7 w-12 rounded bg-zinc-800" />
            </div>
          </div>
          <div className="space-y-3 animate-pulse">
            <div className="h-4 w-full rounded bg-zinc-800" />
            <div className="h-4 w-full rounded bg-zinc-800" />
            <div className="h-4 w-2/3 rounded bg-zinc-800" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6" aria-busy="true" aria-label="Loading movie">
      <div className="flex gap-4 sm:items-start">
        <div
          className="h-[10.5rem] w-28 shrink-0 animate-pulse rounded-xl bg-zinc-700 sm:h-[18rem] sm:w-48"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-3 animate-pulse">
          <div className="h-3 w-24 rounded bg-zinc-700" />
          <div className="h-8 w-4/5 rounded bg-zinc-700" />
          <div className="h-4 w-full rounded bg-zinc-800" />
          <div className="h-4 w-full rounded bg-zinc-800" />
        </div>
      </div>
      {ratingBlock}
    </div>
  );
}

// ── Home hero (isolated from card state so clicks don’t re-render the banner) ──
const HomeHero = memo(function HomeHero() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 shadow-sm ring-1 ring-black/5" style={{ aspectRatio: "1376 / 614" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/nano-banano-photo.png"
        alt=""
        className="pointer-events-none absolute inset-0 w-full h-full select-none"
        style={{ objectFit: "cover", objectPosition: "center" }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        aria-hidden
        style={{
          background:
            "linear-gradient(to right, rgba(0, 0, 0, 0.55) 0%, rgba(0, 0, 0, 0.2) 45%, transparent 68%)",
        }}
      />
      <div className="absolute inset-0 z-10 flex flex-col justify-center items-start px-4 py-6 sm:px-6 sm:py-8">
        <div className="max-w-xl text-left">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl md:text-4xl [text-shadow:1px_0_0_rgba(0,0,0,0.85),-1px_0_0_rgba(0,0,0,0.85),0_1px_0_rgba(0,0,0,0.85),0_-1px_0_rgba(0,0,0,0.85),1px_1px_0_rgba(0,0,0,0.75),-1px_-1px_0_rgba(0,0,0,0.75),1px_-1px_0_rgba(0,0,0,0.75),-1px_1px_0_rgba(0,0,0,0.75),0_2px_12px_rgba(0,0,0,0.45)]">
            Trailer Vision
          </h1>
          <p className="mt-2 text-base font-semibold leading-snug text-white sm:text-lg [text-shadow:1px_0_0_rgba(0,0,0,0.8),-1px_0_0_rgba(0,0,0,0.8),0_1px_0_rgba(0,0,0,0.8),0_-1px_0_rgba(0,0,0,0.8),1px_1px_0_rgba(0,0,0,0.65),-1px_-1px_0_rgba(0,0,0,0.65),0_1px_10px_rgba(0,0,0,0.4)]">
            Discover great films that are new to you
          </p>
        </div>
      </div>
    </div>
  );
});

const PrefetchQueuePanel = memo(function PrefetchQueuePanel({
  prefetchQueueUi,
  channels,
  activeChannelId,
  onPlayAtIndex,
  onRemoveAtIndex,
  onCreateChannelFromMovie,
}: {
  prefetchQueueUi: CurrentMovie[];
  channels: Channel[];
  activeChannelId: string;
  onPlayAtIndex: (index: number) => void;
  onRemoveAtIndex: (index: number) => void;
  onCreateChannelFromMovie?: (movie: MovieChannelSeedInput) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">Upcoming queue</h2>
        <span className="text-xs text-zinc-500 tabular-nums">
          {prefetchQueueUi.length} title{prefetchQueueUi.length === 1 ? "" : "s"}
          {channels.length > 0 && activeChannelId ? (
            <span className="ml-1.5 inline-flex items-center gap-1 rounded-md bg-indigo-950/80 px-2 py-0.5 ring-1 ring-indigo-500/40">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-300/90">Channel</span>
              <span className="font-semibold text-indigo-100">
                {channels.find((c) => c.id === activeChannelId)?.name ?? "--"}
              </span>
            </span>
          ) : null}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mt-1">
        Click the row to play now; click the title to create a channel. Remove drops it from the list. Saved per channel when Settings backup includes the prefetch queue.
      </p>
      {prefetchQueueUi.length === 0 ? (
        <p className="text-sm text-zinc-500 mt-3">Nothing queued yet -- titles appear here as the model responds.</p>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-700 max-h-56 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800">
          {prefetchQueueUi.map((m, index) => (
            <li
              key={`${canonicalTitleKey(m.title)}-${index}`}
              className="flex items-stretch gap-1 py-1 px-1 text-sm"
            >
              <div className="min-w-0 flex-1 flex flex-col gap-0.5 rounded-lg px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPlayAtIndex(index)}
                    className="shrink-0 rounded px-1 py-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    aria-label={`Play ${m.title} now`}
                    title="Play now"
                  >
                    ▶
                  </button>
                  <div className="min-w-0 flex-1">
                    {onCreateChannelFromMovie ? (
                      <button
                        type="button"
                        onClick={() =>
                          onCreateChannelFromMovie({
                            title: m.title,
                            type: m.type,
                            year: m.year,
                            director: m.director,
                            actors: m.actors,
                            plot: m.plot,
                          })
                        }
                        title="Create a channel from this title"
                        className="min-w-0 truncate font-medium text-zinc-200 text-left hover:text-indigo-400 transition-colors block w-full"
                      >
                        {m.title}
                        {m.year != null && <span className="text-zinc-500 font-normal"> · {m.year}</span>}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-medium" title={m.title}>
                        {m.title}
                        {m.year != null && <span className="text-zinc-500 font-normal"> · {m.year}</span>}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                    {m.type === "tv" ? "TV" : "Film"}
                  </span>
                </div>
                {m.reason && (
                  <p className="text-xs text-zinc-400 line-clamp-2 pl-7">{m.reason}</p>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveAtIndex(index);
                }}
                className="shrink-0 self-center rounded-lg px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-red-900/40 hover:text-red-400 transition-colors"
                aria-label={`Remove ${m.title} from queue`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/** Map 0–1 watch fraction to 0–5 stars in half-star steps; returns 0 until 5% watched. */
function progressToStars(frac: number): number {
  if (frac < 0.05) return 0;
  return Math.round(frac * 5 * 2) / 2;
}

/**
 * When enabled, trailer watch time pre-fills stars and "Next" without a tap can submit that rating.
 * Default off: stars only change when you choose them; "Next" with no pick records pass-without-rating.
 * Enable: set NEXT_PUBLIC_WATCH_PROGRESS_AUTO_RATING=1 (or "true") and rebuild.
 */
const WATCH_PROGRESS_AUTO_RATING =
  process.env.NEXT_PUBLIC_WATCH_PROGRESS_AUTO_RATING === "1" ||
  process.env.NEXT_PUBLIC_WATCH_PROGRESS_AUTO_RATING === "true";

// ── TrailerPlayer ─────────────────────────────────────────────────────────────
/** One iframe per mount; swap trailers with loadVideoById so rapid card changes don't cancel init (black player). */
const TRAILER_RESUME_MIN = 0.02;

const TrailerPlayer = memo(function TrailerPlayer({
  videoId,
  onProgress,
  onPlaybackError,
  resumeFromFraction,
}: {
  videoId: string;
  onProgress?: (frac: number) => void;
  /** Called when the iframe reports an error (removed video, embed disabled, etc.) -- parent should drop trailerKey. */
  onPlaybackError?: () => void;
  /** 0–1. When resuming a channel, seek here once after the video is ready (e.g. last watch point before you switched away). */
  resumeFromFraction?: number;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const videoIdRef = useRef(videoId);
  const onProgressRef = useRef(onProgress);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  const resumeFromFractionRef = useRef(resumeFromFraction);
  const resumeDoneKeyRef = useRef<string | null>(null);
  const errorReportedForVideoIdRef = useRef<string | null>(null);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => { onPlaybackErrorRef.current = onPlaybackError; }, [onPlaybackError]);
  useEffect(() => { resumeFromFractionRef.current = resumeFromFraction; }, [resumeFromFraction]);

  useEffect(() => {
    videoIdRef.current = videoId;
    errorReportedForVideoIdRef.current = null;
    resumeDoneKeyRef.current = null;
  }, [videoId]);

  const tryApplyResume = (target: YTPlayer) => {
    const frac = resumeFromFractionRef.current;
    if (frac === undefined || frac < TRAILER_RESUME_MIN || frac > 0.98) return;
    const id = videoIdRef.current;
    const key = `${id}:${frac.toFixed(3)}`;
    if (resumeDoneKeyRef.current === key) return;
    try {
      const d = target.getDuration();
      if (d > 0 && !Number.isNaN(d)) {
        const sec = Math.min(Math.max(0, frac * d), Math.max(0, d - 0.5));
        target.seekTo?.(sec, true);
        resumeDoneKeyRef.current = key;
        target.playVideo?.();
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const mountEl = document.createElement("div");
    mountEl.style.position = "absolute";
    mountEl.style.inset = "0";
    mountEl.style.backgroundColor = "#000";
    wrapperRef.current?.appendChild(mountEl);

    let cancelled = false;
    let playerInstance: YTPlayer | null = null;

    loadYouTubeApi().then(() => {
      if (cancelled || !mountEl.isConnected) return;
      // Must match the parent page origin (including http://localhost:PORT) so the JS API
      // postMessage targets line up. Omitting it on localhost often triggers www-widgetapi errors.
      const origin =
        typeof window !== "undefined" ? window.location.origin : undefined;
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const allowYtNativeFs =
        /iPhone|iPad|iPod/i.test(ua) ||
        (typeof navigator !== "undefined" &&
          navigator.platform === "MacIntel" &&
          navigator.maxTouchPoints > 1);
      playerInstance = new window.YT.Player(mountEl, {
        videoId: videoIdRef.current,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          fs: allowYtNativeFs ? 1 : 0,
          ...(origin ? { origin } : {}),
        },
        events: {
          onStateChange: (e: { data: number; target: YTPlayer }) => {
            if (cancelled) return;
            const Y = window.YT;
            if (!Y?.PlayerState) return;
            const s = e.data;
            if (s === Y.PlayerState.PLAYING || s === Y.PlayerState.BUFFERING || s === Y.PlayerState.CUED) {
              tryApplyResume(e.target);
            }
          },
          onError: () => {
            if (cancelled) return;
            const id = videoIdRef.current;
            if (errorReportedForVideoIdRef.current === id) return;
            errorReportedForVideoIdRef.current = id;
            onPlaybackErrorRef.current?.();
          },
          onReady: (e: { target: YTPlayer }) => {
            if (cancelled) return;
            playerRef.current = e.target;
            if (_lastVolume !== null) e.target.setVolume(_lastVolume);
            e.target.unMute();
            try {
              e.target.loadVideoById(videoIdRef.current);
            } catch {
              /* ignore */
            }
            // Resume after a new load: state changes may be flaky on some devices.
            window.setTimeout(() => tryApplyResume(e.target), 500);
            const poll = window.setInterval(() => {
              try {
                const p = playerRef.current;
                if (!p) return;
                const dur = p.getDuration();
                if (dur > 0) onProgressRef.current?.(Math.min(p.getCurrentTime() / dur, 1));
              } catch { /* ignore */ }
            }, 500);
            const origCancel = cancelled;
            void origCancel; // suppress unused warning
            // Attach cleanup via the outer cancelled flag approach -- store interval on wrapperRef
            (wrapperRef.current as HTMLDivElement & { _poll?: number })._poll = poll;
          },
        },
      });
    });

    return () => {
      cancelled = true;
      const poll = (wrapperRef.current as HTMLDivElement & { _poll?: number } | null)?._poll;
      if (poll) window.clearInterval(poll);
      try {
        const p = playerRef.current ?? playerInstance;
        if (p && !p.isMuted()) {
          _lastVolume = p.getVolume();
        }
        p?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      playerInstance = null;
      if (mountEl.isConnected) mountEl.remove();
    };
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    resumeDoneKeyRef.current = null;
    try {
      p.loadVideoById(videoId);
      window.setTimeout(() => tryApplyResume(p), 500);
    } catch {
      /* ignore */
    }
  }, [videoId]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    resumeDoneKeyRef.current = null;
    tryApplyResume(p);
  }, [resumeFromFraction]);

  // When returning to the tab, resume playback if the player stalled (state 2=paused, -1=unstarted, 5=cued).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      try {
        const p = playerRef.current;
        if (!p) return;
        const state = p.getPlayerState?.();
        if (state === 2 || state === -1 || state === 5) p.playVideo?.();
      } catch { /* ignore */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative aspect-video w-full shrink-0 overflow-hidden bg-black"
      style={{ backgroundColor: "#000" }}
    />
  );
});

const ShareButton = memo(function ShareButton({ onClick, toast }: { onClick: () => void; toast: "copying" | "copied" | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={toast === "copying"}
      className="shrink-0 flex items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50"
      title="Share this title"
    >
      {toast === "copied" ? (
        <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
      )}
      {toast === "copied" ? "Copied!" : "Share"}
    </button>
  );
});

/** Fullscreen + share -- sits directly under the video (or poster hero). */
const TrailerMediaActions = memo(function TrailerMediaActions({
  onFullscreen,
  onShare,
  shareToast,
  showFullscreen = true,
}: {
  onFullscreen: () => void;
  onShare: () => void;
  shareToast: "copying" | "copied" | null;
  showFullscreen?: boolean;
}) {
  return (
    <div className="flex w-full shrink-0 items-center justify-end gap-1.5 border-b border-zinc-700 bg-zinc-900 px-3 py-2 sm:gap-2 sm:px-4">
      {showFullscreen && (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onFullscreen}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700 hover:text-white"
          title="Enter fullscreen"
          aria-label="Enter fullscreen"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          Fullscreen
        </button>
      )}
      <ShareButton onClick={onShare} toast={shareToast} />
    </div>
  );
});

type OnPersonClick = (name: string, role: "actor" | "director") => void;

function personNamesMatch(careerName: string, creditName: string): boolean {
  return careerName.trim().toLowerCase() === creditName.trim().toLowerCase();
}

function PersonLink({
  name,
  role,
  onClick,
  careerHighlight = false,
}: {
  name: string;
  role: "actor" | "director";
  onClick: OnPersonClick;
  /** Career mode: this credit matches the person whose filmography is open. */
  careerHighlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(name, role)}
      className={
        careerHighlight
          ? "text-left font-semibold text-indigo-200 ring-1 ring-indigo-400/50 rounded-sm px-1 -my-0.5 bg-indigo-950/55 hover:bg-indigo-900/60 hover:text-indigo-100 transition-colors"
          : "hover:text-indigo-300 hover:underline underline-offset-2 transition-colors text-left"
      }
    >
      {name}
    </button>
  );
}

/** Trailer layout: title block only -- isolated from rating state. */
const TrailerMetadata = memo(function TrailerMetadata({
  movie,
  onPersonClick,
  onCreateChannelFromMovie,
  careerPersonName = null,
}: {
  movie: CurrentMovie;
  onPersonClick: OnPersonClick;
  onCreateChannelFromMovie: (movie: MovieChannelSeedInput) => void;
  /** When set (career mode), that person’s name is highlighted in the credit lines. */
  careerPersonName?: string | null;
}) {
  return (
    <div className="min-w-0 w-full max-w-full">
      <div className="flex min-w-0 items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {movie.type === "tv" ? "TV Series" : "Movie"}
          {movie.year && <span className="ml-1 font-normal">· {movie.year}</span>}
        </span>
        {movie.rtScore && <RTBadge score={movie.rtScore} />}
      </div>
      <MovieTitleChannelLink
        movie={movie}
        onCreateChannel={onCreateChannelFromMovie}
        headingClassName="text-2xl font-bold text-white mt-1 leading-tight w-full min-w-0 break-words"
      />
      {movie.director && (
        <p className="mt-1 text-sm text-zinc-300">
          <span className="text-zinc-400">{movie.type === "tv" ? "Created by" : "Dir."}</span>{" "}
          <PersonLink
            name={movie.director}
            role="director"
            onClick={onPersonClick}
            careerHighlight={!!careerPersonName && personNamesMatch(careerPersonName, movie.director)}
          />
        </p>
      )}
      {movie.actors.length > 0 && (
        <p className="mt-0.5 text-sm text-zinc-300">
          {movie.actors.map((a, i) => (
            <span key={a}>
              {i > 0 && " · "}
              <PersonLink
                name={a}
                role="actor"
                onClick={onPersonClick}
                careerHighlight={!!careerPersonName && personNamesMatch(careerPersonName, a)}
              />
            </span>
          ))}
        </p>
      )}
      {movie.plot && (
        <p className="mt-2 text-sm text-zinc-300 leading-relaxed w-full min-w-0 break-words">{movie.plot}</p>
      )}
      {movie.streaming && movie.streaming.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {movie.streaming.map((s) => (
            <span key={s} className="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-950/60 text-sky-300 border border-sky-800/50">
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

/** Poster layout: poster + metadata -- isolated from rating state. */
const PosterMovieTop = memo(function PosterMovieTop({
  movie,
  onOpenPoster,
  onPersonClick,
  onCreateChannelFromMovie,
  careerPersonName = null,
  detailsLoading = false,
  showPoster = false,
}: {
  movie: CurrentMovie;
  onOpenPoster: (url: string) => void;
  onPersonClick: OnPersonClick;
  onCreateChannelFromMovie: (movie: MovieChannelSeedInput) => void;
  careerPersonName?: string | null;
  /** True while a new title’s details are still being fetched (keeps layout stable vs swapping to a short placeholder). */
  detailsLoading?: boolean;
  /** Show the poster even when a trailerKey exists (poster mode). */
  showPoster?: boolean;
}) {
  return (
    <div className="flex min-w-0 w-full flex-col sm:flex-row gap-4 sm:items-start">
      {movie.posterUrl && (!movie.trailerKey || showPoster) && (
        <div className="w-full sm:w-auto shrink-0 self-center sm:self-start flex justify-center sm:justify-start">
          <button
            type="button"
            onClick={() => onOpenPoster(movie.posterUrl!)}
            className={`relative rounded-xl overflow-hidden shadow-sm transition-shadow block ${
              detailsLoading
                ? "cursor-wait"
                : "cursor-zoom-in hover:shadow-md"
            }`}
            disabled={detailsLoading}
            aria-busy={detailsLoading}
          >
            {detailsLoading && (
              <span className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 text-sm font-medium text-zinc-200">
                Loading…
              </span>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={movie.posterUrl}
              alt={`${movie.title} poster`}
              referrerPolicy="no-referrer"
              className="w-32 sm:w-48 h-[12rem] sm:h-auto object-cover object-center sm:object-top"
            />
          </button>
        </div>
      )}
      {!movie.posterUrl && (
        <div className="w-full sm:w-48 sm:shrink-0 h-[10.5rem] sm:h-[18rem] self-center sm:self-start max-w-xs mx-auto sm:max-w-none sm:mx-0 rounded-xl bg-zinc-100 border border-zinc-200 flex flex-col items-center justify-center gap-1 text-zinc-400 text-xs px-2 text-center">
          <span className="text-2xl" aria-hidden>
            🎬
          </span>
          <span>No poster</span>
        </div>
      )}
      <div className="w-full min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {movie.type === "tv" ? "TV Series" : "Movie"}
            {movie.year && <span className="ml-1 font-normal">· {movie.year}</span>}
          </span>
          {movie.rtScore && <RTBadge score={movie.rtScore} />}
        </div>
        <MovieTitleChannelLink
          movie={movie}
          onCreateChannel={onCreateChannelFromMovie}
          headingClassName="text-xl sm:text-2xl font-bold text-white mt-0.5 leading-tight w-full min-w-0 break-words"
        />
        {movie.director && (
          <p className="mt-1 text-sm text-zinc-300">
            <span className="text-zinc-400">{movie.type === "tv" ? "Created by" : "Dir."}</span>{" "}
            <PersonLink
              name={movie.director}
              role="director"
              onClick={onPersonClick}
              careerHighlight={!!careerPersonName && personNamesMatch(careerPersonName, movie.director)}
            />
          </p>
        )}
        {movie.actors.length > 0 && (
          <p className="mt-0.5 text-sm text-zinc-300">
            {movie.actors.map((a, i) => (
              <span key={a}>
                {i > 0 && " · "}
                <PersonLink
                  name={a}
                  role="actor"
                  onClick={onPersonClick}
                  careerHighlight={!!careerPersonName && personNamesMatch(careerPersonName, a)}
                />
              </span>
            ))}
          </p>
        )}
        {movie.plot && (
          <p className="mt-2 text-sm text-zinc-300 leading-relaxed line-clamp-3 sm:line-clamp-none">{movie.plot}</p>
        )}
        {movie.streaming && movie.streaming.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {movie.streaming.map((s) => (
              <span key={s} className="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-950/60 text-sky-300 border border-sky-800/50">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** Trailer: directly under the video, above title row -- border separates from metadata. */
const TRAILER_BAR_OUTER =
  "w-full border-b border-zinc-800/90 bg-zinc-950/60 py-2 sm:py-3";

const MovieRatingBlock = memo(function MovieRatingBlock({
  passCurrentCardStable,
  onRate,
  movieTitle,
  starKeyPrefix,
  watchFrac = 0,
  defaultSeen = false,
  previousRating,
  previousMode,
  ratingResetKey,
  showNextInRating = true,
  /** Under video vs poster: same inner controls; wrapper only (strip vs rounded card). */
  layout = "card",
  prevNav = null,
  careerNextDisabled = false,
  controlsVisible = true,
  onControlActivity,
}: {
  passCurrentCardStable: () => void;
  onRate: (stars: number, mode: "seen" | "unseen") => void;
  movieTitle: string;
  starKeyPrefix: "tr" | "po";
  watchFrac?: number;
  /** If true, default to "Seen it"; otherwise default to "Not yet". */
  defaultSeen?: boolean;
  /** Pre-existing rating from history -- locks stars immediately, no auto-progress. */
  previousRating?: number;
  previousMode?: "seen" | "unseen";
  /** Bumps when the card title changes so local star state resets from history. */
  ratingResetKey?: string;
  showNextInRating?: boolean;
  layout?: "card" | "trailerBar" | "fullscreenOverlay";
  /** Prev control -- career filmography index or playback back stack. */
  prevNav?: { onPass: () => void; disabled: boolean } | null;
  /** Career mode: disable Next on last film in filmography (passCurrentCard is a no-op there). */
  careerNextDisabled?: boolean;
  /** Fullscreen: fade toolbar when idle. */
  controlsVisible?: boolean;
  /** Fullscreen: reset auto-hide timer on control use. */
  onControlActivity?: () => void;
}) {
  const seenRadioGroupName = useId();
  const hasPrev = previousRating !== undefined && previousRating > 0;
  const initialSeen = hasPrev ? (previousMode === "unseen" ? "unseen" : null) : (defaultSeen ? null : "unseen");
  const [seenStatus, setSeenStatus] = useState<"unseen" | null>(() => initialSeen);
  const [userLocked, setUserLocked] = useState(() => hasPrev);
  const [lockedValue, setLockedValue] = useState(() => hasPrev ? previousRating! : 0);
  const lastTitleRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const titleChanged = lastTitleRef.current !== movieTitle;
    if (titleChanged) lastTitleRef.current = movieTitle;

    const hasHistoryRating = previousRating !== undefined && previousRating > 0;

    if (titleChanged) {
      // Only reset seen status if there's a history rating; keep user's selection otherwise
      if (hasHistoryRating) {
        setSeenStatus(previousMode === "unseen" ? "unseen" : null);
        setUserLocked(true);
        setLockedValue(previousRating!);
      } else {
        setUserLocked(false);
        setLockedValue(0);
        // Don't reset seenStatus here — keep user's previous selection
      }
    }

    if (hasHistoryRating && !titleChanged) {
      setUserLocked(true);
      setLockedValue(previousRating!);
    }
  }, [movieTitle, defaultSeen, previousRating, previousMode, ratingResetKey]);
  const onSeenStatusChange = useCallback((v: "unseen" | null) => {
    setSeenStatus(v);
  }, []);

  const autoFilled = WATCH_PROGRESS_AUTO_RATING ? progressToStars(watchFrac) : 0;
  const displayFilled = userLocked ? lockedValue : autoFilled;

  const isTrailerStrip = layout === "trailerBar";
  const navPairTight =
    layout === "fullscreenOverlay" || isTrailerStrip || Boolean(prevNav && showNextInRating);
  const starBlock = seenStatus === null ? (
    <StarRow
      key={`${starKeyPrefix}-seen-${movieTitle}`}
      compact
      careerNavTight={navPairTight}
      filled={displayFilled}
      color="red"
      label="Rating"
      onRate={(v) => { setUserLocked(true); setLockedValue(v); onRate(v, "seen"); }}
    />
  ) : (
    <StarRow
      key={`${starKeyPrefix}-unseen-${movieTitle}`}
      compact
      careerNavTight={navPairTight}
      filled={displayFilled}
      color="blue"
      label="Interest"
      onRate={(v) => { setUserLocked(true); setLockedValue(v); onRate(v, "unseen"); }}
    />
  );

  const navPair = navPairTight;

  const bumpControlActivity = useCallback(() => {
    onControlActivity?.();
  }, [onControlActivity]);

  const navRow = (
    <div
      className={
        isTrailerStrip
          ? "flex w-full min-w-0 flex-nowrap items-center gap-x-1 sm:gap-x-2"
          : navPair
            ? "flex w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-2 sm:flex-nowrap sm:gap-x-3"
            : `flex min-w-0 flex-wrap items-center justify-center gap-x-4 gap-y-3 sm:gap-x-5 ${
                showNextInRating ? "" : "justify-center"
              }`
      }
    >
      {prevNav && (
        <div className="shrink-0 self-center">
          <PassNextButton
            onPass={() => {
              bumpControlActivity();
              prevNav.onPass();
            }}
            disabled={prevNav.disabled}
            direction="prev"
            compact={!isTrailerStrip && layout !== "fullscreenOverlay"}
            muted={isTrailerStrip}
            prominent={false}
            ghost={layout === "fullscreenOverlay"}
          />
        </div>
      )}
      <div
        className={
          isTrailerStrip
            ? "flex min-w-0 flex-1 justify-center overflow-hidden"
            : navPair
              ? "flex min-w-0 flex-1 justify-center sm:flex-initial"
              : "min-w-0 flex shrink"
        }
      >
        {starBlock}
      </div>
      {showNextInRating && (
        <div className="shrink-0 self-center">
          <PassNextButton
            onPass={() => {
              bumpControlActivity();
              passCurrentCardStable();
            }}
            compact={!isTrailerStrip && layout !== "fullscreenOverlay"}
            muted={isTrailerStrip}
            prominent={false}
            ghost={layout === "fullscreenOverlay"}
            disabled={careerNextDisabled}
          />
        </div>
      )}
    </div>
  );

  const ratingBody = (
    <div className="flex min-w-0 flex-col gap-2 sm:gap-3">
      <SeenOrNotRadios name={seenRadioGroupName} value={seenStatus} onChange={onSeenStatusChange} />
      {navRow}
    </div>
  );

  if (layout === "trailerBar") {
    return (
      <div className={TRAILER_BAR_OUTER}>
        <div className="mx-auto w-full min-w-0 max-w-3xl px-2 sm:px-3">{ratingBody}</div>
      </div>
    );
  }

  if (layout === "fullscreenOverlay") {
    const fsStars = (
      <StarRow
        key={`${starKeyPrefix}-fs-${movieTitle}-${seenStatus === null ? "seen" : "unseen"}`}
        compact
        careerNavTight
        hideLabel
        filled={displayFilled}
        color={seenStatus === null ? "red" : "blue"}
        label={seenStatus === null ? "Rating" : "Interest"}
        onRate={(v) => {
          bumpControlActivity();
          setUserLocked(true);
          setLockedValue(v);
          onRate(v, seenStatus === null ? "seen" : "unseen");
        }}
      />
    );
    const fsVisible = controlsVisible;
    return (
      <div
        className={`pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12 transition-opacity duration-300 ${
          fsVisible ? "opacity-100" : "opacity-0"
        }`}
        role="region"
        aria-label="Rating controls"
        aria-hidden={!fsVisible}
      >
        <div
          className={`flex w-full max-w-3xl min-w-0 flex-wrap items-center justify-center gap-2 rounded-xl border border-zinc-600/90 bg-black/85 px-3 py-2.5 shadow-2xl backdrop-blur-sm sm:gap-3 ${
            fsVisible ? "pointer-events-auto" : "pointer-events-none"
          }`}
        >
          {prevNav && (
            <PassNextButton
              onPass={() => {
                bumpControlActivity();
                prevNav.onPass();
              }}
              disabled={prevNav.disabled}
              direction="prev"
              ghost
            />
          )}
          <SeenModeSegment
            value={seenStatus}
            onChange={(v) => {
              bumpControlActivity();
              onSeenStatusChange(v);
            }}
            ghost
          />
          <div className="rounded-lg border border-zinc-600 bg-zinc-900/90 px-2 py-1 shadow-md">{fsStars}</div>
          {showNextInRating && (
            <PassNextButton
              onPass={() => {
                bumpControlActivity();
                passCurrentCardStable();
              }}
              ghost
              disabled={careerNextDisabled}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-700 px-2 py-2 sm:px-3 sm:py-2.5">
      {ratingBody}
    </div>
  );
});

/** Normal-view exit + bottom toolbar when trailer or poster is fullscreen. */
const TrailerFullscreenChrome = memo(function TrailerFullscreenChrome({
  children,
  onExit,
  passCurrentCardStable,
  onRate,
  movieTitle,
  watchFrac,
  defaultSeen,
  previousRating,
  previousMode,
  ratingResetKey,
  prevNav,
  careerNextDisabled,
}: {
  /** Poster-only fullscreen still wraps content; trailer video stays mounted as a sibling. */
  children?: React.ReactNode;
  onExit: () => void;
  passCurrentCardStable: () => void;
  onRate: (stars: number, mode: "seen" | "unseen") => void;
  movieTitle: string;
  watchFrac: number;
  defaultSeen: boolean;
  previousRating?: number;
  previousMode?: "seen" | "unseen";
  ratingResetKey?: string;
  prevNav: { onPass: () => void; disabled: boolean } | null;
  careerNextDisabled: boolean;
}) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpControlsVisible = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_MS);
  }, []);

  const wakeControls = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      e.stopPropagation();
      bumpControlsVisible();
    },
    [bumpControlsVisible]
  );

  useEffect(() => {
    bumpControlsVisible();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [bumpControlsVisible, movieTitle]);

  useEffect(() => {
    const onActivity = () => bumpControlsVisible();
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("mousemove", onActivity, opts);
    document.addEventListener("pointermove", onActivity, opts);
    document.addEventListener("touchstart", onActivity, opts);
    document.addEventListener("touchend", onActivity, opts);
    return () => {
      document.removeEventListener("mousemove", onActivity, opts);
      document.removeEventListener("pointermove", onActivity, opts);
      document.removeEventListener("touchstart", onActivity, opts);
      document.removeEventListener("touchend", onActivity, opts);
    };
  }, [bumpControlsVisible]);

  const wakeOverlay = !controlsVisible ? (
    <div
      className={`${children ? "absolute" : "fixed"} inset-0 z-[45] touch-manipulation cursor-pointer`}
      aria-hidden
      onPointerDown={wakeControls}
      onTouchStart={wakeControls}
      onTouchEnd={wakeControls}
      onClick={wakeControls}
    />
  ) : null;

  return (
    <>
      {children ? (
        <div className="relative flex min-h-0 flex-1 flex-col w-full bg-black">
          {children}
          {/* Above the YouTube iframe (cross-origin -- no events reach document). */}
          {wakeOverlay}
        </div>
      ) : (
        wakeOverlay
      )}
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          bumpControlsVisible();
          onExit();
        }}
        className={`fixed z-[60] inline-flex h-11 w-11 items-center justify-center rounded-full border border-zinc-500 bg-black/85 p-0 text-white shadow-lg backdrop-blur-sm transition-opacity duration-300 hover:bg-black select-none touch-manipulation top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] ${
          controlsVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        title="Exit fullscreen"
        aria-label="Exit fullscreen"
      >
        <svg className="h-7 w-7 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <MovieRatingBlock
        key={ratingResetKey}
        layout="fullscreenOverlay"
        passCurrentCardStable={passCurrentCardStable}
        onRate={onRate}
        movieTitle={movieTitle}
        starKeyPrefix="tr"
        watchFrac={watchFrac}
        defaultSeen={defaultSeen}
        previousRating={previousRating}
        previousMode={previousMode}
        ratingResetKey={ratingResetKey}
        prevNav={prevNav}
        careerNextDisabled={careerNextDisabled}
        controlsVisible={controlsVisible}
        onControlActivity={bumpControlsVisible}
      />
    </>
  );
});

interface CareerFilm { tmdbId: number; title: string; year: number | null; type: "movie" | "tv"; posterUrl: string | null; }
interface CareerMode { personName: string; role: "actor" | "director"; films: CareerFilm[]; index: number; }

function isSameFilmAsCurrent(prev: CurrentMovie | null, film: CareerFilm): boolean {
  if (!prev) return false;
  return (
    prev.title.toLowerCase().trim() === film.title.toLowerCase().trim() &&
    prev.type === film.type &&
    (prev.year ?? null) === (film.year ?? null)
  );
}

function currentMovieEquals(a: CurrentMovie, b: CurrentMovie): boolean {
  if (a === b) return true;
  return (
    a.title === b.title &&
    a.type === b.type &&
    a.year === b.year &&
    a.director === b.director &&
    a.predictedRating === b.predictedRating &&
    a.plot === b.plot &&
    a.posterUrl === b.posterUrl &&
    a.trailerKey === b.trailerKey &&
    a.rtScore === b.rtScore &&
    a.reason === b.reason &&
    a.actors.length === b.actors.length &&
    a.actors.every((s, i) => s === b.actors[i])
  );
}

const CareerFilmographyPanel = memo(function CareerFilmographyPanel({
  career,
  onSelect,
  onExit,
  loading,
}: {
  career: CareerMode;
  onSelect: (index: number) => void;
  onExit: () => void;
  loading: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  /** Reveal the active row only after metadata loading settles -- avoids list scroll + page layout reflow (hero height) compounding. */
  useLayoutEffect(() => {
    if (loading) return;
    const list = listRef.current;
    if (!list) return;
    const li = list.children[career.index] as HTMLElement | undefined;
    if (!li) return;
    const listRect = list.getBoundingClientRect();
    const liRect = li.getBoundingClientRect();
    const liTop = liRect.top - listRect.top;
    const liBottom = liRect.bottom - listRect.top;
    if (liTop < 0) {
      list.scrollTop += liTop;
    } else if (liBottom > list.clientHeight) {
      list.scrollTop += liBottom - list.clientHeight;
    }
  }, [career.index, career.films.length, loading]);

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-700 overflow-hidden">
        <div className="px-3 py-2.5 border-b border-zinc-700 bg-zinc-800/60 sm:px-4 sm:py-3">
        <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold leading-snug text-zinc-50 sm:text-xl break-words">
            {career.personName}
          </p>
          <p className="min-h-[1.25rem] mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
            <span>{career.role === "director" ? "Director" : "Actor"} · {career.index + 1} of {career.films.length}</span>
            {loading && <span className="text-indigo-400 animate-pulse">Loading…</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onExit}
          className="shrink-0 text-xs text-zinc-500 hover:text-white transition-colors"
        >
          Exit career
        </button>
        </div>
      </div>
      <ul
        ref={listRef}
        className="max-h-52 overflow-y-auto divide-y divide-zinc-800 [overflow-anchor:none]"
      >
        {career.films.map((film, i) => (
          <li key={film.tmdbId}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                i === career.index
                  ? "bg-indigo-900/60 text-white"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              {film.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={film.posterUrl} alt="" referrerPolicy="no-referrer" className="w-6 h-9 rounded object-cover shrink-0" />
              ) : (
                <div className="w-6 h-9 rounded bg-zinc-700 shrink-0" />
              )}
              <span className="text-xs font-medium truncate flex-1">{film.title}</span>
              <span className="text-xs text-zinc-500 shrink-0">{film.year}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

const ChannelsToolbar = memo(function ChannelsToolbar({
  channels,
  activeChannelId,
  onLoadStarter,
  onMergeStarters,
  showMergeStarterPack,
  onSelectChannel,
  onRequestDeleteChannel,
}: {
  channels: Channel[];
  activeChannelId: string;
  onLoadStarter: () => void;
  /** Same as Settings → Merge starter channels: add missing factory channels, keep current active channel. */
  onMergeStarters: () => void;
  showMergeStarterPack: boolean;
  onSelectChannel: (id: string) => void;
  onRequestDeleteChannel: (ch: Channel) => void;
}) {
  const list = normalizeChannelList(channels);
  const customChannels = list.filter((c) => c.id !== "all");
  const allChannel = list.find((c) => c.id === "all");

  const renderChannelButton = (ch: Channel) => {
    const deletable = ch.id !== "all";
    return (
      <div key={ch.id} className="group relative shrink-0 lg:w-full lg:min-w-0">
        <button
          type="button"
          onClick={() => onSelectChannel(ch.id)}
          aria-pressed={activeChannelId === ch.id}
          aria-current={activeChannelId === ch.id ? "true" : undefined}
          className={`max-w-[240px] rounded-full py-1.5 pl-3.5 text-left text-sm font-semibold transition-colors lg:flex lg:max-w-none lg:w-full lg:items-center lg:rounded-xl lg:py-2 lg:pl-3 ${
            deletable ? "pr-9" : "pr-3.5"
          } ${
            activeChannelId === ch.id
              ? "bg-indigo-600 text-white shadow-md ring-2 ring-indigo-400/90 ring-offset-2 ring-offset-black lg:ring-offset-zinc-950"
              : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
          }`}
        >
          <span className="block truncate">{ch.name}</span>
        </button>
        {deletable && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRequestDeleteChannel(ch);
            }}
            className={`absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-sm leading-none opacity-100 transition-opacity sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 lg:pointer-events-auto lg:opacity-100 ${
              activeChannelId === ch.id
                ? "text-zinc-300 hover:bg-white/10 hover:text-red-300"
                : "text-zinc-500 hover:bg-red-900/30 hover:text-red-400"
            }`}
            aria-label={`Delete channel ${ch.name}`}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="flex flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 [-webkit-overflow-scrolling:touch] [scrollbar-color:rgba(63,63,70,0.65)_transparent] [scrollbar-width:thin] lg:flex-col lg:items-stretch lg:overflow-y-auto lg:overflow-x-visible lg:pb-0 lg:[scrollbar-width:auto] lg:max-h-[min(72vh,560px)]"
      role="toolbar"
      aria-label="Channels"
    >
      {allChannel ? renderChannelButton(allChannel) : null}
      {customChannels.length === 0 ? (
        <>
          <button
            type="button"
            onClick={onLoadStarter}
            className="shrink-0 rounded-full border border-indigo-700 bg-indigo-950 px-4 py-2 text-sm font-semibold text-indigo-200 shadow-sm transition-colors hover:border-indigo-500 hover:bg-indigo-900 lg:w-full lg:rounded-xl lg:py-2.5"
          >
            Load starter channels
          </button>
          <Link
            href="/channels?new=1"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-700 bg-zinc-900 text-lg font-light leading-none text-zinc-400 transition-colors hover:border-indigo-500 hover:bg-indigo-950 hover:text-indigo-400 lg:size-9 lg:shrink-0 lg:self-center"
            title="Create a new channel"
            aria-label="Create a new channel"
          >
            +
          </Link>
        </>
      ) : (
        <>
          {showMergeStarterPack && (
            <button
              type="button"
              onClick={onMergeStarters}
              className="shrink-0 rounded-full border border-zinc-600 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 lg:w-full lg:shrink-0 lg:rounded-xl lg:py-2 lg:text-left"
              title="Add bundled example channels you don’t already have (same as Settings → Starter channel pack)"
            >
              Merge starter pack
            </button>
          )}
          {customChannels.map(renderChannelButton)}
          <Link
            href="/channels?new=1"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-700 bg-zinc-900 text-lg font-light leading-none text-zinc-400 transition-colors hover:border-indigo-500 hover:bg-indigo-950 hover:text-indigo-400 lg:size-9 lg:shrink-0 lg:self-center"
            title="Create a new channel"
            aria-label="Create a new channel"
          >
            +
          </Link>
        </>
      )}
    </div>
  );
});

function isIosTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

async function requestFullscreenPolyfill(el: HTMLElement): Promise<boolean> {
  try {
    if (typeof el.requestFullscreen === "function") {
      await el.requestFullscreen();
      return true;
    }
  } catch {
    /* fall through */
  }
  const wk = (el as unknown as { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen;
  if (typeof wk === "function") {
    try {
      wk.call(el);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function exitFullscreenPolyfill(): Promise<void> {
  try {
    if (typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
      return;
    }
  } catch {
    /* fall through */
  }
  const d = document as Document & { webkitExitFullscreen?: () => void };
  try {
    d.webkitExitFullscreen?.();
  } catch {
    /* ignore */
  }
}

export default function Home() {
  const router = useRouter();
  const pathname = usePathname();

  const syncChannelsFromStorage = useCallback(() => {
    try {
      const raw = localStorage.getItem(CHANNELS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Channel[]) : [];
      const chs = normalizeChannelList(parsed).map(normalizeChannel);
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(chs));
      channelsRef.current = chs;
      setChannels(chs);
      const active = localStorage.getItem(ACTIVE_CHANNEL_KEY);
      const fallback = chs[0]?.id ?? "all";
      if (!active || !chs.some((c) => c.id === active)) {
        localStorage.setItem(ACTIVE_CHANNEL_KEY, fallback);
        setActiveChannelId(fallback);
      } else if (active !== activeChannelIdRef.current) {
        setActiveChannelId(active);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (pathname === "/") syncChannelsFromStorage();
  }, [pathname, syncChannelsFromStorage]);
  /** Persisted lists -- refs only on this page (nothing in the tree reads them for render). Updates skip full-tree re-renders. */
  const historyRef = useRef<RatingEntry[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  /** In-tab star picks before/until Next -- keyed by canonical title. */
  const sessionRatingsRef = useRef<Record<string, DisplayRating>>({});
  const [sessionRatingsRevision, setSessionRatingsRevision] = useState(0);
  const [unseenLogRevision, setUnseenLogRevision] = useState(0);
  const [cardNavSeq, setCardNavSeq] = useState(0);
  const skippedRef = useRef<string[]>([]);
  const passedRef = useRef<string[]>([]);
  const watchlistRef = useRef<WatchlistEntry[]>([]);
  const notSeenRef = useRef<NotSeenEvent[]>([]);
  const notInterestedRef = useRef<{ title: string; rtScore?: string | null }[]>([]);
  const [tasteSummary, setTasteSummary] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentMovie | null>(null);
  const currentRef = useRef<CurrentMovie | null>(null);
  currentRef.current = current;
  const [trailerResumeByChannel, setTrailerResumeByChannel] = useState<Record<string, Record<string, number>>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  /** True while fetchNext is loading the next title (after first card). Not tied to card opacity -- avoids collapsing the layout. */
  const [isAdvancingCard, setIsAdvancingCard] = useState(false);
  const advanceFetchDepthRef = useRef(0);
  const [pendingRating, setPendingRating] = useState<{ stars: number; mode: "seen" | "unseen" } | null>(null);
  const pendingRatingRef = useRef(pendingRating);
  pendingRatingRef.current = pendingRating;
  /** Delayed advance after star rating -- cleared if user uses Next or queue before it fires. */
  const advanceAfterRatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Home hydration (localStorage + first fetchNext) must run once; `fetchNext` in deps was re-firing the effect and popping an extra title each time its identity changed. */
  const homeHydrationEffectRanRef = useRef(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<"both" | "movie" | "tv">(() => loadSetting("mediaType", "both" as const));
  const [displayMode, setDisplayMode] = useState<"trailers" | "posters">(() => loadSetting("displayMode", "trailers" as const));
  const [llm, setLlm] = useState<string>(() => loadSetting("llm", "deepseek"));
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isTrailerFullscreen, setIsTrailerFullscreen] = useState(false);
  const [pseudoTrailerFullscreen, setPseudoTrailerFullscreen] = useState(false);
  const trailerFsUi = isTrailerFullscreen || pseudoTrailerFullscreen;
  const [shareToast, setShareToast] = useState<"copying" | "copied" | null>(null);
  const [careerMode, setCareerMode] = useState<CareerMode | null>(null);
  const [careerLoading, setCareerLoading] = useState(false);
  const careerModeRef = useRef<CareerMode | null>(null);
  careerModeRef.current = careerMode;
  const [watchFrac, setWatchFrac] = useState(0);
  const watchFracRef = useRef(0);
  watchFracRef.current = watchFrac;
  const cardRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  /** In career+trailers, min height of the top media block while the next title loads (avoids 16:9 video → short placeholder jump). */
  const careerTrailerBlockRef = useRef<HTMLDivElement>(null);
  const [careerTrailerBlockStableH, setCareerTrailerBlockStableH] = useState(0);
  const prefetchRef = useRef<CurrentMovie[]>([]);
  const [prefetchQueueUi, setPrefetchQueueUi] = useState<CurrentMovie[]>([]);
  /** Titles the user left via Next / queue pick -- Prev walks back through this stack. */
  const navBackStackRef = useRef<CurrentMovie[]>([]);
  /** Main-card titles already shown this channel session -- excluded from upcoming UI. */
  const viewedTitleKeysRef = useRef<Set<string>>(new Set());
  const suppressNavPushRef = useRef(false);
  const [navBackDepth, setNavBackDepth] = useState(0);
  const replenishGenRef = useRef(0);
  const savedPrefetchChannelRef = useRef<string | null>(null);
  const replenishInFlight = useRef(0);
  /** In-flight replenish count for the current gen -- reset to 0 on every gen bump so fetchNext knows when to kick off a fresh batch. */
  const replenishGenInFlight = useRef(0);
  const batchYieldRef = useRef<number[]>([]); // rolling yield fractions (fresh / requested)

  const tasteSummaryRef = useRef(tasteSummary);

  const [userRequest, setUserRequest] = useState<string>(() => loadSetting("userRequest", ""));
  const userRequestRef = useRef("");
  userRequestRef.current = userRequest;
  /** Set after first userRequest effect -- used so we only flush prefetch on real edits, not mount/import. */
  const prevUserRequestForFlushRef = useRef<string | undefined>(undefined);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [factoryPackFullyMerged, setFactoryPackFullyMerged] = useState<boolean | null>(null);
  const [channelPendingDelete, setChannelPendingDelete] = useState<Channel | null>(null);

  useEffect(() => {
    setFactoryPackFullyMerged(isFactoryStarterPackFullyMerged());
  }, [channels]);
  const channelsRef = useRef<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const [newChannelText, setNewChannelText] = useState<string>("");
  const activeChannelIdRef = useRef<string>("");
  activeChannelIdRef.current = activeChannelId;
  channelsRef.current = channels;

  /** Same as "What you want" in the channel editor: All → settings `userRequest`; else → this channel’s `freeText`. */
  const channelPromptValue = useMemo(() => {
    if (activeChannelId === "all") return userRequest;
    const ch = channels.find((c) => c.id === activeChannelId);
    return ch?.freeText ?? "";
  }, [activeChannelId, userRequest, channels]);

  const constellationsNowPlayingKey = useMemo((): string | null => {
    if (!current) return null;
    const person = careerMode?.personName?.trim() ?? "";
    return `${activeChannelId}::${person}::${current.title}::${current.type}`;
  }, [activeChannelId, careerMode, current]);

  const constellationsAutoExpand = useMemo((): string[] => {
    if (!current) return [];
    const seed = filmWorkSearchTerm(current.title, current.year, current.type);
    const out: string[] = [seed];
    const d = current.director?.replace(/\s+/g, " ").trim();
    if (d) out.push(d);
    return out;
  }, [current]);

  const constellationsExternalSearch = useMemo((): { term: string; id: string | number; typeHint?: string } | null => {
    if (!current) return null;
    const t = filmWorkSearchTerm(current.title, current.year, current.type);
    if (!t) return null;
    const ch = (activeChannelId && activeChannelId.length > 0 ? activeChannelId : "all").toString();
    return {
      term: t,
      id: `trailer:${ch}:${canonicalTitleKey(t)}`,
      typeHint: current.type === "tv" ? "TV series" : "Film",
    };
  }, [activeChannelId, current]);

  const updateChannelPrompt = useCallback((value: string) => {
    if (activeChannelId === "all") {
      setUserRequest(value);
      try {
        const s = localStorage.getItem(SETTINGS_KEY);
        const base = s ? (JSON.parse(s) as Record<string, unknown>) : {};
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...base, userRequest: value }));
      } catch {
        /* ignore */
      }
      return;
    }
    if (!activeChannelId) return;
    setChannels((prev) => {
      const next = prev.map((c) =>
        c.id === activeChannelId ? { ...c, freeText: value } : c
      );
      try {
        localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [activeChannelId]);

  const replenishOptsRef = useRef<{ mediaType: string; llm: string }>({ mediaType: "both", llm: "deepseek" });
  const zeroYieldStreakRef = useRef(0); // consecutive batches with 0 fresh items -- stop daisy-chaining when high
  const lensIndexRef = useRef(0);       // rotates through DIVERSITY_LENSES so each batch explores a different area
  tasteSummaryRef.current = tasteSummary;

  const loadPrefetchIntoRefForChannel = useCallback((channelId: string) => {
    const k = prefetchQueueStorageKey(channelId);
    let raw = localStorage.getItem(k);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_PREFETCH_QUEUE_KEY);
      if (raw) {
        try {
          localStorage.setItem(k, raw);
          localStorage.removeItem(LEGACY_PREFETCH_QUEUE_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) {
      prefetchRef.current = [];
      return;
    }
    try {
      const q = JSON.parse(raw) as CurrentMovie[];
      if (Array.isArray(q) && q.every((m) => m && typeof m.title === "string")) {
        const seen = new Set<string>();
        prefetchRef.current = q
          .filter((m) => {
            const k = canonicalTitleKey(m.title);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, HIGH_WATER_MARK);
      } else {
        prefetchRef.current = [];
      }
    } catch {
      prefetchRef.current = [];
    }
  }, []);

  const getUpcomingQueueForDisplay = useCallback((): CurrentMovie[] => {
    const hidden = new Set(viewedTitleKeysRef.current);
    const cur = currentRef.current;
    if (cur?.title) hidden.add(canonicalTitleKey(cur.title));
    return prefetchRef.current.filter((m) => !hidden.has(canonicalTitleKey(m.title)));
  }, []);

  const persistPrefetchQueue = useCallback(() => {
    const ch = activeChannelIdRef.current?.trim() || "all";
    try {
      localStorage.setItem(prefetchQueueStorageKey(ch), JSON.stringify(prefetchRef.current));
    } catch {
      /* ignore quota */
    }
    setPrefetchQueueUi(getUpcomingQueueForDisplay());
  }, [getUpcomingQueueForDisplay]);

  useEffect(() => {
    if (current?.title) {
      viewedTitleKeysRef.current.add(canonicalTitleKey(current.title));
    }
    setPrefetchQueueUi(getUpcomingQueueForDisplay());
  }, [current?.title, getUpcomingQueueForDisplay]);

  const pushNavBack = useCallback((leaving: CurrentMovie | null) => {
    if (suppressNavPushRef.current || !leaving || careerModeRef.current) return;
    const stack = navBackStackRef.current;
    const key = canonicalTitleKey(leaving.title);
    if (stack.length > 0 && canonicalTitleKey(stack[stack.length - 1]!.title) === key) return;
    navBackStackRef.current = [...stack, leaving];
    setNavBackDepth(navBackStackRef.current.length);
  }, []);

  const handleTrailerPlaybackError = useCallback(() => {
    const c = currentRef.current;
    if (!c?.trailerKey) return;
    const k = canonicalTitleKey(c.title);
    prefetchRef.current = prefetchRef.current.map((m) =>
      canonicalTitleKey(m.title) === k ? { ...m, trailerKey: null } : m
    );
    persistPrefetchQueue();
    setCurrent({ ...c, trailerKey: null });
  }, [persistPrefetchQueue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setLightboxUrl(null); setPseudoTrailerFullscreen(false); }
      if (e.key === "ArrowRight") {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        passCurrentCardRef.current();
      }
      if (e.key === "ArrowLeft") {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        goToPreviousCardRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onChange = () => {
      setIsTrailerFullscreen(document.fullscreenElement === videoContainerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const exitTrailerFullscreen = useCallback(async () => {
    if (pseudoTrailerFullscreen) {
      setPseudoTrailerFullscreen(false);
      return;
    }
    await exitFullscreenPolyfill();
  }, [pseudoTrailerFullscreen]);

  const enterTrailerFullscreen = useCallback(async () => {
    const root = videoContainerRef.current;
    if (!root) return;
    if (isIosTouchDevice()) {
      setPseudoTrailerFullscreen(true);
      return;
    }
    setPseudoTrailerFullscreen(false);
    try {
      const ok = await requestFullscreenPolyfill(root);
      if (!ok) setPseudoTrailerFullscreen(true);
    } catch {
      setPseudoTrailerFullscreen(true);
    }
  }, []);

  useEffect(() => {
    if (!pseudoTrailerFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [pseudoTrailerFullscreen]);

  useEffect(() => {
    setPseudoTrailerFullscreen(false);
  }, [current?.title, current?.trailerKey]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = sessionStorage.getItem(TRAILER_RESUME_KEY);
      if (raw) {
        setTrailerResumeByChannel(JSON.parse(raw) as Record<string, Record<string, number>>);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Reset watch progress when the title or video changes (including when switching back to a channel with the same video id)
  const currentTrailerKey = current?.trailerKey;
  useEffect(() => {
    setWatchFrac((w) => (w === 0 ? w : 0));
  }, [currentTrailerKey, current?.title]);

  // Record every presented title card in ratingHistory (userRating: null until rated).
  const currentTitle = current?.title;
  useEffect(() => {
    if (!currentTitle || !current) return;
    const alreadyInHistory = historyRef.current.some(
      (e) => canonicalTitleKey(e.title) === canonicalTitleKey(currentTitle)
    );
    if (alreadyInHistory) return;
    const entry: RatingEntry = {
      title: currentTitle,
      type: current.type,
      userRating: null,
      predictedRating: migrateRatingValue(current.predictedRating),
      error: 0,
      rtScore: current.rtScore,
      channelId: activeChannelIdRef.current?.trim() || undefined,
      posterUrl: current.posterUrl,
      watchFrac: 0,
      presentedAt: new Date().toISOString(),
      categories: current.categories?.length ? current.categories : undefined,
    };
    saveHistory([...historyRef.current, entry]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle]);

  useLayoutEffect(() => {
    if (!careerMode || displayMode !== "trailers" || careerLoading || trailerFsUi) return;
    const el = careerTrailerBlockRef.current;
    if (!el) return;
    const h = Math.round(el.getBoundingClientRect().height);
    if (h > 0) setCareerTrailerBlockStableH(h);
  }, [
    careerMode,
    displayMode,
    careerLoading,
    trailerFsUi,
    current?.title,
    current?.trailerKey,
    current?.posterUrl,
  ]);

  useEffect(() => {
    if (!careerMode) setCareerTrailerBlockStableH(0);
  }, [careerMode]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        historyRef.current = (JSON.parse(stored) as RatingEntry[]).map(migrateRatingEntry);
      }
      const storedSkipped = localStorage.getItem(SKIPPED_KEY);
      if (storedSkipped) skippedRef.current = JSON.parse(storedSkipped);
      const storedPassed = localStorage.getItem(PASSED_KEY);
      if (storedPassed) passedRef.current = JSON.parse(storedPassed);
      const storedWatchlist = localStorage.getItem(WATCHLIST_KEY);
      if (storedWatchlist) watchlistRef.current = JSON.parse(storedWatchlist);
      const storedNotSeen = localStorage.getItem(NOTSEEN_KEY);
      if (storedNotSeen) notSeenRef.current = JSON.parse(storedNotSeen);
      const storedNotInterested = localStorage.getItem(NOT_INTERESTED_KEY);
      if (storedNotInterested) notInterestedRef.current = JSON.parse(storedNotInterested);
      const storedTasteSummary = localStorage.getItem(TASTE_SUMMARY_KEY);
      if (storedTasteSummary) { setTasteSummary(storedTasteSummary); tasteSummaryRef.current = storedTasteSummary; }
      if (hasNoChannelsPersisted()) {
        applyFactoryBootstrap();
      }
      let loadedChannels: Channel[] = [];
      const storedChannels = localStorage.getItem(CHANNELS_KEY);
      if (storedChannels) {
        loadedChannels = hydrateChannelsOnLoad(
          normalizeChannelList(JSON.parse(storedChannels) as Channel[]),
          ALL_CHANNEL,
          normalizeChannel,
        );
      } else {
        loadedChannels = normalizeChannelList([]).map(normalizeChannel);
      }
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(loadedChannels));
      setChannels(loadedChannels);
      channelsRef.current = loadedChannels;
      const storedActiveChannel = localStorage.getItem(ACTIVE_CHANNEL_KEY);
      const defaultChannelId = loadedChannels.length > 0 ? loadedChannels[0].id : "all";
      const activeId = storedActiveChannel || defaultChannelId;
      setActiveChannelId(activeId);
      activeChannelIdRef.current = activeId;
    } catch {}
  }, []);

  const saveHistory = (h: RatingEntry[]) => {
    if (!safeSetItem(STORAGE_KEY, JSON.stringify(h))) return;
    historyRef.current = h;
    setHistoryRevision((n) => n + 1);
  };

  /** Fire-and-forget: ask the LLM to summarize taste. Called after ratings hit 1, 5, 10, 15 ... */
  const updateTasteSummary = useCallback((hist: RatingEntry[], currentLlm: string) => {
    const wl = watchlistRef.current;
    const ni = notInterestedRef.current;
    fetch("/api/taste-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: hist,
        watchlistSignals: wl.map((w) => ({ title: w.title, rtScore: w.rtScore })),
        notInterestedSignals: ni,
        existingSummary: tasteSummaryRef.current ?? undefined,
        llm: currentLlm,
      }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { tasteSummary?: string | null } | null) => {
        if (d?.tasteSummary) {
          localStorage.setItem(TASTE_SUMMARY_KEY, d.tasteSummary);
          tasteSummaryRef.current = d.tasteSummary;
          setTasteSummary(d.tasteSummary);
        }
      })
      .catch(() => {});
  }, []);

  // Single POST: LLM returns many titles; duplicate filtering happens here.
  // Reads history/watchlist from refs at request time so in-flight calls stay aligned with the latest ratings.
  const fetchMovieBatch = useCallback(async (opts: {
    mediaType: string;
    llm: string;
    /** Merged skip list (base skipped + prefetch queue titles + retry dupes). */
    skipped: string[];
  }): Promise<CurrentMovie[] | null> => {
    const timeoutMs = 180_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const hist = historyRef.current;
        const wl = watchlistRef.current;
        const ni = notInterestedRef.current;
        const res = await fetch("/api/next-movie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            ...buildHistorySyncPayload(hist),
            skipped: opts.skipped,
            watchlistTitles: wl.map((w) => ({ title: w.title, rtScore: w.rtScore })),
            notInterestedItems: ni,
            tasteSummary: tasteSummaryRef.current ?? undefined,
            // TikTok-style exploration: maximize diversity early (few ratings),
            // then narrow as preferences emerge. If user has rated < 20 titles,
            // skip the lens constraint and let LLM explore freely.
            diversityLens: hist.length < 20
              ? undefined
              : DIVERSITY_LENSES[lensIndexRef.current % DIVERSITY_LENSES.length],
            userRequest: userRequestRef.current.trim() || undefined,
            activeChannel: (() => {
              const id = activeChannelIdRef.current?.trim();
              if (!id) return undefined;
              let ch = channelsRef.current.find((c) => c.id === id);
              if (!ch) {
                try {
                  const raw = localStorage.getItem(CHANNELS_KEY);
                  if (raw) {
                    ch = (JSON.parse(raw) as Channel[])
                      .map(normalizeChannel)
                      .find((c) => c.id === id);
                  }
                } catch {
                  /* ignore */
                }
              }
              return ch;
            })(),
            mediaType: opts.mediaType,
            llm: opts.llm,
            count: LLM_BATCH_SIZE,
          }),
        });
        if (res.status === 409) {
          setSyncedRatingCount(0);
          continue;
        }
        if (!res.ok) continue;
        setSyncedRatingCount(historyRef.current.length);
        const data = (await res.json()) as { movies?: CurrentMovie[] };
        const movies = data.movies?.filter((m) => m?.title) ?? [];
        if (movies.length > 0) return movies;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          console.warn("next-movie request timed out after", timeoutMs, "ms");
        }
      } finally {
        window.clearTimeout(timer);
      }
    }
    return null;
  }, []);

  // LLM round-trip. Daisy-chains: after each batch completes, immediately starts another
  // if the queue is below HIGH_WATER_MARK, so the queue is continuously filled.
  const replenish = useCallback(async (
    opts: { mediaType: string; llm: string },
    extraRetrySkips: string[] = []
  ): Promise<Set<string>> => {
    /** Career mode walks a fixed TMDB filmography; do not mix in channel LLM picks. */
    if (careerModeRef.current) return new Set();
    if (replenishGenInFlight.current >= MAX_REPLENISH_IN_FLIGHT) return new Set();
    replenishOptsRef.current = opts;

    const genAtStart = replenishGenRef.current;
    replenishInFlight.current++;
    replenishGenInFlight.current++;
    lensIndexRef.current++; // advance lens so concurrent batches each explore a different area
    const seenThisBatch = new Set<string>();

    // Refresh taste summary in parallel with the batch fetch so it's ready for the next call.
    updateTasteSummary(historyRef.current, opts.llm);

    try {
      const skippedForApi = [
        ...skippedRef.current,
        ...passedRef.current,
        ...extraRetrySkips,
        ...prefetchRef.current.map((m) => m.title),
        ...navBackStackRef.current.map((m) => m.title),
        ...(currentRef.current?.title ? [currentRef.current.title] : []),
        ...prefetchRef.current
          .filter((m) => viewedTitleKeysRef.current.has(canonicalTitleKey(m.title)))
          .map((m) => m.title),
      ];

      const movies = await fetchMovieBatch({
        mediaType: opts.mediaType,
        llm: opts.llm,
        skipped: skippedForApi,
      });

      if (genAtStart !== replenishGenRef.current) return seenThisBatch;

      let freshCount = 0;

      if (movies) {
        // After await, re-check against latest refs -- avoids a slower in-flight request
        // re-adding a title the user just rated while another replenish was in flight.
        const excluded = new Set<string>();
        for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
        for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
        for (const p of passedRef.current) excluded.add(canonicalTitleKey(p));
        for (const w of watchlistRef.current) excluded.add(canonicalTitleKey(w.title));
        for (const m of prefetchRef.current) excluded.add(canonicalTitleKey(m.title));
        for (const key of viewedTitleKeysRef.current) excluded.add(key);
        const cur = currentRef.current;
        if (cur?.title) excluded.add(canonicalTitleKey(cur.title));

        for (const movie of movies) {
          if (prefetchRef.current.length >= HIGH_WATER_MARK) break;
          const key = canonicalTitleKey(movie.title);
          seenThisBatch.add(key);
          if (prefetchRef.current.some((m) => canonicalTitleKey(m.title) === key)) continue;
          if (excluded.has(key)) continue;
          excluded.add(key);
          prefetchRef.current = [...prefetchRef.current, movie];
          freshCount++;
        }
      }

      batchYieldRef.current = [...batchYieldRef.current.slice(-4), freshCount / LLM_BATCH_SIZE];
      zeroYieldStreakRef.current = freshCount > 0 ? 0 : zeroYieldStreakRef.current + 1;
      persistPrefetchQueue();
    } finally {
      replenishInFlight.current--;
      if (genAtStart === replenishGenRef.current) replenishGenInFlight.current = Math.max(0, replenishGenInFlight.current - 1);
      // Daisy-chain: keep filling until high-water mark, but stop if recent batches are all dupes.
      // zeroYieldStreak >= 3 means the LLM is stuck -- no point hammering it further.
      if (
        genAtStart === replenishGenRef.current &&
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishGenInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish(replenishOptsRef.current);
      }
    }

    return seenThisBatch;
  }, [fetchMovieBatch, persistPrefetchQueue, updateTasteSummary]);

  // Pop instantly from prefetch queue; if empty, wait for replenish first
  const fetchNext = useCallback(async (
    opts: { mediaType: string; llm: string },
    isFirst = false
  ) => {
    setFetchError(null);
    if (!isFirst) {
      advanceFetchDepthRef.current += 1;
      setIsAdvancingCard(true);
    }
    try {
      // Drain the queue, skipping any title the user already decided on (guards against stale prefetch entries).
      while (prefetchRef.current.length > 0) {
        const [next, ...rest] = prefetchRef.current;
        prefetchRef.current = rest;
        const excluded = new Set<string>();
        for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
        for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
        for (const p of passedRef.current) excluded.add(canonicalTitleKey(p));
        for (const w of watchlistRef.current) excluded.add(canonicalTitleKey(w.title));
        if (excluded.has(canonicalTitleKey(next.title))) continue; // already seen -- discard silently
        persistPrefetchQueue();
        pushNavBack(currentRef.current);
        setCurrent(next);
        setInitialLoading(false);
        // Always keep MAX_REPLENISH_IN_FLIGHT batches running so the queue never drains while waiting.
        if (replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT) replenish(opts);
        return;
      }
      persistPrefetchQueue();

      // Queue empty -- wait for whatever is already in-flight, or start a fresh batch.
      try {
        zeroYieldStreakRef.current = 0; // reset so the daisy-chain can run
        if (replenishGenInFlight.current === 0) replenish(opts); // no current-gen batch running -- kick one off
        const deadline = Date.now() + 90_000;
        while (prefetchRef.current.length === 0 && replenishGenInFlight.current > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const next = prefetchRef.current.shift();
        persistPrefetchQueue();
        if (!next) {
          setInitialLoading(false);
          setFetchError("Couldn't find a new title. Try again.");
          return;
        }
        pushNavBack(currentRef.current);
        setCurrent(next);
        setInitialLoading(false);
        setFetchError(null);
      } catch (e) {
        console.error("fetchNext failed:", e);
        setInitialLoading(false);
        setFetchError("Something went wrong. Try again.");
      }
    } finally {
      if (!isFirst) {
        advanceFetchDepthRef.current -= 1;
        if (advanceFetchDepthRef.current === 0) setIsAdvancingCard(false);
      }
    }
  }, [replenish, persistPrefetchQueue, pushNavBack]);

  const fetchNextRef = useRef(fetchNext);
  fetchNextRef.current = fetchNext;

  const clearAdvanceAfterRating = useCallback(() => {
    const t = advanceAfterRatingTimeoutRef.current;
    if (t != null) {
      clearTimeout(t);
      advanceAfterRatingTimeoutRef.current = null;
    }
  }, []);

  const scheduleAdvanceAfterRating = useCallback(() => {
    clearAdvanceAfterRating();
    advanceAfterRatingTimeoutRef.current = setTimeout(() => {
      advanceAfterRatingTimeoutRef.current = null;
      void fetchNext({ mediaType, llm });
    }, 500);
  }, [clearAdvanceAfterRating, fetchNext, mediaType, llm]);

  useEffect(() => () => clearAdvanceAfterRating(), [clearAdvanceAfterRating]);

  const removeFromPrefetchQueue = useCallback(
    (displayIndex: number) => {
      const movie = getUpcomingQueueForDisplay()[displayIndex];
      if (!movie) return;
      const actualIndex = prefetchRef.current.findIndex(
        (m) => canonicalTitleKey(m.title) === canonicalTitleKey(movie.title),
      );
      if (actualIndex < 0) return;
      prefetchRef.current = prefetchRef.current.filter((_, i) => i !== actualIndex);
      persistPrefetchQueue();
      if (
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishGenInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish({ mediaType, llm });
      }
    },
    [mediaType, llm, replenish, persistPrefetchQueue, getUpcomingQueueForDisplay]
  );

  const playPrefetchAtIndex = useCallback(
    (displayIndex: number) => {
      const movie = getUpcomingQueueForDisplay()[displayIndex];
      if (!movie) return;
      const q = prefetchRef.current;
      const actualIndex = q.findIndex(
        (m) => canonicalTitleKey(m.title) === canonicalTitleKey(movie.title),
      );
      if (actualIndex < 0) return;
      if (current && canonicalTitleKey(movie.title) === canonicalTitleKey(current.title)) return;
      clearAdvanceAfterRating();
      replenishGenRef.current += 1;
      replenishGenInFlight.current = 0;
      prefetchRef.current = q.filter((_, i) => i !== actualIndex);
      persistPrefetchQueue();
      pushNavBack(currentRef.current);
      setCurrent(movie);
      setInitialLoading(false);
      setFetchError(null);
      zeroYieldStreakRef.current = 0;
      if (
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishGenInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish({ mediaType, llm });
      }
    },
    [mediaType, llm, replenish, persistPrefetchQueue, pushNavBack, current, getUpcomingQueueForDisplay]
  );

  useEffect(() => {
    if (homeHydrationEffectRanRef.current) return;
    homeHydrationEffectRanRef.current = true;

    const stored = localStorage.getItem(STORAGE_KEY);
    const hist: RatingEntry[] = stored ? (JSON.parse(stored) as RatingEntry[]).map(migrateRatingEntry) : [];
    const storedSkipped = localStorage.getItem(SKIPPED_KEY);
    const skip: string[] = storedSkipped ? JSON.parse(storedSkipped) : [];
    const storedWl = localStorage.getItem(WATCHLIST_KEY);
    const wl: WatchlistEntry[] = storedWl ? JSON.parse(storedWl) : [];
    const storedNi = localStorage.getItem(NOT_INTERESTED_KEY);
    const ni: { title: string; rtScore?: string | null }[] = storedNi ? JSON.parse(storedNi) : [];
    const storedNotSeen = localStorage.getItem(NOTSEEN_KEY);
    notSeenRef.current = storedNotSeen ? (JSON.parse(storedNotSeen) as NotSeenEvent[]) : [];
    historyRef.current = hist;
    skippedRef.current = skip;
    const storedPassed = localStorage.getItem(PASSED_KEY);
    const passedList: string[] = storedPassed ? JSON.parse(storedPassed) : [];
    passedRef.current = passedList;

    watchlistRef.current = wl;
    notInterestedRef.current = ni;

    let chs: Channel[] = [];
    try {
      const cRaw = localStorage.getItem(CHANNELS_KEY);
      if (cRaw) {
        chs = (JSON.parse(cRaw) as Channel[]).map(normalizeChannel);
        if (!chs.find((c) => c.id === "all")) {
          chs = [ALL_CHANNEL, ...chs];
        }
      }
    } catch {
      /* ignore */
    }
    const defaultCh = chs.length > 0 ? chs[0].id : "all";
    const storedActive = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    const activeForPrefetch = storedActive || defaultCh;
    activeChannelIdRef.current = activeForPrefetch;
    if (chs.length > 0) {
      channelsRef.current = chs;
    }
    loadPrefetchIntoRefForChannel(activeForPrefetch);
    persistPrefetchQueue();

    // Handle incoming share link (?share=id), then fall through to reconsider / fetchNext.
    const shareId = new URLSearchParams(window.location.search).get("share");
    void (async () => {
      if (shareId) {
        window.history.replaceState({}, "", "/");
        let handled = false;
        try {
          const res = await fetch(`/api/share?id=${encodeURIComponent(shareId)}`);
          if (res.ok) {
            const payload = await res.json() as { channel?: Channel | null; current?: CurrentMovie | null };
            // Full export when nothing stored; otherwise add any missing bundled channels.
            // Share fetch runs after mount, so hasNoChannelsPersisted() is usually false even on first
            // visit--merge is what repopulates the rest of the factory pack (e.g. after following ?share=).
            if (hasNoChannelsPersisted()) applyFactoryBootstrap();
            mergeFactoryChannelsAndQueues();
            if (payload.channel) {
              const raw = localStorage.getItem(CHANNELS_KEY);
              let chs: Channel[] = raw ? (JSON.parse(raw) as Channel[]).map(normalizeChannel) : [];
              if (!chs.find((c) => c.id === "all")) chs = [ALL_CHANNEL, ...chs];
              if (!chs.find((c) => c.id === payload.channel!.id)) {
                chs = [...chs, normalizeChannel(payload.channel)];
                localStorage.setItem(CHANNELS_KEY, JSON.stringify(chs));
              }
              setChannels(chs);
              channelsRef.current = chs;
              const activeId = payload.channel.id;
              localStorage.setItem(ACTIVE_CHANNEL_KEY, activeId);
              setActiveChannelId(activeId);
              activeChannelIdRef.current = activeId;
            } else {
              const raw = localStorage.getItem(CHANNELS_KEY);
              if (raw) {
                let list: Channel[] = (JSON.parse(raw) as Channel[]).map(normalizeChannel);
                if (!list.find((c) => c.id === "all")) {
                  list = [ALL_CHANNEL, ...list];
                  localStorage.setItem(CHANNELS_KEY, JSON.stringify(list));
                }
                setChannels(list);
                channelsRef.current = list;
              }
            }
            if (payload.current) {
              setCurrent(payload.current);
              setInitialLoading(false);
              replenish({ mediaType, llm });
              handled = true;
            }
          }
        } catch {}
        if (handled) return;
      }

      // Check if the Ratings page asked us to reconsider a title
      const pendingReconsider = localStorage.getItem(RECONSIDER_KEY);
      if (pendingReconsider) {
        localStorage.removeItem(RECONSIDER_KEY);
        try {
          const m = JSON.parse(pendingReconsider);
          const movie: CurrentMovie = {
            title: m.title,
            type: m.type ?? "movie",
            year: m.year ?? null,
            director: m.director ?? null,
            predictedRating: migrateRatingValue(typeof m.predictedRating === "number" ? m.predictedRating : 3),
            actors: m.actors ?? [],
            plot: m.plot ?? "",
            posterUrl: m.posterUrl ?? null,
            trailerKey: m.trailerKey ?? null,
            rtScore: m.rtScore ?? null,
            reason: null,
          };
          setCurrent(movie);
          setInitialLoading(false);
          replenish({ mediaType, llm });
          return;
        } catch {}
      }

      const restored = loadCurrentMovieForChannel(activeForPrefetch);
      if (restored) {
        setCurrent(restored);
        setInitialLoading(false);
        replenish({ mediaType, llm });
        return;
      }

      fetchNextRef.current({ mediaType, llm }, true);
    })();
    // Mount once: this effect also called fetchNext(…, true) at the end. Including fetchNext
    // in the dependency array re-ran the whole effect when fetchNext was recreated, popping an extra title.
  }, []) /* eslint-disable-line react-hooks/exhaustive-deps -- explicit single hydration + initial pick */;

  // Persist the active channel's current card (same channel only -- not on channel switch).
  useEffect(() => {
    const chId = activeChannelIdRef.current;
    if (!chId || !current?.title) return;
    persistCurrentMovieForChannel(chId, current);
  }, [current]);
  useEffect(() => {
    setPendingRating((p) => (p == null ? p : null));
    setCardNavSeq((n) => n + 1);
  }, [current?.title]);

  // Submit pending rating on unmount (Next.js client-side navigation) or page unload
  useEffect(() => {
    const handleUnload = () => {
      const p = pendingRatingRef.current;
      if (p) submitRatingRef.current(p.stars, p.mode);
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      handleUnload();
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  // On mobile, nudge the card into view when a new title loads -- only if needed; avoid smooth scroll (feels like a jump on tap)
  const isFirstCard = useRef(true);
  useEffect(() => {
    if (!current?.title) return;
    if (isFirstCard.current) {
      isFirstCard.current = false;
      return;
    }
    if (careerModeRef.current) return;
    if (window.innerWidth >= 640) return;
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.top >= 0 && rect.bottom <= vh) return;
    el.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [current?.title]);

  // When mediaType changes, replace the current card if it doesn't match
  useEffect(() => {
    if (!current) return;
    if (mediaType !== "both" && current.type !== mediaType) {
      replenishGenRef.current += 1;
      replenishGenInFlight.current = 0;
      prefetchRef.current = [];
      persistPrefetchQueue();
      batchYieldRef.current = [];
      fetchNext({ mediaType, llm });
    }
  }, [mediaType]); // eslint-disable-line react-hooks/exhaustive-deps

  // When userRequest changes (debounced 600ms), flush the prefetch queue so
  // upcoming cards reflect the new request rather than stale pre-fetched batches.
  // Do not run on initial mount -- that would clear an imported queue ~600ms after load.
  useEffect(() => {
    const prev = prevUserRequestForFlushRef.current;
    if (prev === undefined) {
      prevUserRequestForFlushRef.current = userRequest;
      return;
    }
    if (prev === userRequest) return;
    prevUserRequestForFlushRef.current = userRequest;
    const t = setTimeout(() => {
      replenishGenRef.current += 1;
      replenishGenInFlight.current = 0;
      prefetchRef.current = [];
      persistPrefetchQueue();
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
    }, 600);
    return () => clearTimeout(t);
  }, [userRequest, persistPrefetchQueue]);

  // When active channel changes: save the previous channel's queue, load the new channel's queue.
  useEffect(() => {
    if (!activeChannelId) return;
    localStorage.setItem(ACTIVE_CHANNEL_KEY, activeChannelId);

    const prev = savedPrefetchChannelRef.current;
    if (prev !== null && prev !== activeChannelId) {
      const leaving = currentRef.current;
      if (leaving?.trailerKey) {
        const t = canonicalTitleKey(leaving.title);
        setTrailerResumeByChannel((m) => {
          const ch = { ...(m[prev] || {}), [t]: watchFracRef.current };
          const next = { ...m, [prev]: ch };
          try {
            sessionStorage.setItem(TRAILER_RESUME_KEY, JSON.stringify(next));
          } catch {
            /* ignore */
          }
          return next;
        });
      }
      if (leaving?.title) {
        persistCurrentMovieForChannel(prev, leaving);
      }
      replenishGenRef.current += 1;
      replenishGenInFlight.current = 0;
      try {
        localStorage.setItem(prefetchQueueStorageKey(prev), JSON.stringify(prefetchRef.current));
      } catch {
        /* ignore */
      }
      loadPrefetchIntoRefForChannel(activeChannelId);
      persistPrefetchQueue();
      navBackStackRef.current = [];
      viewedTitleKeysRef.current = new Set();
      setNavBackDepth(0);
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
      savedPrefetchChannelRef.current = activeChannelId;
      const restored = loadCurrentMovieForChannel(activeChannelId);
      if (restored?.title) {
        setCurrent(restored);
        setInitialLoading(false);
        replenish({ mediaType, llm });
      } else {
        const hasQueued = prefetchRef.current.length > 0;
        void fetchNext({ mediaType, llm }, hasQueued);
      }
      return;
    }
    savedPrefetchChannelRef.current = activeChannelId;
  }, [activeChannelId, mediaType, llm, fetchNext, loadPrefetchIntoRefForChannel, persistPrefetchQueue, replenish]);

  const confirmDeleteChannelFromHome = useCallback(() => {
    const ch = channelPendingDelete;
    if (!ch || ch.id === "all") {
      setChannelPendingDelete(null);
      return;
    }
    const id = ch.id;
    clearChannelPersistedData(id);
    const next = normalizeChannelList(channels.filter((c) => c.id !== id)).map(normalizeChannel);
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
    setChannels(next);
    channelsRef.current = next;

    if (activeChannelId === id) {
      const fallback = next[0]?.id ?? "all";
      localStorage.setItem(ACTIVE_CHANNEL_KEY, fallback);
      setActiveChannelId(fallback);
    }
    setChannelPendingDelete(null);
  }, [channelPendingDelete, channels, activeChannelId]);

  const mergeStartersKeepActive = useCallback(() => {
    mergeFactoryChannelsAndQueues();
    try {
      const raw = localStorage.getItem(CHANNELS_KEY);
      const next = normalizeChannelList(raw ? (JSON.parse(raw) as Channel[]) : []).map(normalizeChannel);
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
      setChannels(next);
      channelsRef.current = next;
    } catch {
      /* ignore */
    }
  }, []);

  const loadStarterChannelsFromFactory = useCallback(() => {
    mergeFactoryChannelsAndQueues();
    try {
      const raw = localStorage.getItem(CHANNELS_KEY);
      const next = normalizeChannelList(raw ? (JSON.parse(raw) as Channel[]) : []).map(normalizeChannel);
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
      setChannels(next);
      channelsRef.current = next;
      const firstNonAll = next.find((c) => c.id !== "all");
      const active = firstNonAll?.id ?? next[0]?.id ?? "all";
      localStorage.setItem(ACTIVE_CHANNEL_KEY, active);
      setActiveChannelId(active);
    } catch {
      /* ignore */
    }
  }, []);

  const writeSeenRating = useCallback((
    movie: CurrentMovie,
    rating: number,
    ratingMode: "seen" | "unseen" = "seen",
    opts?: { replenish?: boolean },
  ) => {
    rating = clampStarRating(rating);
    const predicted = migrateRatingValue(movie.predictedRating);
    const error = Math.abs(rating - predicted);
    const channelId = activeChannelIdRef.current || undefined;
    const titleKey2 = canonicalTitleKey(movie.title);
    const existingEntry = historyRef.current.findLast(
      (e) => canonicalTitleKey(e.title) === titleKey2
    );
    const entry: RatingEntry = {
      title: movie.title,
      type: movie.type,
      userRating: rating,
      predictedRating: predicted,
      error,
      rtScore: movie.rtScore,
      channelId,
      posterUrl: movie.posterUrl,
      ratingMode,
      watchFrac: watchFracRef.current > 0 ? watchFracRef.current : existingEntry?.watchFrac,
      presentedAt: existingEntry?.presentedAt ?? new Date().toISOString(),
      categories: movie.categories?.length ? movie.categories : existingEntry?.categories,
    };
    const titleKey = canonicalTitleKey(movie.title);
    const newHistory = [...historyRef.current];
    const lastIdx = newHistory.findLastIndex((e) => canonicalTitleKey(e.title) === titleKey);
    if (lastIdx >= 0) newHistory[lastIdx] = entry;
    else newHistory.push(entry);
    saveHistory(newHistory);
    zeroYieldStreakRef.current = 0;
    if (opts?.replenish !== false && !careerModeRef.current) replenish({ mediaType, llm });
  }, [llm, mediaType, replenish]);

  const handleRate = (rating: number, ratingMode: "seen" | "unseen" = "seen") => {
    if (!current) return;
    writeSeenRating(current, rating, ratingMode);
  };

  /** Single entry point for all star clicks. Red = seen (goes to history). Blue = unseen (4-5 → watchlist, 1-3 → not-interested). */
  const submitRating = (stars: number, mode: "seen" | "unseen") => {
    if (mode === "seen") {
      handleRate(stars, "seen");
    } else {
      recordNotSeen(stars >= 4 ? "want" : "skip", stars);
    }
  };

  /** Advance -- submits any pending star rating, otherwise marks title as passed (no rating). */
  const passCurrentCard = () => {
    if (!current) return;
    clearAdvanceAfterRating();
    const p = pendingRatingRef.current;
    if (p) {
      if (p.mode === "seen") {
        const saved = getHistoryEntryForTitle(historyRef.current, current.title);
        const starsNorm = clampStarRating(p.stars);
        if (!saved || saved.userRating !== starsNorm) {
          writeSeenRating(current, p.stars, "seen");
        } else if (!careerModeRef.current) {
          replenish({ mediaType, llm });
        }
      } else {
        submitRatingRef.current(p.stars, p.mode);
      }
      pendingRatingRef.current = null;
      setPendingRating(null);
    } else {
      const autoStars = WATCH_PROGRESS_AUTO_RATING ? progressToStars(watchFracRef.current) : 0;
      if (autoStars > 0) {
        submitRatingRef.current(autoStars, "seen");
      } else {
        const t = current.title;
        if (watchFracRef.current > 0) {
          const tk = canonicalTitleKey(t);
          const idx = historyRef.current.findLastIndex((e) => canonicalTitleKey(e.title) === tk);
          if (idx >= 0) {
            const updated = [...historyRef.current];
            updated[idx] = { ...updated[idx], watchFrac: watchFracRef.current };
            saveHistory(updated);
          }
        }
        const newPassed = [...passedRef.current, t];
        localStorage.setItem(PASSED_KEY, JSON.stringify(newPassed));
        passedRef.current = newPassed;
      }
    }
    const cm = careerModeRef.current;
    if (cm) {
      if (cm.index < cm.films.length - 1) void careerNavigate(cm.index + 1);
    } else {
      zeroYieldStreakRef.current = 0;
      fetchNext({ mediaType, llm });
    }
  };

  const recordNotSeen = (kind: "want" | "skip", interestStars: number) => {
    if (!current) return;
    const snapshot = current;
    const chId = activeChannelIdRef.current?.trim() || "all";
    const starsNorm = migrateRatingValue(interestStars);

    let newWatchlist = watchlistRef.current;
    if (kind === "want") {
      // Save immediately with empty streaming so the card advances without waiting
      const entry: WatchlistEntry = {
        title: snapshot.title,
        type: snapshot.type,
        year: snapshot.year,
        director: snapshot.director,
        actors: snapshot.actors,
        plot: snapshot.plot,
        posterUrl: snapshot.posterUrl,
        rtScore: snapshot.rtScore,
        streaming: [],
        addedAt: new Date().toISOString(),
      };
      newWatchlist = [entry, ...watchlistRef.current.filter((w) => w.title !== snapshot.title)];
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
      watchlistRef.current = newWatchlist;

      // Patch streaming in the background
      fetch("/api/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: snapshot.title, year: snapshot.year, llm }),
      }).then(r => r.ok ? r.json() : { services: [] })
        .then(({ services }: { services: string[] }) => {
          if (!services.length) return;
          const updated = watchlistRef.current.map((w) =>
            w.title === snapshot.title ? { ...w, streaming: services } : w);
          watchlistRef.current = updated;
          localStorage.setItem(WATCHLIST_KEY, JSON.stringify(updated));
        })
        .catch(() => {});
    }

    const nsEvent: NotSeenEvent = { afterRating: historyRef.current.length, kind };
    const newNotSeen = [...notSeenRef.current, nsEvent];
    notSeenRef.current = newNotSeen;
    localStorage.setItem(NOTSEEN_KEY, JSON.stringify(newNotSeen));

    // Remove the null-rating (presented) entry from ratingHistory if present
    const snapKey = canonicalTitleKey(snapshot.title);
    const histWithoutPresented = historyRef.current.filter(
      (e) => !(canonicalTitleKey(e.title) === snapKey && e.userRating === null)
    );
    if (histWithoutPresented.length !== historyRef.current.length) {
      saveHistory(histWithoutPresented);
    }
    const existingWatchFrac = historyRef.current.find(
      (e) => canonicalTitleKey(e.title) === snapKey
    )?.watchFrac;
    const logRow: UnseenInterestEntry = {
      title: snapshot.title,
      type: snapshot.type,
      year: snapshot.year,
      director: snapshot.director,
      actors: snapshot.actors,
      plot: snapshot.plot,
      posterUrl: snapshot.posterUrl,
      rtScore: snapshot.rtScore,
      interestStars: starsNorm,
      kind,
      channelId: chId,
      at: new Date().toISOString(),
      watchFrac: watchFracRef.current > 0 ? watchFracRef.current : existingWatchFrac,
    };
    pushUnseenInterestEntry(logRow);
    setUnseenLogRevision((n) => n + 1);

    const newSkipped = [...skippedRef.current, snapshot.title];
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    skippedRef.current = newSkipped;

    // For "not interested" items, store with RT score so the server can surface high-RT dismissals
    // as a taste signal (user diverges from critical consensus).
    let newNotInterested = notInterestedRef.current;
    if (kind === "skip") {
      newNotInterested = [...notInterestedRef.current, { title: snapshot.title, rtScore: snapshot.rtScore }];
      localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(newNotInterested));
      notInterestedRef.current = newNotInterested;
    }

    watchlistRef.current = newWatchlist;
    zeroYieldStreakRef.current = 0; // new exclusion may unblock the LLM
    if (!careerModeRef.current) replenish({ mediaType, llm });
  };

  const submitRatingRef = useRef(submitRating);
  submitRatingRef.current = submitRating;

  const passCurrentCardRef = useRef(passCurrentCard);
  passCurrentCardRef.current = passCurrentCard;
  const passCurrentCardStable = useCallback(() => {
    passCurrentCardRef.current();
  }, []);

  const handlePendingChange = useCallback((stars: number, mode: "seen" | "unseen") => {
    const next = { stars, mode };
    pendingRatingRef.current = next;
    setPendingRating(next);
    const movie = currentRef.current;
    if (!movie) return;
    const key = canonicalTitleKey(movie.title);
    sessionRatingsRef.current = { ...sessionRatingsRef.current, [key]: next };
    setSessionRatingsRevision((n) => n + 1);
    if (mode === "seen") {
      writeSeenRating(movie, stars, "seen", { replenish: false });
    }
    // In poster mode, auto-advance to next item after rating
    if (displayMode === "posters") {
      passCurrentCardStable();
    }
  }, [writeSeenRating, displayMode, passCurrentCardStable]);

  const openPosterLightbox = useCallback((url: string) => {
    setLightboxUrl(url);
  }, []);

  const careerNavigate = useCallback(async (index: number, films?: CareerFilm[]) => {
    const cm = careerModeRef.current;
    const filmList = films ?? cm?.films ?? [];
    if (!filmList[index]) return;
    const film = filmList[index];
    setCareerMode((prev) => {
      if (!prev) return null;
      if (prev.index === index) return prev;
      return { ...prev, index };
    });
    // Same title as the card already showing (e.g. opened an actor for this movie) -- keep trailer so the player does not stop/restart.
    setCurrent((prev) => {
      if (isSameFilmAsCurrent(prev, film)) {
        const posterUrl = film.posterUrl ?? prev!.posterUrl;
        if (prev!.posterUrl === posterUrl) return prev;
        return { ...prev!, posterUrl };
      }
      return {
        ...(prev ?? { title: film.title, type: film.type, year: film.year, director: null, predictedRating: 3, actors: [], plot: "", rtScore: null, reason: null, trailerKey: null }),
        title: film.title, type: film.type, year: film.year, posterUrl: film.posterUrl, trailerKey: null,
      };
    });
    setCareerLoading((s) => (s ? s : true));
    try {
      const res = await fetch(`/api/career/movie?tmdbId=${film.tmdbId}&type=${film.type}`);
      if (res.ok) {
        const full = await res.json() as CurrentMovie;
        setCurrent((p) => {
          if (p && isSameFilmAsCurrent(p, film)) {
            const merged: CurrentMovie = { ...full, trailerKey: full.trailerKey ?? p.trailerKey };
            return currentMovieEquals(merged, p) ? p : merged;
          }
          if (p && currentMovieEquals(full, p)) return p;
          return full;
        });
      }
    } catch { /* ignore */ } finally {
      setCareerLoading((s) => (s ? false : s));
    }
  }, []);

  const handleCareerPrev = useCallback(() => {
    const cm = careerModeRef.current;
    if (cm) void careerNavigate(cm.index - 1);
  }, [careerNavigate]);

  const handleCareerListSelect = useCallback((i: number) => {
    void careerNavigate(i);
  }, [careerNavigate]);

  const goToPreviousCard = useCallback(() => {
    if (careerModeRef.current) {
      handleCareerPrev();
      return;
    }
    const stack = navBackStackRef.current;
    if (stack.length === 0) return;
    const prevMovie = stack[stack.length - 1]!;
    navBackStackRef.current = stack.slice(0, -1);
    setNavBackDepth(navBackStackRef.current.length);
    const cur = currentRef.current;
    if (cur) {
      prefetchRef.current = [cur, ...prefetchRef.current].slice(0, HIGH_WATER_MARK);
      persistPrefetchQueue();
    }
    suppressNavPushRef.current = true;
    setCurrent(prevMovie);
    setInitialLoading(false);
    suppressNavPushRef.current = false;
  }, [handleCareerPrev, persistPrefetchQueue]);

  const goToPreviousCardRef = useRef(goToPreviousCard);
  goToPreviousCardRef.current = goToPreviousCard;

  const prevNav = useMemo((): { onPass: () => void; disabled: boolean } => {
    if (careerMode) {
      return { onPass: handleCareerPrev, disabled: careerMode.index === 0 };
    }
    return { onPass: goToPreviousCard, disabled: navBackDepth === 0 };
  }, [careerMode, careerMode?.index, handleCareerPrev, goToPreviousCard, navBackDepth]);

  const careerAtLastFilm = useMemo(
    () => Boolean(careerMode && careerMode.films.length > 0 && careerMode.index === careerMode.films.length - 1),
    [careerMode],
  );

  const currentDisplayRating = useMemo(
    () =>
      current?.title
        ? getDisplayRatingForTitle(
            current.title,
            historyRef.current,
            sessionRatingsRef.current,
            loadUnseenInterestLog(),
          )
        : undefined,
    [current?.title, historyRevision, sessionRatingsRevision, unseenLogRevision],
  );

  const ratingCardKey = current ? `${current.title}:${cardNavSeq}` : "";

  const enterCareerMode = useCallback(async (name: string, role: "actor" | "director") => {
    setCareerLoading((s) => (s ? s : true));
    try {
      const res = await fetch(`/api/career?name=${encodeURIComponent(name)}&role=${role}`);
      if (!res.ok) return;
      const data = await res.json() as { personName: string; films: CareerFilm[] };
      if (!data.films?.length) return;
      const currentTitle = current?.title ?? "";
      const startIndex = data.films.findIndex(
        (f) => f.title.toLowerCase() === currentTitle.toLowerCase()
      );
      const index = startIndex >= 0 ? startIndex : 0;
      const cm: CareerMode = { personName: data.personName, role, films: data.films, index };
      // Drop in-flight LLM queue so it cannot mix with filmography picks.
      replenishGenRef.current += 1;
      replenishGenInFlight.current = 0;
      prefetchRef.current = [];
      navBackStackRef.current = [];
      viewedTitleKeysRef.current = new Set();
      setNavBackDepth(0);
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
      persistPrefetchQueue();
      setCareerMode(cm);
      careerModeRef.current = cm;
      await careerNavigate(index, data.films);
    } catch { /* ignore */ } finally {
      setCareerLoading((s) => (s ? false : s));
    }
  }, [current?.title, careerNavigate, persistPrefetchQueue]);

  const exitCareerMode = useCallback(() => {
    setCareerMode(null);
    careerModeRef.current = null;
    const o = replenishOptsRef.current;
    zeroYieldStreakRef.current = 0;
    void replenish({ mediaType: o.mediaType, llm: o.llm });
    if (prefetchRef.current.length === 0) {
      void fetchNext({ mediaType: o.mediaType, llm: o.llm });
    }
  }, [replenish, fetchNext]);

  const handleShare = useCallback(async () => {
    if (!current) return;
    const ch = channelsRef.current.find((c) => c.id === activeChannelIdRef.current);
    setShareToast("copying");
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: ch ?? null, current }),
      });
      const { id } = await res.json() as { id: string };
      const url = `${window.location.origin}/?share=${id}`;
      await navigator.clipboard.writeText(url);
      setShareToast("copied");
      setTimeout(() => setShareToast(null), 2500);
    } catch {
      setShareToast(null);
    }
  }, [current]);

  const selectChannel = useCallback((id: string) => {
    setActiveChannelId(id);
  }, []);

  const requestDeleteChannel = useCallback((ch: Channel) => {
    setChannelPendingDelete(ch);
  }, []);

  const getChannelPromptForSave = useCallback(() => {
    const id = activeChannelIdRef.current;
    if (id === "all") return userRequestRef.current.trim();
    const ch = channelsRef.current.find((c) => c.id === id);
    return (ch?.freeText ?? "").trim();
  }, []);

  /** Flush prefetch and reload so the next titles match the current prompt (also re-saves All → settings). */
  const updateThisChannel = useCallback(() => {
    if (!activeChannelIdRef.current) return;
    if (activeChannelIdRef.current === "all") {
      try {
        const s = localStorage.getItem(SETTINGS_KEY);
        const base = s ? (JSON.parse(s) as Record<string, unknown>) : {};
        localStorage.setItem(
          SETTINGS_KEY,
          JSON.stringify({ ...base, userRequest: userRequestRef.current }),
        );
      } catch {
        /* ignore */
      }
    } else {
      try {
        localStorage.setItem(CHANNELS_KEY, JSON.stringify(channelsRef.current));
      } catch {
        /* ignore */
      }
    }
    replenishGenRef.current += 1;
    replenishGenInFlight.current = 0;
    prefetchRef.current = [];
    persistPrefetchQueue();
    batchYieldRef.current = [];
    zeroYieldStreakRef.current = 0;
    void fetchNext({ mediaType, llm }, true);
  }, [mediaType, llm, fetchNext, persistPrefetchQueue]);

  const createChannelFromHomePrompt = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    let list: Channel[] = [];
    try {
      const raw = localStorage.getItem(CHANNELS_KEY);
      list = raw ? (JSON.parse(raw) as Channel[]).map(normalizeChannel) : [];
      if (!list.some((c) => c.id === "all")) {
        list = [ALL_CHANNEL, ...list];
      }
    } catch {
      list = [ALL_CHANNEL];
    }
    const data = channelDraftFromPrompt(t);
    const ch = normalizeChannel({ ...data, id: crypto.randomUUID() });
    const next = insertChannelAfterAll(list, ch);
    try {
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setChannels(next);
    channelsRef.current = next;
    localStorage.setItem(ACTIVE_CHANNEL_KEY, ch.id);
    setActiveChannelId(ch.id);
  }, []);

  const openNewChannelFromMovie = useCallback(
    (movie: MovieChannelSeedInput) => {
      queueNewChannelFromMovie(movie, (path) => router.push(path));
    },
    [router],
  );

  const hubUrl = process.env.NEXT_PUBLIC_HUB_URL || "http://127.0.0.1:8000";

  return (
    <div className="flex min-h-screen w-full flex-col bg-black px-3 py-3 sm:px-4 sm:py-5 lg:px-8 lg:py-6">
      <div className="mx-auto flex w-full max-w-[min(100%,90rem)] flex-col gap-4 lg:grid lg:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)] lg:items-start lg:gap-x-8 lg:gap-y-0 xl:grid-cols-[minmax(15rem,24rem)_minmax(0,1fr)] xl:gap-x-12">
        <aside className="flex min-w-0 flex-col gap-2 sm:gap-3 lg:sticky lg:top-11 lg:z-10 lg:max-h-[calc(100dvh-3.5rem)] lg:self-start lg:pr-1">
          <p className="hidden text-[11px] font-semibold uppercase tracking-wide text-zinc-500 lg:block">
            Channels
          </p>
          <div className="shrink-0 rounded-xl border border-zinc-800/90 bg-zinc-950/80 p-2 sm:rounded-2xl sm:p-3">
            <label htmlFor="channel-what-you-want" className="mb-1 hidden text-xs font-medium text-zinc-400 sm:block">
              New channel
            </label>
            <div className="flex flex-row items-stretch gap-1.5 sm:flex-col sm:gap-2">
              <div className="relative min-w-0 flex-1">
                <textarea
                  id="channel-what-you-want"
                  autoComplete="off"
                  rows={1}
                  value={newChannelText}
                  onChange={(e) => setNewChannelText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey) return;
                    e.preventDefault();
                    if (!newChannelText.trim()) return;
                    createChannelFromHomePrompt(newChannelText);
                    setNewChannelText("");
                  }}
                  placeholder="Genres, era, directors…"
                  className="min-h-8 max-h-16 w-full resize-none rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 pr-7 text-xs leading-snug text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 sm:min-h-9 sm:max-h-none sm:resize-y sm:px-3 sm:py-2 sm:pr-9 sm:text-sm"
                />
                {newChannelText.length > 0 && (
                  <button
                    type="button"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setNewChannelText("")}
                    className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded text-sm leading-none text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 sm:right-1.5 sm:top-1.5 sm:h-7 sm:w-7 sm:text-base"
                    title="Clear"
                    aria-label="Clear"
                  >
                    ×
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  createChannelFromHomePrompt(newChannelText);
                  setNewChannelText("");
                }}
                disabled={!newChannelText.trim()}
                title="Create a new channel with this text"
                className="h-8 shrink-0 self-stretch rounded-lg bg-indigo-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:pointer-events-none disabled:opacity-40 sm:h-10 sm:w-full sm:px-3 sm:text-sm"
              >
                <span className="sm:hidden">Add</span>
                <span className="hidden sm:inline">Create channel</span>
              </button>
            </div>
          </div>

          <ChannelsToolbar
            channels={channels}
            activeChannelId={activeChannelId}
            onLoadStarter={loadStarterChannelsFromFactory}
            onMergeStarters={mergeStartersKeepActive}
            showMergeStarterPack={factoryPackFullyMerged === false}
            onSelectChannel={selectChannel}
            onRequestDeleteChannel={requestDeleteChannel}
          />

        </aside>

        <div className="flex min-w-0 flex-col gap-4 sm:gap-5 lg:min-h-0">
        {/* Movie card */}
        <div
          ref={cardRef}
          className="bg-zinc-950 rounded-2xl border border-zinc-800 shadow-sm overflow-hidden scroll-mt-4 sm:scroll-mt-8 md:scroll-mt-14"
        >
          {initialLoading ? (
            <MovieCardSkeleton mode={displayMode} />
          ) : current ? (
            <div className="relative">
              {careerMode && (
                <div
                  className="flex flex-col gap-2 border-b border-indigo-500/35 bg-indigo-950/45 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-4 sm:py-3.5"
                  title="LLM pick queue is paused. Only the filmography list below is used until you exit."
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-2xl font-bold leading-tight tracking-tight text-indigo-50 sm:text-3xl break-words">
                      {careerMode.personName}
                    </p>
                    <p className="mt-1 text-sm text-indigo-300/90">
                      {careerMode.role === "director" ? "Director" : "Actor"} filmography · {careerMode.index + 1} of {careerMode.films.length}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={exitCareerMode}
                    className="shrink-0 self-end rounded-lg border border-indigo-500/50 bg-indigo-900/50 px-2.5 py-1.5 text-xs font-semibold text-indigo-100 transition-colors hover:bg-indigo-800/80 sm:self-center"
                  >
                    Exit career
                  </button>
                </div>
              )}
              {displayMode === "trailers" ? (
                /* ── TRAILER LAYOUT ── */
                <div
                  ref={careerTrailerBlockRef}
                  className="bg-black transition-opacity duration-300"
                  style={
                    careerMode && careerLoading && careerTrailerBlockStableH > 0
                      ? { minHeight: careerTrailerBlockStableH }
                      : undefined
                  }
                >
                  {current.trailerKey ? (
                    <div
                      ref={videoContainerRef}
                      className={`flex min-h-0 flex-col bg-black ${
                        pseudoTrailerFullscreen ? "fixed inset-0 z-[70] overflow-y-auto overscroll-y-contain" : "relative"
                      }`}
                    >
                      <div
                        className={`relative flex min-h-0 flex-col w-full bg-black ${
                          trailerFsUi ? "min-h-0 flex-1" : ""
                        }`}
                      >
                        <TrailerPlayer
                          videoId={current.trailerKey}
                          onProgress={setWatchFrac}
                          onPlaybackError={handleTrailerPlaybackError}
                          resumeFromFraction={
                            trailerResumeByChannel[activeChannelId]?.[canonicalTitleKey(current.title)]
                          }
                        />
                      </div>
                      {trailerFsUi && (
                        <TrailerFullscreenChrome
                          onExit={() => void exitTrailerFullscreen()}
                          passCurrentCardStable={passCurrentCardStable}
                          onRate={handlePendingChange}
                          movieTitle={current.title}
                          watchFrac={watchFrac}
                          defaultSeen={activeChannelId === "all"}
                          previousRating={currentDisplayRating?.stars}
                          previousMode={currentDisplayRating?.mode}
                          ratingResetKey={ratingCardKey}
                          prevNav={prevNav}
                          careerNextDisabled={careerAtLastFilm}
                        />
                      )}
                    </div>
                  ) : current.posterUrl && !current.trailerKey ? (
                    <div
                      ref={videoContainerRef}
                      className={`flex min-h-0 flex-col bg-black ${
                        pseudoTrailerFullscreen ? "fixed inset-0 z-[70] overflow-y-auto overscroll-y-contain" : ""
                      }`}
                    >
                      {trailerFsUi ? (
                        <TrailerFullscreenChrome
                          onExit={() => void exitTrailerFullscreen()}
                          passCurrentCardStable={passCurrentCardStable}
                          onRate={handlePendingChange}
                          movieTitle={current.title}
                          watchFrac={watchFrac}
                          defaultSeen={activeChannelId === "all"}
                          previousRating={currentDisplayRating?.stars}
                          previousMode={currentDisplayRating?.mode}
                          ratingResetKey={ratingCardKey}
                          prevNav={prevNav}
                          careerNextDisabled={careerAtLastFilm}
                        >
                          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black px-4 pb-36 pt-16">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={current.posterUrl}
                              alt={`${current.title} poster`}
                              referrerPolicy="no-referrer"
                              className="max-h-full max-w-full object-contain"
                            />
                          </div>
                        </TrailerFullscreenChrome>
                      ) : (
                        <div className="border-b border-zinc-800/80 bg-zinc-950 p-4 sm:p-6">
                          <PosterMovieTop
                            movie={current}
                            onOpenPoster={openPosterLightbox}
                            onPersonClick={enterCareerMode}
                            onCreateChannelFromMovie={openNewChannelFromMovie}
                            careerPersonName={careerMode?.personName ?? null}
                            detailsLoading={careerLoading}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div ref={videoContainerRef} className="relative bg-black">
                      <div className="flex aspect-video w-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
                        {careerLoading ? "Loading trailer…" : null}
                      </div>
                    </div>
                  )}
                  {!trailerFsUi && (current.trailerKey || current.posterUrl) && (
                    <TrailerMediaActions
                      onFullscreen={() => void enterTrailerFullscreen()}
                      onShare={handleShare}
                      shareToast={shareToast}
                    />
                  )}
                  {!trailerFsUi && !careerMode && (
                    <div className="px-3 pt-2 sm:px-6">
                      <div className="flex rounded-2xl overflow-hidden border border-zinc-700 w-fit">
                        {(["posters", "trailers"] as const).map(mode => (
                          <button key={mode} type="button"
                            onClick={() => { setDisplayMode(mode); saveSetting("displayMode", mode); }}
                            className={`px-3 py-2 text-xs font-semibold capitalize transition-colors ${displayMode === mode ? "bg-zinc-200 text-zinc-900" : "bg-transparent text-zinc-500 hover:text-zinc-200"}`}
                          >{mode}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {!trailerFsUi && (
                    <MovieRatingBlock
                      key={ratingCardKey}
                      layout="trailerBar"
                      passCurrentCardStable={passCurrentCardStable}
                      onRate={handlePendingChange}
                      movieTitle={current.title}
                      starKeyPrefix="tr"
                      watchFrac={watchFrac}
                      defaultSeen={activeChannelId === "all"}
                      previousRating={currentDisplayRating?.stars}
                      previousMode={currentDisplayRating?.mode}
                      ratingResetKey={ratingCardKey}
                      prevNav={prevNav}
                      careerNextDisabled={careerAtLastFilm}
                    />
                  )}
                  {!trailerFsUi && (
                  <>
                  <div className="flex flex-col gap-4 p-4 sm:pb-6 sm:p-6">
                    {current.trailerKey && (
                      <TrailerMetadata
                        movie={current}
                        onPersonClick={enterCareerMode}
                        onCreateChannelFromMovie={openNewChannelFromMovie}
                        careerPersonName={careerMode?.personName ?? null}
                      />
                    )}
                    {!current.trailerKey && !current.posterUrl && (
                      <div className="flex justify-end">
                        <ShareButton onClick={handleShare} toast={shareToast} />
                      </div>
                    )}
                    {current.reason && (
                      <p className="text-sm text-zinc-400 leading-relaxed border-l-2 border-zinc-600 pl-3">
                        {current.reason}
                      </p>
                    )}

                    {careerMode ? (
                      <CareerFilmographyPanel
                        career={careerMode}
                        onSelect={handleCareerListSelect}
                        onExit={exitCareerMode}
                        loading={careerLoading}
                      />
                    ) : (
                      <PrefetchQueuePanel
                        prefetchQueueUi={prefetchQueueUi}
                        channels={channels}
                        activeChannelId={activeChannelId}
                        onPlayAtIndex={playPrefetchAtIndex}
                        onRemoveAtIndex={removeFromPrefetchQueue}
                        onCreateChannelFromMovie={openNewChannelFromMovie}
                      />
                    )}
                  </div>
                  {current.trailerKey && current.posterUrl && (
                    <div className="flex w-full min-w-0 justify-center border-t border-zinc-800 bg-zinc-950 px-3 pb-4 pt-3 sm:px-6 sm:pb-5 sm:pt-3">
                      <button
                        type="button"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => openPosterLightbox(current.posterUrl!)}
                        className="w-1/2 min-w-0 max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-zinc-800/90 shadow-sm transition-shadow hover:border-zinc-600"
                        title="View poster"
                        aria-label={`View ${current.title} poster full size`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={current.posterUrl}
                          alt={`${current.title} poster`}
                          referrerPolicy="no-referrer"
                          className="mx-auto block h-auto w-full max-h-72 object-contain object-top sm:max-h-80"
                        />
                      </button>
                    </div>
                  )}
                  </>
                  )}
                </div>
              ) : (
                /* ── POSTER MODE ── */
                <div className="flex flex-col gap-4 p-4 sm:p-6 transition-opacity duration-300">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <PosterMovieTop
                        movie={current}
                        onOpenPoster={openPosterLightbox}
                        onPersonClick={enterCareerMode}
                        onCreateChannelFromMovie={openNewChannelFromMovie}
                        careerPersonName={careerMode?.personName ?? null}
                        detailsLoading={careerLoading}
                        showPoster
                      />
                    </div>
                    <div className="shrink-0 pt-0.5">
                      <ShareButton onClick={handleShare} toast={shareToast} />
                    </div>
                  </div>
                  {current.reason && (
                    <p className="text-sm text-zinc-400 leading-relaxed border-l-2 border-zinc-600 pl-3">
                      {current.reason}
                    </p>
                  )}

                  {!careerMode && (
                    <div className="flex">
                      <div className="flex rounded-2xl overflow-hidden border border-zinc-700">
                        {(["posters", "trailers"] as const).map(mode => (
                          <button key={mode} type="button"
                            onClick={() => { setDisplayMode(mode); saveSetting("displayMode", mode); }}
                            className={`px-3 py-2 text-xs font-semibold capitalize transition-colors ${displayMode === mode ? "bg-zinc-200 text-zinc-900" : "bg-transparent text-zinc-500 hover:text-zinc-200"}`}
                          >{mode}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <MovieRatingBlock
                    key={ratingCardKey}
                    passCurrentCardStable={passCurrentCardStable}
                    onRate={handlePendingChange}
                    movieTitle={current.title}
                    starKeyPrefix="po"
                    defaultSeen={activeChannelId === "all"}
                    previousRating={currentDisplayRating?.stars}
                    previousMode={currentDisplayRating?.mode}
                    ratingResetKey={ratingCardKey}
                    prevNav={prevNav}
                    careerNextDisabled={careerAtLastFilm}
                  />
                  {careerMode ? (
                    <CareerFilmographyPanel
                      career={careerMode}
                      onSelect={handleCareerListSelect}
                      onExit={exitCareerMode}
                      loading={careerLoading}
                    />
                  ) : (
                    <PrefetchQueuePanel
                      prefetchQueueUi={prefetchQueueUi}
                      channels={channels}
                      activeChannelId={activeChannelId}
                      onPlayAtIndex={playPrefetchAtIndex}
                      onRemoveAtIndex={removeFromPrefetchQueue}
                      onCreateChannelFromMovie={openNewChannelFromMovie}
                    />
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex gap-3 px-1 py-1">
          <Link
            href={`/channels${activeChannelId && activeChannelId !== "all" ? `?select=${activeChannelId}` : ""}`}
            className="text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Edit Channel
          </Link>
          <span className="text-zinc-700 text-sm select-none">·</span>
          <Link href="/channel-history" className="text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors">
            Channel History
          </Link>
        </div>

        {current ? (
          <div className="w-full overflow-hidden rounded-2xl border border-zinc-800/90 bg-zinc-950/80">
            <TrailerVisionConstellationsEmbed
              nowPlayingKey={constellationsNowPlayingKey}
              autoExpandMatchTitles={constellationsAutoExpand}
              externalSearch={constellationsExternalSearch}
              onNewChannelFromNode={(node) =>
                queueNewChannelFromGraphNode(node, (path) => router.push(path))
              }
            />
          </div>
        ) : null}

        {/* Taste profile card */}
        <div className="bg-zinc-950 rounded-2xl border border-zinc-800 shadow-sm p-4">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">AI&apos;s model of your taste</p>
          {tasteSummary ? (
            <p className="text-sm text-zinc-300 leading-relaxed" style={{ borderLeft: "3px solid #a78bfa", paddingLeft: "12px" }}>
              {tasteSummary}
            </p>
          ) : (
            <p className="text-sm text-zinc-600 italic">Rate a few titles to build your taste profile.</p>
          )}
        </div>

        </div>
      </div>

      {/* Fetch error with retry */}
      {fetchError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-red-900 text-white text-sm shadow-lg">
          <span>{fetchError}</span>
          <button
            onClick={() => fetchNext({ mediaType, llm })}
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Thinking indicator -- fixed so it's always visible */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-zinc-900 text-white text-sm shadow-lg transition-all duration-300 ${isAdvancingCard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        <div className="flex gap-1">
          {[0,1,2].map(i => (
            <div key={i} className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        LLM is thinking…
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Poster"
            className="max-h-[90vh] max-w-[90vw] rounded-2xl shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <ConfirmDialog
        open={channelPendingDelete !== null}
        title="Delete channel"
        tone="danger"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onCancel={() => setChannelPendingDelete(null)}
        onConfirm={confirmDeleteChannelFromHome}
      >
        {channelPendingDelete ? (
          <>
            Delete <span className="font-medium text-zinc-800">&quot;{channelPendingDelete.name}&quot;</span>? This
            cannot be undone.
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
