import type { CategoryPath, CategoryTree } from "../../lib/categoryTree";
import {
  buildChannelTreeTaggingSection,
  buildRoundOneSlots,
  buildTreeExplorationSection,
  formatRoundOneSlotRequirements,
  formatSlotValidationFeedback,
  formatTreeForPrompt,
  generateCategoryTree,
  resolveTreeForPreference,
  parseCategoryPathsFromRaw,
  pathsToDisplayCategories,
  superKey,
  validateBatchAgainstSlots,
} from "../../lib/categoryTree";
import { getSessionCategoryTree, saveSessionCategoryTree } from "./historySessionStore";

export interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  /** 0.5–5 half-star scale. Legacy 0–100 is migrated client-side. */
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
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
  /** Hierarchical paths in the session category tree */
  categoryPaths: CategoryPath[];
}

/** One entry inside the LLM "items" array — snake_case from model output */
interface RawItem {
  title?: string;
  type?: "movie" | "tv";
  year?: number | null;
  director?: string | null;
  predicted_rating?: number;
  actors?: string[];
  plot?: string;
  rt_score?: string | null;
  reason?: string | null;
  streaming_services?: unknown;
  /** 2–4 short genre/category tags assigned by the LLM */
  categories?: string[];
  category_paths?: unknown;
}

import {
  migrateRatingValue,
  normalizePredictedRating,
  rtTomatometerPercentToStars,
} from "../../lib/ratingScale";
import { fetchTmdbAssets, resolveMovieFromTmdbByTitle } from "../../lib/tmdbAssets";
import { directTitlePromptFromRequest, directTitleConstraintLine, llmTitlePrefixCandidates, parseDirectTitleRequest, sanitizeLlmMovieTitle, type DirectTitleRequest } from "../../lib/parseDirectTitleRequest";

/**
 * Items per LLM response. Client may request up to MAX_BATCH; larger responses need more output budget below.
 */
const DEFAULT_BATCH = 5;
const MAX_BATCH = 8;
/** Max rated lines in prompt — highest |user−RT| first (then |user−AI| if no RT). */
const MAX_HISTORY_DIVERGENCE_LINES = 32;
/** Curated unseen signals (low-RT saves, high-RT dismissals). */
const MAX_LOW_RT_WANT_LINES = 28;
const MAX_HIGH_RT_SKIP_LINES = 28;
const LOW_RT_THRESHOLD = 60; // want-to-watch: RT below this is a strong signal
const HIGH_RT_THRESHOLD = 70; // not interested: RT at/above this is a strong signal
/** Scales with batch size (8 titles × short JSON + reasons + categories). */
const LLM_OUTPUT_MAX_TOKENS = 3500;

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

/**
 * Taste information density: prefer |user − RT| (RT % mapped to same half-star scale); else |user − AI|.
 */
function divergenceScore(entry: RatingEntry): number {
  const u = migrateRatingValue(entry.userRating);
  const rt = parseRtPercent(entry.rtScore);
  if (rt !== null) {
    return Math.abs(u - rtTomatometerPercentToStars(rt));
  }
  return Math.abs(u - migrateRatingValue(entry.predictedRating));
}

function selectInformativeHistory(history: RatingEntry[], maxEntries: number): RatingEntry[] {
  if (history.length <= maxEntries) return history;
  // Reserve ~1/4 of slots for recency signal; fill the rest with highest-divergence entries.
  const recentCount = Math.min(Math.floor(maxEntries / 4), 10);
  const recentEntries = history.slice(-recentCount);
  const recentKeys = new Set(recentEntries.map((e) => e.title.toLowerCase()));
  const olderEntries = history.slice(0, -recentCount).filter((e) => !recentKeys.has(e.title.toLowerCase()));
  const remainingSlots = maxEntries - recentEntries.length;
  const scored = olderEntries.map((entry) => ({ entry, divergence: divergenceScore(entry) }));
  scored.sort((a, b) => b.divergence - a.divergence);
  const divergentEntries = scored.slice(0, remainingSlots).map((s) => s.entry);
  // Divergent first (context), recent last (freshest signal)
  return [...divergentEntries, ...recentEntries];
}

import { callLLM } from "./llm";
import { resolveHistoryForPrompt } from "./historySessionStore";

/**
 * In exploration mode (<20 ratings), ask the LLM to identify which categories/regions
 * we should explore NEXT, excluding ones already tried.
 */
/**
 * Analyze ratings to understand preference patterns using 20Q logic:
 * - Which categories user loves (4-5★)
 * - Which they avoid (1-2★)
 */
function analyzePreferenceSignals(history: RatingEntry[]): {
  loved: Map<string, number>;
  avoided: Map<string, number>;
  /** Tags that ever scored 3+ — never deprioritize these after a single low rating elsewhere */
  warmTags: Set<string>;
  hasSignal: boolean;
  topLoved: string[];
} {
  const lovedCats = new Map<string, number[]>();
  const avoidedCats = new Map<string, number[]>();
  const warmTags = new Set<string>();

  for (const entry of history) {
    if (!entry.categories?.length) continue;
    const rating = entry.userRating;
    for (const cat of entry.categories) {
      if (rating >= 3) warmTags.add(cat);
      if (rating >= 4) {
        if (!lovedCats.has(cat)) lovedCats.set(cat, []);
        lovedCats.get(cat)!.push(rating);
      } else if (rating <= 2) {
        if (!avoidedCats.has(cat)) avoidedCats.set(cat, []);
        avoidedCats.get(cat)!.push(rating);
      }
    }
  }

  const loved = new Map(
    [...lovedCats.entries()].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])
  );
  const avoided = new Map(
    [...avoidedCats.entries()].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])
  );

  const topLoved = [...loved.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => cat);

  return { loved, avoided, warmTags, hasSignal: loved.size > 0, topLoved };
}

/**
 * Generate strategic hypotheses to test using 20Q logic.
 */
function generateTestHypotheses(topLoved: string[]): string[] {
  if (topLoved.length === 0) return [];

  const hypotheses: string[] = [];

  // Core hypothesis: what's the primary dimension?
  if (topLoved.length >= 2) {
    const [primary, secondary] = topLoved;
    hypotheses.push(
      `Is it specifically "${primary}" or more broadly "${secondary}"-style content?`,
      `Does removing ${primary} break the appeal, or is ${secondary} enough?`
    );
  } else if (topLoved.length === 1) {
    hypotheses.push(
      `Is it specifically the "${topLoved[0]}" category or a broader pattern?`,
      `What's the core appeal: the cultural origin, the genre, the tone, or the production style?`
    );
  }

  // Dimensional hypotheses
  hypotheses.push(
    "Is it the storytelling tone (romantic, epic, comedy) or the category itself?",
    "Is it the region/culture or the specific genre conventions?",
    "Is it the production scale (spectacle, music, choreography) or the plot type?"
  );

  return hypotheses.slice(0, 5);
}

/**
 * In hypothesis-testing phase, ask LLM to design films that isolate dimensions.
 * Suggest exploring variations/sub-categories of what they love.
 */
async function generateHypothesisTestingPrompt(
  topLoved: string[],
  history: RatingEntry[],
  llm: string,
): Promise<string | null> {
  const hypotheses = generateTestHypotheses(topLoved);
  if (hypotheses.length === 0) return null;

  const lovedFilmExamples = history
    .filter(e => e.userRating >= 4 && e.categories?.length)
    .slice(-3)
    .map(e => `"${e.title}" (${e.categories?.join(", ")})`)
    .join(", ");

  // Ask LLM to suggest variations of loved categories
  const variationHint = topLoved.length > 0
    ? `Also explore variations within "${topLoved[0]}" that they haven't tried yet (sub-genres, adjacent eras, or same appeal from a different region).`
    : '';

  const systemPrompt = `You are designing strategic films to isolate which dimension of a user's taste matters most.
This is like 20 Questions: each film should test a specific hypothesis about why they love what they love.
Design films where the results (4★ vs 1★) will teach us something definitive.`;

  const prompt = `User LOVES: ${topLoved.join(", ")}
Examples: ${lovedFilmExamples}

${variationHint}

Test these hypotheses with 5 strategic films:
1. CONFIRM: Another example of exactly what they love (validate the pattern)
2. ISOLATE-DIMENSION-1: Same appeal but different dimension
3. ISOLATE-DIMENSION-2: Related but flip one key attribute
4. ISOLATE-TONE: Similar tone/emotion but different category (test if it's emotion or category)
5. BOUNDARY-TEST: Edge case that challenges the hypothesis (what breaks the spell?)

For each film, explain which hypothesis it tests.

Reply ONLY with JSON array:
[
  {"title": "Film Name", "year": 2020, "type": "movie", "hypothesis_tests": "CONFIRM: validates the loved pattern"},
  {"title": "Film Name", "year": 2015, "type": "movie", "hypothesis_tests": "ISOLATE-DIMENSION: is it genre or region?"},
  ...
]`;

  try {
    const response = await callLLM(llm, systemPrompt, prompt, {
      maxTokens: 500,
    });
    return response;
  } catch (e) {
    console.error("[generateHypothesisTestingPrompt] error:", e);
    return null;
  }
}

interface ChannelPayload {
  id: string;
  name: string;
  /** Subset of movie / TV; omitted or empty = no extra format line. */
  mediums?: ("movie" | "tv")[];
  genres: string[];
  timePeriods: string[];
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
  const freeText = ch.freeText.trim();
  const directTitle = freeText ? parseDirectTitleRequest(freeText, mediaType) : null;
  if (directTitle) {
    lines.push(`- ${directTitleConstraintLine(directTitle)}`);
  } else if (freeText) {
    lines.push(
      `- What they want (primary — align genres/era/etc. below with this): ${freeText}`,
    );
  }
  if (ch.genres.length) lines.push(`- Genres: ${ch.genres.join(", ")}`);
  if (ch.timePeriods.length) lines.push(`- Time periods: ${ch.timePeriods.join(", ")}`);
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
    sessionId?: string;
    historySync?: "full" | "delta" | "reuse";
    history?: RatingEntry[];
    baseLength?: number;
    historyAppend?: RatingEntry[];
    skipped?: string[];
    watchlistTitles?: Array<string | { title: string; rtScore?: string | null }>;
    notInterestedItems?: Array<{ title: string; rtScore?: string | null }>;
    tasteSummary?: string;
    userRequest?: string;
    activeChannel?: ChannelPayload;
    mediaType?: "movie" | "tv" | "both";
    llm?: string;
    count?: number;
    triedCategories?: string[];
    /** CLI taste tests: skip TMDB poster/trailer enrichment (avoids YouTube API calls). */
    skipAssets?: boolean;
    /** Session taxonomy — generated once per session if omitted */
    categoryTree?: CategoryTree;
  };

  const skipped = raw.skipped ?? [];
  // Support both legacy string[] and new {title, rtScore}[] formats
  const rawWatchlistItems = raw.watchlistTitles ?? [];
  const watchlistItems: { title: string; rtScore?: string | null }[] = rawWatchlistItems.map((item) =>
    typeof item === "string" ? { title: item } : item
  );
  const watchlistTitles = watchlistItems.map((w) => w.title);
  const notInterestedItems: { title: string; rtScore?: string | null }[] = raw.notInterestedItems ?? [];
  const existingTasteSummary = raw.tasteSummary?.trim() || null;
  const userRequest = raw.userRequest?.trim() || null;
  const activeChannel = raw.activeChannel ?? null;
  const mediaType = raw.mediaType ?? "both";
  const channelConstraint = (activeChannel && activeChannel.id !== "all") ? buildChannelConstraint(activeChannel, mediaType) : null;
  const llm = raw.llm ?? "deepseek";
  const countRaw = raw.count;
  const skipAssets = raw.skipAssets === true;

  const merged = resolveHistoryForPrompt(raw.sessionId, raw.historySync, {
    history: raw.history,
    baseLength: raw.baseLength,
    historyAppend: raw.historyAppend,
  });

  if (!merged.ok) {
    return Response.json(
      { error: "session_resync", reason: merged.reason, message: "Send historySync full with complete history" },
      { status: 409 }
    );
  }

  const history = merged.history;
  const triedCategories = [
    ...new Set([
      ...(raw.triedCategories ?? []),
      ...history.flatMap((e) => e.categories ?? []),
    ]),
  ];

  let categoryTree: CategoryTree | null =
    raw.categoryTree ?? (raw.sessionId ? getSessionCategoryTree(raw.sessionId) : null) ?? null;

  if (!categoryTree) {
    try {
      if (!channelConstraint && !userRequest) {
        categoryTree = await generateCategoryTree(llm);
      } else if (channelConstraint && activeChannel) {
        const anchor = activeChannel.freeText.trim() || activeChannel.name.trim();
        if (anchor) {
          const base = await generateCategoryTree(llm, { anchorPreference: anchor });
          const resolved = await resolveTreeForPreference(base, anchor, llm);
          categoryTree = resolved.tree;
        }
      }
      if (categoryTree && raw.sessionId) saveSessionCategoryTree(raw.sessionId, categoryTree);
    } catch (e) {
      console.error("[next-movie] category tree generation failed:", e);
    }
  } else if (categoryTree && raw.sessionId && raw.categoryTree) {
    saveSessionCategoryTree(raw.sessionId, categoryTree);
  }

  const triedSuperKeys = [
    ...new Set([
      ...history.flatMap((e) => (e.categoryPaths ?? []).map(superKey)),
    ]),
  ];

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

  // --- Informative taste-signal sections (token-efficient; full exclusion lists not sent) ---

  const informativeHistory = selectInformativeHistory(history, MAX_HISTORY_DIVERGENCE_LINES);
  const historyTrimmed = history.length > informativeHistory.length;

  const historyText =
    informativeHistory.length === 0
      ? "No ratings yet."
      : informativeHistory
          .map((h) => {
            const rt = h.rtScore ? ` RT:${h.rtScore}` : "";
            const rt_n = parseRtPercent(h.rtScore);
            const u = migrateRatingValue(h.userRating);
            const rtAsStars = rt_n !== null ? rtTomatometerPercentToStars(rt_n) : null;
            const gap =
              rtAsStars !== null
                ? ` |user−RT★|=${Math.abs(u - rtAsStars)} (Tomatometer → ${rtAsStars}/5 stars)`
                : ` |user−AI|=${Math.abs(u - migrateRatingValue(h.predictedRating))} (no RT)`;
            return `- "${h.title}" (${h.type}): user ${u}/5, AI ${migrateRatingValue(h.predictedRating)}/5${rt}${gap}`;
          })
          .join("\n");

  const historyNote = historyTrimmed
    ? `[Subset: ${informativeHistory.length} of ${history.length} rated — kept those with largest divergence from RT (or from AI if RT missing)]`
    : "";

  const lowRtCandidates = watchlistItems
    .map((w) => ({ ...w, rtN: parseRtPercent(w.rtScore) }))
    .filter((w): w is typeof w & { rtN: number } => w.rtN !== null && w.rtN < LOW_RT_THRESHOLD)
    .sort((a, b) => a.rtN - b.rtN)
    .slice(0, MAX_LOW_RT_WANT_LINES);

  const lowRtWantText =
    lowRtCandidates.length === 0
      ? "None."
      : lowRtCandidates.map((w) => `"${w.title}" (RT:${w.rtScore})`).join(", ");

  const highRtCandidates = notInterestedItems
    .map((n) => ({ ...n, rtN: parseRtPercent(n.rtScore) }))
    .filter((n): n is typeof n & { rtN: number } => n.rtN !== null && n.rtN >= HIGH_RT_THRESHOLD)
    .sort((a, b) => b.rtN - a.rtN)
    .slice(0, MAX_HIGH_RT_SKIP_LINES);

  const highRtSkipText =
    highRtCandidates.length === 0
      ? "None."
      : highRtCandidates.map((n) => `"${n.title}" (RT:${n.rtScore})`).join(", ");

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
  const systemPromptContext =
    systemPromptContextParts.length > 0 ? systemPromptContextParts.join("\n\n") : null;

  const systemPrompt = `You are calibrating a movie/TV recommendation system to a specific user's taste.

The user rates with **half stars from 0.5 to 5** (not percentages). Rotten Tomatoes Tomatometer scores are percentages; the app converts them to the same star scale for comparison.

Many cards have no Rotten Tomatoes score — that is normal.

Your job each turn:
1. Propose ${batchCount} titles (aim for variety). The client removes duplicates against a large exclusion set you do not receive in full — repeats are OK; the app will filter.
2. For each title, predict the rating they would give on a **0.5–5 star scale (half-star steps only)**.
3. Return title, year, director, top 3-4 actors, a 1-2 sentence plot summary, Rotten Tomatoes Tomatometer when known, and a one-sentence reason explaining why this title fits the user's taste — write it in second person, addressing the user as "you" (e.g. "You rated X highly" not "The user rated X highly").
4. For **each title** include **streaming_services**: a JSON array of US streaming platform names where the viewer can watch now — use short names: Netflix, Max, Hulu, Disney+, Apple TV+, Amazon Prime Video, Peacock, Paramount+, AMC+, STARZ, Tubi, Pluto TV. Use [] if unsure.
5. Respond with ONLY valid JSON — no markdown, no explanation:
{"items":[{"title":"...","type":"movie","year":1994,"director":"...","predicted_rating":3.5,"actors":["...","..."],"plot":"...","rt_score":"94%","reason":"...","streaming_services":["Netflix"],"categories":["tag1","tag2"],"category_paths":[{"dimension":"region","super":"south_asian","leaf":"bollywood musical"}]}]}

Rules:
- Return exactly ${batchCount} objects in "items" (unless absolutely impossible — then return as many distinct valid picks as you can)
- Avoid duplicate titles within "items". Do not worry about overlap with the user's full past list — the app enforces that separately
- "type" must be exactly "movie" or "tv"
- "title" must be the exact official release name only — never a sentence, channel label, or "description: title" format
- "year" is a number; "director" is a single string — if multiple directors, combine them: "A, B" (never two separate JSON values)
- "predicted_rating" is a number from 0.5 to 5 in steps of 0.5 (half stars) — never use 0–100
- "rt_score" is the Tomatometer percentage (e.g. "94%") or null if unknown
- "categories" is an array of 2–4 short genre/category tags you assign for this title
- "category_paths" is an array of 1–3 objects {dimension, super, leaf} from the SESSION CATEGORY TREE when one is provided — required in exploration mode
- All string values must be on a single line — no newline characters inside strings
- Maximize diversity across regions, eras, genres, languages, and traditions. You choose what to explore based on the rating history — the app does not prescribe categories
- Vary genres, eras, and (if media allows) movie vs TV to calibrate faster
- Predict honestly — vary predictions; the midpoint is not always 3
- Taste data below is intentionally small: high-divergence ratings, low-RT wants, high-RT dismissals. Full exclusion is not listed.
- AVOID CATEGORIES LISTED: These consistently get 1-2★ ratings, so deprioritize them in favor of new areas. But they're not absolute bans — it's okay to suggest one occasionally if it genuinely fits exploration or contrast testing. Just don't cluster them.
- IMPORTANT: If CATEGORY PREFERENCES are provided below, treat them as the strongest signal — they show exactly what this viewer loves and avoids. Align your picks accordingly.
- IMPORTANT: If 20Q HYPOTHESIS TESTING is described, design films that isolate different dimensions. Each film tests whether the appeal is due to region, genre, tone, spectacle, etc. A 4★ vs 1★ rating for strategically different films teaches us which dimension matters most.`;

  const tasteSummarySection = existingTasteSummary
    ? `RUNNING TASTE PROFILE (your summary from the previous session — treat as primary signal, refine it):
${existingTasteSummary}

`
    : "";

  // Compute category preferences from rated history entries that have categories
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

  // In exploration mode: use 20Q strategy based on what user has shown they love
  let exploreCategoriesSection = "";
  let avoidCategoriesSection = "";

  if (history.length < 20 && channelConstraint && categoryTree) {
    exploreCategoriesSection = `${buildChannelTreeTaggingSection(categoryTree)}

`;
  } else if (history.length < 20 && !channelConstraint && !userRequest) {
    const { avoided, warmTags } = analyzePreferenceSignals(history);

    const avoidedCats = [...avoided.entries()]
      .filter(([cat, avg]) => {
        const lows = history.filter(
          (e) => e.userRating <= 2 && e.categories?.includes(cat),
        ).length;
        return lows >= 2 && avg <= 2.0 && !warmTags.has(cat);
      })
      .sort((a, b) => a[1] - b[1])
      .slice(0, 5)
      .map(([cat]) => cat);

    if (avoidedCats.length > 0) {
      avoidCategoriesSection = `DEPRIORITIZE — these category tags from past picks consistently get 1-2★. Lean toward new areas, but occasional recommendations from these are okay if they genuinely fit exploration or testing:
${avoidedCats.map(c => `- ${c}`).join("\n")}

`;
    }

    if (categoryTree) {
      exploreCategoriesSection = `${buildTreeExplorationSection(categoryTree, history, batchCount, triedSuperKeys)}

`;
    } else if (history.length >= 5) {
      const { topLoved } = analyzePreferenceSignals(history);
      const hypothesisPromptResponse = await generateHypothesisTestingPrompt(topLoved, history, llm);

      if (hypothesisPromptResponse) {
        try {
          const match = hypothesisPromptResponse.match(/\[[\s\S]*\]/);
          if (match) {
            const parsed = JSON.parse(match[0]) as Array<{ hypothesis_tests?: string }>;
            const hypotheses = parsed
              .map(item => item.hypothesis_tests)
              .filter((h): h is string => typeof h === "string")
              .slice(0, 5)
              .join("\n");

            if (hypotheses) {
              exploreCategoriesSection = `20Q HYPOTHESIS TESTING:
User clearly loves: ${topLoved.join(", ")}

This round, each film tests a specific dimension to isolate what matters:
${hypotheses}

Design films that distinguish between these hypotheses. A 4★ vs 1★ result for contrasting films teaches us which dimension drives their taste.

`;
            }
          }
        } catch (e) {
          console.error("[20Q parse] failed:", e);
        }
      }
    }
  }

  const channelLockSection = channelConstraint
    ? `CHANNEL LOCK: All ${batchCount} titles MUST satisfy the channel requirements above. Stay within the requested style, era, and region — vary specific titles and filmmakers, not the genre. Do not wander outside the channel for "variety".\n\n`
    : "";

  const channelFirstTurnSection =
    channelConstraint && history.length === 0
      ? `FIRST TURN: All ${batchCount} titles must fit the channel. Pick well-known, on-target exemplars (canonical films for this taste — not adjacent genres). Tag category_paths from the tree above when provided.\n\n`
      : "";

  const batchAskLine = channelConstraint
    ? `Suggest ${batchCount} on-channel candidates (vary specific titles and filmmakers, not genre or era).`
    : `Suggest ${batchCount} diverse candidates.`;

  const userMessage = `${avoidCategoriesSection}${exploreCategoriesSection}${channelLockSection}${channelFirstTurnSection}${directTitleNote}${categoryPrefsSection}${tasteSummarySection}RATED TITLES — selected for largest |user−RT| divergence, plus most recent (most informative per token):
${historyText}
${historyNote}

UNSEEN SIGNALS — where this user disagrees with critics (curated, strongest first):
Want to watch despite LOW RT (below ${LOW_RT_THRESHOLD}%): ${lowRtWantText}
Not interested despite HIGH RT (${HIGH_RT_THRESHOLD}%+): ${highRtSkipText}

EXCLUSION (counts only — the app drops any repeat client-side):
${allExcluded.length} titles already decided (${ratedTitles.length} rated, ${watchlistTitles.length} on watchlist, ${skipped.length} skipped/dismissed). ${batchAskLine}

${history.length < 20
  ? channelConstraint
    ? `CHANNEL MODE (${history.length} ratings): Every pick must fit the channel. Tag every item with category_paths from the tree above when provided.${history.length === 0 ? " Round 1: prioritize famous exemplars of this exact taste." : ""}`
    : categoryTree
      ? `EXPLORATION MODE (${history.length} ratings): Follow the SESSION CATEGORY TREE and 20Q instructions above. Tag every item with category_paths.`
      : `EXPLORATION MODE (${history.length} ratings so far): Study the rated titles and category tags below. Each pick in this batch should explore a different area of cinema — regions, eras, genres, languages, traditions — that is underrepresented in their history so far. You decide which dimensions to vary; spread the batch wide and avoid clustering on one tradition.
${triedCategories.length > 0 ? `Category tags already attached to rated titles: ${triedCategories.join(", ")}. Prefer fresh areas not yet represented there.` : ""}`
  : `Analyze all signals above and pick ${batchCount} titles that will confirm or usefully challenge your model of their taste. Spread picks across disparate areas of cinema unless channel or user constraints say otherwise.`}`;


  // Set NEXT_MOVIE_LOG_LLM_PROMPTS=1 in .env.local to re-enable prompt logging when debugging.
  const logLlmPrompts = process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "1" || process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "true";
  if (logLlmPrompts) {
    console.log(
      `[next-movie] LLM submit (${llm}): ${batchCount} titles requested. sync=${raw.historySync ?? "legacy"} rated=${ratedTitles.length} promptLines=${informativeHistory.length} skipped=${skipped.length} watchlist=${watchlistTitles.length} notInterested=${notInterestedItems.length} excluded=${allExcluded.length}`
    );
    console.log("[next-movie] --- system prompt (base) ---\n" + systemPrompt);
    if (systemPromptContext) {
      console.log("[next-movie] --- system prompt (context) ---\n" + systemPromptContext);
    }
    console.log("[next-movie] --- user message ---\n" + userMessage);
  }

  const roundOneSlots =
    categoryTree && history.length === 0 && !channelConstraint && !userRequest
      ? buildRoundOneSlots(categoryTree, batchCount, triedSuperKeys)
      : null;

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

      const categoryPaths = parseCategoryPathsFromRaw(raw.category_paths);
      const flatCategories = Array.isArray(raw.categories)
        ? (raw.categories as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.toLowerCase())
        : [];
      const categories =
        flatCategories.length > 0 ? flatCategories : pathsToDisplayCategories(categoryPaths);

      out.push({
        title: cleanedTitle,
        type: raw.type,
        year: raw.year ?? null,
        director: raw.director ?? null,
        predictedRating: normalizePredictedRating(raw.predicted_rating, 3),
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
        categoryPaths,
      });
    }
    return out;
  }

  let normalized: NextMovieResponse[] = [];
  let userMessageForLlm = userMessage;
  const maxAttempts = roundOneSlots?.length ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    const llmStart = Date.now();
    try {
      text = await callLLM(llm, systemPrompt, userMessageForLlm, {
        maxTokens: LLM_OUTPUT_MAX_TOKENS,
        systemPromptContext,
      });
      const llmMs = Date.now() - llmStart;
      console.log(
        `[next-movie] LLM done (${llm}) in ${(llmMs / 1000).toFixed(1)}s — output ${text.length} chars${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
      );
    } catch (err) {
      const llmMs = Date.now() - llmStart;
      console.error(`[next-movie] LLM failed (${llm}) after ${(llmMs / 1000).toFixed(1)}s:`, err);
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

    normalized = normalizeRawItems(rawItems);

    if (!roundOneSlots?.length || attempt === maxAttempts) break;

    const validation = validateBatchAgainstSlots(normalized, roundOneSlots);
    if (validation.ok) break;

    console.warn(`[next-movie] round-1 slot validation failed (attempt ${attempt}):`, validation.failures);
    userMessageForLlm = `${userMessage}\n\n${formatSlotValidationFeedback(validation.failures, roundOneSlots)}`;
  }

  if (roundOneSlots?.length && categoryTree && normalized.length > 0) {
    const finalValidation = validateBatchAgainstSlots(normalized, roundOneSlots);
    if (!finalValidation.ok) {
      console.warn("[next-movie] round-1 batch invalid after retries — per-slot fallback");
      const slotPicks: NextMovieResponse[] = [];
      for (const slot of roundOneSlots) {
        const slotUserMessage = `${formatTreeForPrompt(categoryTree)}

${formatRoundOneSlotRequirements([slot])}

Return exactly 1 object in "items". Choose a well-known real film/TV title that genuinely belongs in this slot.`;
        try {
          const slotText = await callLLM(llm, systemPrompt, slotUserMessage, {
            maxTokens: 900,
            systemPromptContext,
          });
          const slotRaw = parseLlmResponse(
            slotText,
            extractAllJsonObjects(stripMarkdownJsonFence(slotText)),
          ).items;
          const slotNorm = normalizeRawItems(slotRaw);
          if (slotNorm[0]) slotPicks.push(slotNorm[0]);
        } catch (err) {
          console.warn(`[next-movie] round-1 slot ${slot.slot} fallback failed:`, err);
        }
      }
      if (slotPicks.length >= Math.ceil(roundOneSlots.length / 2)) {
        normalized = slotPicks;
      }
    }
  }

  if (normalized.length === 0) {
    console.error("LLM returned no valid items");
    return Response.json({ error: "No valid titles in response" }, { status: 500 });
  }

  if (!skipAssets) {
    const assets = await Promise.all(
      normalized.map((m) => fetchTmdbAssets(m.title, m.type, m.year, m.director)),
    );
    for (let i = 0; i < normalized.length; i++) {
      normalized[i] = { ...normalized[i], posterUrl: assets[i].posterUrl, trailerKey: assets[i].trailerKey };
    }
  }

  return Response.json({
    movies: normalized,
    categoryTree: categoryTree ?? undefined,
  });
}
