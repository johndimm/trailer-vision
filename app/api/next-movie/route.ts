import type { CategoryPath } from "../../lib/categoryTree";

export interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  /** 0.5–5 half-star scale. Legacy 0–100 is migrated client-side. */
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
  /** "seen" = red-star rating after watching; "unseen" = blue-star interest rating */
  ratingMode?: "seen" | "unseen";
  categories?: string[];
  categoryPaths?: CategoryPath[];
}


export interface NextMovieResponse {
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
  streaming: string[];
  /** Genre/category tags returned by the LLM */
  categories: string[];
  /** Kept for backward compat with stored history — always empty from this route now */
  categoryPaths: CategoryPath[];
}

/** One entry inside the LLM "items" array — snake_case from model output */
interface RawItem {
  title?: string;
  type?: "movie" | "tv";
  year?: number | null;
  director?: string | null;
  actors?: string[];
  plot?: string;
  rt_score?: string | null;
  reason?: string | null;
  streaming_services?: unknown;
  /** 2–4 short genre/category tags assigned by the LLM */
  categories?: string[];
}

import {
  migrateRatingValue,
  rtTomatometerPercentToStars,
} from "../../lib/ratingScale";
import { fetchTmdbAssets, resolveMovieFromTmdbByTitle } from "../../lib/tmdbAssets";
import { directTitlePromptFromRequest, directTitleConstraintLine, llmTitlePrefixCandidates, parseDirectTitleRequest, sanitizeLlmMovieTitle, type DirectTitleRequest } from "../../lib/parseDirectTitleRequest";

/**
 * Items per LLM response. Client may request up to MAX_BATCH; larger responses need more output budget below.
 */
const DEFAULT_BATCH = 5;
const MAX_BATCH = 8;
/** Max entries in system prompt context history (selected by recency + RT divergence). */
const MAX_HISTORY_LINES = 50;
/** Max entries shown in user message for ratings added this session. */
const MAX_SESSION_HISTORY_LINES = 25;
/** Scales with batch size (8 titles × short JSON + reasons + categories). */
const LLM_OUTPUT_MAX_TOKENS = 3000;

function stripMarkdownJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** Balanced `[ ... ]` or `{ ... }` with string-aware bracket tracking. */
function extractBalancedJson(
  text: string,
  open: "[" | "{",
  close: "]" | "}"
): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractRootJsonObject(text: string): string | null {
  return extractBalancedJson(text, "{", "}");
}

function extractRootJsonArray(text: string): string | null {
  return extractBalancedJson(text, "[", "]");
}

/** Every complete `{...}` object in the text (string-aware). Salvages truncated batch responses. */
function extractAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start < 0) break;
    const obj = extractRootJsonObject(text.slice(start));
    if (!obj) {
      i = start + 1;
      continue;
    }
    out.push(obj);
    i = start + obj.length;
  }
  return out;
}

function repairTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Fix the LLM habit of emitting two string values for a single key, e.g.:
 *   "director": "A", "B",   →   "director": "A, B",
 * Handles one or two extra orphan string values after the main value.
 */
function repairDoubleStringValues(json: string): string {
  return json.replace(
    /("(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/g,
    (_m, kv, extra1, extra2) => {
      // kv = "key": "val1" — merge extra1 and extra2 into val1
      const valEnd = kv.lastIndexOf('"');
      return kv.slice(0, valEnd) + ", " + JSON.parse(extra1) + ", " + JSON.parse(extra2) + '"';
    }
  ).replace(
    /("(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*(?=,\s*"(?:[^"\\]|\\.)*"\s*:)/g,
    (_m, kv, extra) => {
      const valEnd = kv.lastIndexOf('"');
      return kv.slice(0, valEnd) + ", " + JSON.parse(extra) + '"';
    }
  );
}

function tryParseJson(text: string): unknown | null {
  const repaired = repairDoubleStringValues(text);
  const candidates = [
    text,
    repaired,
    repairTrailingCommas(text),
    repairTrailingCommas(repaired),
    text.replace(/[\r\n]+/g, " "),
    repaired.replace(/[\r\n]+/g, " "),
    repairTrailingCommas(text.replace(/[\r\n]+/g, " ")),
    repairTrailingCommas(repaired.replace(/[\r\n]+/g, " ")),
    extractRootJsonObject(text),
    extractRootJsonObject(repaired),
    extractRootJsonArray(text),
    extractRootJsonArray(repaired),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const candidate of candidates) {
    for (const variant of [candidate, repairTrailingCommas(candidate)]) {
      try {
        return JSON.parse(variant);
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function isRawItem(o: unknown): o is RawItem {
  if (!o || typeof o !== "object") return false;
  const r = o as RawItem;
  return typeof r.title === "string" && (r.type === "movie" || r.type === "tv");
}

function collectItemsFromRoot(root: unknown): { items: RawItem[]; tasteSummary: string | null } {
  let items: RawItem[] = [];
  let tasteSummary: string | null = null;

  if (Array.isArray(root)) {
    items = root.filter(isRawItem);
  } else if (root && typeof root === "object") {
    const o = root as Record<string, unknown>;
    if (typeof o.taste_summary === "string") tasteSummary = o.taste_summary.trim() || null;
    if (Array.isArray(o.items)) items = o.items.filter(isRawItem);
    else if (Array.isArray(o.titles)) items = o.titles.filter(isRawItem);
    else if (isRawItem(o)) items = [o];
  }

  return { items, tasteSummary };
}

function parseLlmResponse(text: string, fallbackObjects: string[]): { items: RawItem[]; tasteSummary: string | null } {
  const stripped = stripMarkdownJsonFence(text);

  let items: RawItem[] = [];
  let tasteSummary: string | null = null;

  const root = tryParseJson(stripped);
  if (root !== null) {
    const collected = collectItemsFromRoot(root);
    items = collected.items;
    tasteSummary = collected.tasteSummary;
  }

  if (items.length === 0) {
    const objectCandidates = [
      ...fallbackObjects,
      ...extractAllJsonObjects(stripped),
    ];
    const seen = new Set<string>();
    for (const objText of objectCandidates) {
      const parsed = tryParseJson(objText);
      if (!parsed) continue;
      const collected = collectItemsFromRoot(parsed);
      if (!tasteSummary && collected.tasteSummary) tasteSummary = collected.tasteSummary;
      for (const item of collected.items) {
        const key = item.title!.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
      if (isRawItem(parsed)) {
        const key = parsed.title!.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          items.push(parsed);
        }
      }
    }
  }

  if (items.length === 0) throw new Error("no JSON");
  return { items, tasteSummary };
}

/** Parse "91%" → 91, returns null if unparseable */
function parseRtPercent(rtScore: string | null | undefined): number | null {
  if (!rtScore) return null;
  const n = parseInt(rtScore, 10);
  return Number.isFinite(n) ? n : null;
}

function divergenceScore(entry: RatingEntry): number {
  const u = migrateRatingValue(entry.userRating);
  const rt = parseRtPercent(entry.rtScore);
  return rt !== null ? Math.abs(u - rtTomatometerPercentToStars(rt)) : 0;
}

function selectInformativeHistory(history: RatingEntry[], maxEntries: number): RatingEntry[] {
  if (history.length <= maxEntries) return history;
  const recentCount = Math.min(Math.floor(maxEntries / 4), 10);
  const recentEntries = history.slice(-recentCount);
  const recentKeys = new Set(recentEntries.map((e) => e.title.toLowerCase()));
  const olderEntries = history.slice(0, -recentCount).filter((e) => !recentKeys.has(e.title.toLowerCase()));
  const remainingSlots = maxEntries - recentEntries.length;
  const scored = olderEntries.map((entry) => ({ entry, divergence: divergenceScore(entry) }));
  scored.sort((a, b) => b.divergence - a.divergence);
  return [...scored.slice(0, remainingSlots).map((s) => s.entry), ...recentEntries];
}

import { callLLM } from "./llm";

interface ChannelPayload {
  id: string;
  name: string;
  /** Subset of movie / TV; omitted or empty = no extra format line. */
  mediums?: ("movie" | "tv")[];
  genres: string[];
  timePeriods: string[];
  /** Streaming services the title must be available on (empty = no filter). */
  streaming?: string[];
  language: string;
  artists: string;
  freeText: string;
  popularity: number;
}

function buildMediumsConstraintLine(mediums: ChannelPayload["mediums"]): string | null {
  if (!mediums?.length) return null;
  const uniq = [...new Set(mediums)].filter((m): m is "movie" | "tv" =>
    m === "movie" || m === "tv"
  );
  if (uniq.length === 0 || uniq.length === 2) return null;
  const parts = uniq.map((m) =>
    m === "movie"
      ? "theatrical feature films (each item type must be \"movie\")"
      : "TV series / episodic shows (each item type must be \"tv\")"
  );
  return `- Format / medium: Only recommend titles that fit: ${parts.join(" OR ")}.`;
}

function buildChannelConstraint(ch: ChannelPayload, mediaType: "movie" | "tv" | "both"): string {
  const lines: string[] = [];
  const mediumLine = buildMediumsConstraintLine(ch.mediums);
  if (mediumLine) lines.push(mediumLine);

  // Check channel name first (may be a direct movie title like "The Thing")
  const name = ch.name.trim();
  const nameAsTitle = name && !name.toLowerCase().endsWith("channel") ? parseDirectTitleRequest(name, mediaType) : null;

  const freeText = ch.freeText.trim();
  const directTitle = freeText ? parseDirectTitleRequest(freeText, mediaType) : null;

  if (directTitle) {
    lines.push(`- ${directTitleConstraintLine(directTitle)}`);
  } else if (nameAsTitle) {
    lines.push(`- ${directTitleConstraintLine(nameAsTitle)}`);
  } else if (freeText) {
    lines.push(
      `- What they want (primary — align genres/era/etc. below with this): ${freeText}`,
    );
  } else if (name) {
    lines.push(
      `- What they want (primary): ${name}`,
    );
  }
  if (ch.genres.length) lines.push(`- Genres: ${ch.genres.join(", ")}`);
  if (ch.timePeriods.length) lines.push(`- Time periods: ${ch.timePeriods.join(", ")}`);
  if (ch.streaming?.length) lines.push(`- Streaming availability: Only recommend titles currently available to stream on ${ch.streaming.join(" or ")} (in the US). Skip anything not on these services.`);
  if (ch.language.trim()) lines.push(`- Language: ${ch.language.trim()}`);
  if (ch.artists.trim()) lines.push(`- Focus on work by: ${ch.artists.trim()}`);

  const pop = ch.popularity;
  if (pop <= 15) lines.push("- Popularity: Hidden gems only — obscure, underseen, cult, or arthouse titles. Avoid mainstream blockbusters entirely.");
  else if (pop <= 35) lines.push("- Popularity: Mostly obscure — prefer lesser-known films, avoid the biggest blockbusters.");
  else if (pop <= 45) lines.push("- Popularity: Lean obscure — mix of hidden gems and mid-range titles, avoiding mainstream hits.");
  else if (pop <= 55) lines.push("- Popularity: Balanced mix of mainstream and hidden gems.");
  else if (pop <= 65) lines.push("- Popularity: Lean mainstream — prefer well-known titles, include some lesser-known.");
  else if (pop <= 85) lines.push("- Popularity: Mostly mainstream — well-known, popular titles.");
  else lines.push("- Popularity: Mainstream only — widely-known, popular, commercially successful titles.");

  if (lines.length === 0) return "";
  return `CHANNEL — "${ch.name}" — HARD CONSTRAINT: Every item MUST fit this channel. Requirements:\n${lines.join("\n")}`;
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    /** Unified rated history from before this session (seen + unseen) — sent in system prompt context (stable, cacheable). */
    channelHistory?: RatingEntry[];
    /** Unified ratings made this session (seen + unseen) — sent in user message. */
    sessionHistory?: RatingEntry[];
    skipped?: string[];
    watchlistTitles?: Array<string | { title: string; rtScore?: string | null }>;
    /** Taste profile from the end of the previous session — frozen at session start, goes in system prompt context. */
    prevSessionTasteSummary?: string;
    /** Taste profile from the last LLM call this session — updated each replenishment, goes in user message. */
    tasteSummary?: string;
    userRequest?: string;
    activeChannel?: ChannelPayload;
    mediaType?: "movie" | "tv" | "both";
    llm?: string;
    count?: number;
    /** CLI taste tests: skip TMDB poster/trailer enrichment (avoids YouTube API calls). */
    skipAssets?: boolean;
  };

  const channelHistory: RatingEntry[] = raw.channelHistory ?? [];
  const sessionHistory: RatingEntry[] = raw.sessionHistory ?? [];
  const history = [...channelHistory, ...sessionHistory];

  const skipped = raw.skipped ?? [];
  // Support both legacy string[] and new {title, rtScore}[] formats
  const rawWatchlistItems = raw.watchlistTitles ?? [];
  const watchlistItems: { title: string; rtScore?: string | null }[] = rawWatchlistItems.map((item) =>
    typeof item === "string" ? { title: item } : item
  );
  const watchlistTitles = watchlistItems.map((w) => w.title);
  const prevSessionTasteSummary = raw.prevSessionTasteSummary?.trim() || null;
  const inSessionTasteSummary = raw.tasteSummary?.trim() || null;
  const userRequest = raw.userRequest?.trim() || null;
  const activeChannel = raw.activeChannel ?? null;
  const mediaType = raw.mediaType ?? "both";
  const channelConstraint = (activeChannel && activeChannel.id !== "all") ? buildChannelConstraint(activeChannel, mediaType) : null;
  const llm = raw.llm ?? "deepseek";
  const countRaw = raw.count;
  const skipAssets = raw.skipAssets === true;

  const batchCount = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(countRaw) || DEFAULT_BATCH)));

  const ratedTitles = history.map((h) => h.title);
  const allExcluded = [...new Set([...ratedTitles, ...skipped, ...watchlistTitles])];

  const directPrompt = directTitlePromptFromRequest({ userRequest, activeChannel });
  let directTitleAlreadySeen: DirectTitleRequest | null = null;
  if (directPrompt) {
    const channelMedium =
      activeChannel?.mediums?.length === 1 ? activeChannel.mediums[0] : null;
    const lookupMediaType = channelMedium ?? mediaType;
    const parsed = parseDirectTitleRequest(directPrompt, lookupMediaType);
    if (parsed) {
      const typeOk =
        mediaType === "both" ||
        (mediaType === "movie" && parsed.type === "movie") ||
        (mediaType === "tv" && parsed.type === "tv");
      if (typeOk) {
        const resolved = await resolveMovieFromTmdbByTitle(parsed.title, parsed.type, parsed.year);
        if (resolved) {
          const excluded = new Set(allExcluded.map((t) => t.toLowerCase()));
          if (!excluded.has(resolved.title.toLowerCase())) {
            const movie: NextMovieResponse = {
              title: resolved.title,
              type: resolved.type,
              year: resolved.year,
              director: resolved.director,
              predictedRating: 3,
              actors: resolved.actors,
              plot: resolved.plot,
              posterUrl: resolved.posterUrl,
              trailerKey: resolved.trailerKey,
              rtScore: null,
              reason: null,
              streaming: [],
              categories: [],
              categoryPaths: [],
            };
            console.log(
              `[next-movie] direct TMDB lookup for "${directPrompt}" → "${resolved.title}" (trailer=${resolved.trailerKey ? "yes" : "no"})`,
            );
            return Response.json({ movies: [movie] });
          }
          directTitleAlreadySeen = parsed;
        }
      }
    }
  }

  const titlePrefixCandidates = llmTitlePrefixCandidates({ activeChannel, userRequest, mediaType });

  // --- History sections ---

  // Unified channel history (seen + unseen, pre-session) → system prompt context (cached by Anthropic).
  const informativeChannelHistory = selectInformativeHistory(channelHistory, MAX_HISTORY_LINES);
  const channelHistorySection = (() => {
    if (channelHistory.length === 0) return "";
    const lines = informativeChannelHistory
      .map((h) => {
        const u = migrateRatingValue(h.userRating);
        const label = h.ratingMode === "unseen" ? " interest" : " seen";
        const rt = h.rtScore ? ` RT:${h.rtScore}` : "";
        return `- "${h.title}" (${h.type}): ★${u}/5${label}${rt}`;
      })
      .join("\n");
    const note = informativeChannelHistory.length < channelHistory.length
      ? `\n[${informativeChannelHistory.length} of ${channelHistory.length} shown — highest user/RT divergence plus most recent]`
      : "";
    return `CHANNEL RATING HISTORY (${channelHistory.length} title${channelHistory.length === 1 ? "" : "s"} rated before this session):\n${lines}${note}`;
  })();

  // --- Constraints ---

  const mediaConstraint =
    mediaType === "movie"
      ? 'IMPORTANT: Every item must be a movie only (not TV). Each "type" field must be "movie".'
      : mediaType === "tv"
        ? 'IMPORTANT: Every item must be a TV series only (not movies). Each "type" field must be "tv".'
        : "";

  const systemPromptContextParts: string[] = [];
  if (mediaConstraint) systemPromptContextParts.push(mediaConstraint);
  if (channelConstraint) systemPromptContextParts.push(channelConstraint);
  if (userRequest) {
    const directUserTitle = parseDirectTitleRequest(userRequest, mediaType);
    if (directUserTitle && !channelConstraint) {
      systemPromptContextParts.push(directTitleConstraintLine(directUserTitle));
    } else if (!directUserTitle) {
      systemPromptContextParts.push(
        `USER REQUEST — ADDITIONAL HARD CONSTRAINT: The user has also asked for "${userRequest}". Every item must satisfy BOTH the channel requirements above AND this request.`,
      );
    }
  }
  // Running taste profile from previous session — frozen at session start, stable for Anthropic caching.
  if (prevSessionTasteSummary) {
    systemPromptContextParts.push(
      `RUNNING TASTE PROFILE (from previous session — treat as primary signal):\n${prevSessionTasteSummary}`
    );
  }
  // Unified channel rating history (seen + unseen, pre-session) — stable, cached by Anthropic.
  if (channelHistorySection) systemPromptContextParts.push(channelHistorySection);

  const systemPromptContext =
    systemPromptContextParts.length > 0 ? systemPromptContextParts.join("\n\n") : null;

  const systemPrompt = `You are a movie/TV recommendation engine. Your job is to suggest titles that genuinely fit this user's taste, based on their rating history.

Your job each turn:
1. Propose ${batchCount} titles. The client removes duplicates against a large exclusion set you do not receive in full — repeats are OK; the app will filter.
2. Return title, year, director, top 3-4 actors, a 1-2 sentence plot summary, Rotten Tomatoes Tomatometer when known, and a one-sentence reason explaining why this title fits the user's taste — write it in second person, addressing the user as "you" (e.g. "You rated X highly" not "The user rated X highly").
3. For **each title** include **streaming_services**: a JSON array of US streaming platform names where the viewer can watch now — use short names: Netflix, Max, Hulu, Disney+, Apple TV+, Amazon Prime Video, Peacock, Paramount+, AMC+, STARZ, Tubi, Pluto TV. Use [] if unsure.
4. Respond with ONLY valid JSON — no markdown, no explanation:
{"items":[{"title":"...","type":"movie","year":1994,"director":"...","actors":["...","..."],"plot":"...","rt_score":"94%","reason":"...","streaming_services":["Netflix"],"categories":["tag1","tag2"]}]}

Rules:
- Return exactly ${batchCount} objects in "items" (unless absolutely impossible — then return as many distinct valid picks as you can)
- Avoid duplicate titles within "items" and try to avoid titles already in the channel history above — the app will filter duplicates as a safety net, but make your best effort
- "type" must be exactly "movie" or "tv"
- "title" must be the exact official release name only — never a sentence, channel label, or "description: title" format
- "year" is a number; "director" is a single string — if multiple directors, combine them: "A, B" (never two separate JSON values)
- "rt_score" is the Tomatometer percentage (e.g. "94%") or null if unknown
- "categories" is an array of 2–4 short genre/category tags you assign for this title
- All string values must be on a single line — no newline characters inside strings
- Maximize diversity across regions, eras, genres, languages, and traditions
- Vary genres, eras, and (if media allows) movie vs TV
- IMPORTANT: If CATEGORY PREFERENCES are provided below, treat them as the strongest signal — they show exactly what this viewer loves and avoids. Align your picks accordingly.`;

  // --- Category preferences from rated history ---

  const categoryPrefsSection = (() => {
    const catMap = new Map<string, number[]>();
    for (const e of history) {
      if (!e.categories?.length) continue;
      for (const cat of e.categories) {
        if (!catMap.has(cat)) catMap.set(cat, []);
        catMap.get(cat)!.push(e.userRating);
      }
    }
    const stats = [...catMap.entries()]
      .map(([cat, ratings]) => ({
        cat,
        avg: ratings.reduce((a, b) => a + b, 0) / ratings.length,
        count: ratings.length,
      }))
      .filter(s => s.count >= 2)
      .sort((a, b) => b.avg - a.avg);
    if (!stats.length) return "";

    const loved    = stats.filter(s => s.avg >= 4.0).map(s => `"${s.cat}" (${s.avg.toFixed(1)}★)`);
    const disliked = stats.filter(s => s.avg <= 2.0).map(s => `"${s.cat}" (${s.avg.toFixed(1)}★)`);
    if (!loved.length && !disliked.length) return "";

    const lines: string[] = [];
    if (loved.length)    lines.push(`Loves: ${loved.join(", ")}`);
    if (disliked.length) lines.push(`Avoids: ${disliked.join(", ")}`);
    return `CATEGORY PREFERENCES (from ${stats.reduce((a, s) => Math.max(a, s.count), 0)}+ ratings):\n${lines.join("\n")}\n\n`;
  })();

  const directTitleNote = directTitleAlreadySeen
    ? `The user asked specifically for "${directTitleAlreadySeen.title}"${directTitleAlreadySeen.year ? ` (${directTitleAlreadySeen.year})` : ""}, which they have already seen. Suggest ${batchCount} similar titles instead. Each "title" must be the exact official name only.\n\n`
    : "";

  const channelLockSection = channelConstraint
    ? `CHANNEL LOCK: All ${batchCount} titles MUST satisfy the channel requirements above. Stay within the requested style, era, and region — vary specific titles and filmmakers, not the genre. Do not wander outside the channel for "variety".\n\n`
    : "";

  const batchAskLine = channelConstraint
    ? `Suggest ${batchCount} on-channel candidates (vary specific titles and filmmakers, not genre or era).`
    : `Suggest ${batchCount} diverse candidates.`;

  const recentSessionHistory = sessionHistory.slice(-MAX_SESSION_HISTORY_LINES);
  const sessionHistoryText = recentSessionHistory.length === 0
    ? ""
    : recentSessionHistory.map((h) => {
        const u = migrateRatingValue(h.userRating);
        const label = h.ratingMode === "unseen" ? " interest" : " seen";
        const rt = h.rtScore ? ` RT:${h.rtScore}` : "";
        return `- "${h.title}" (${h.type}): ★${u}/5${label}${rt}`;
      }).join("\n");

  const newRatingsSection = sessionHistoryText
    ? `NEW RATINGS THIS SESSION:\n${sessionHistoryText}\n\n`
    : "";

  const inSessionTasteSummarySection = inSessionTasteSummary
    ? `UPDATED TASTE PROFILE (refined this session):\n${inSessionTasteSummary}\n\n`
    : "";

  const userMessage = `${channelLockSection}${directTitleNote}${categoryPrefsSection}${inSessionTasteSummarySection}${newRatingsSection}EXCLUSION (counts only — the app drops any repeat client-side):
${allExcluded.length} titles already decided (${ratedTitles.length} rated, ${watchlistTitles.length} on watchlist, ${skipped.length} skipped/dismissed). ${batchAskLine}

${history.length === 0
  ? channelConstraint
    ? `No ratings yet. Pick well-known, on-target exemplars of this channel's style.`
    : `No ratings yet. Spread picks widely across different regions, eras, and genres to calibrate taste quickly.`
  : `Pick titles that match this user's taste based on the channel history above. Spread picks across diverse genres, eras, and regions unless the channel constrains otherwise.`}`;


  // Set NEXT_MOVIE_LOG_LLM_PROMPTS=1 in .env.local to re-enable prompt logging when debugging.
  const logLlmPrompts = process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "1" || process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "true";
  if (logLlmPrompts) {
    console.log(
      `[next-movie] LLM submit (${llm}): ${batchCount} titles requested. context=${channelHistory.length} session=${sessionHistory.length} skipped=${skipped.length} excluded=${allExcluded.length}`
    );
    console.log("[next-movie] --- system prompt (base) ---\n" + systemPrompt);
    if (systemPromptContext) {
      console.log("[next-movie] --- system prompt (context) ---\n" + systemPromptContext);
    }
    console.log("[next-movie] --- user message ---\n" + userMessage);
  }

  function normalizeRawItems(rawItems: RawItem[]): NextMovieResponse[] {
    const seenKeys = new Set<string>();
    const out: NextMovieResponse[] = [];

    for (const raw of rawItems) {
      if (!raw?.title || (raw.type !== "movie" && raw.type !== "tv")) continue;
      const cleanedTitle = sanitizeLlmMovieTitle(raw.title, titlePrefixCandidates);
      if (!cleanedTitle) continue;
      const key = cleanedTitle.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const categories = Array.isArray(raw.categories)
        ? (raw.categories as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.toLowerCase())
        : [];

      out.push({
        title: cleanedTitle,
        type: raw.type,
        year: raw.year ?? null,
        director: raw.director ?? null,
        predictedRating: 3,
        actors: raw.actors ?? [],
        plot: raw.plot ?? "",
        posterUrl: null,
        trailerKey: null,
        rtScore: raw.rt_score ?? null,
        reason: raw.reason?.trim() || null,
        streaming: Array.isArray(raw.streaming_services)
          ? (raw.streaming_services as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim())
          : [],
        categories,
        categoryPaths: [],
      });
    }
    return out;
  }

  let text: string;
  const llmStart = Date.now();
  try {
    text = await callLLM(llm, systemPrompt, userMessage, {
      maxTokens: LLM_OUTPUT_MAX_TOKENS,
      systemPromptContext,
    });
    console.log(
      `[next-movie] LLM done (${llm}) in ${((Date.now() - llmStart) / 1000).toFixed(1)}s — output ${text.length} chars`,
    );
  } catch (err) {
    console.error(`[next-movie] LLM failed (${llm}) after ${((Date.now() - llmStart) / 1000).toFixed(1)}s:`, err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  const fallbackObjects = extractAllJsonObjects(stripMarkdownJsonFence(text));

  let rawItems: RawItem[];
  try {
    rawItems = parseLlmResponse(text, fallbackObjects).items;
  } catch (e) {
    console.error(
      "Failed to parse LLM response as JSON:",
      e,
      "\n--- response preview ---\n",
      text.slice(0, 1200),
      text.length > 1200 ? "\n...(truncated log)" : ""
    );
    return Response.json({ error: "Failed to parse response", raw: text.slice(0, 2000) }, { status: 500 });
  }

  const normalized = normalizeRawItems(rawItems);

  if (normalized.length === 0) {
    console.error("LLM returned no valid items");
    return Response.json({ error: "No valid titles in response" }, { status: 500 });
  }

  if (!skipAssets) {
    const assets = await Promise.all(
      normalized.map((m) => fetchTmdbAssets(m.title, m.type, m.year, m.director)),
    );
    for (let i = 0; i < normalized.length; i++) {
      const asset = assets[i];
      normalized[i] = {
        ...normalized[i],
        posterUrl: asset.posterUrl,
        trailerKey: asset.trailerKey,
        // Prefer TMDB year (authoritative) over LLM year (often hallucinated).
        year: asset.year ?? normalized[i].year,
      };
    }
  }

  return Response.json({
    movies: normalized,
    debug: {
      systemPrompt,
      systemPromptContext: systemPromptContext ?? null,
      userMessage,
    },
  });
}
