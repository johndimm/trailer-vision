/**
 * Taste discovery test — measures how well the recommender learns a hidden preference.
 *
 * Each profile runs two phases:
 *   1. All channel — no channel constraint, 20Q category tree (discovery)
 *   2. Channel hint — preference as channel definition (answer given)
 *
 * Oracle scores by hierarchical tree paths — NOT keyword search in plot/title.
 *
 * Usage:
 *   npx tsx scripts/taste-test.ts <preference> [base-url] [max-rounds]
 *   npx tsx scripts/taste-test-all.ts [base-url] [max-rounds] [count]
 */

import type { CategoryPath, CategoryTree } from "../app/lib/categoryTree";

export type TasteTestChannelMode = "all" | "channel";

export type TasteTestPhaseResult = {
  mode: TasteTestChannelMode;
  label: string;
  converged: boolean;
  roundsRun: number;
  totalRated: number;
  convergeRound: number | null;
  stats: Array<{ round: number; avgRating: number; maxRating: number; minRating: number; total: number }>;
};

export type TasteTestDualResult = {
  preference: string;
  targetPaths: CategoryPath[];
  all: TasteTestPhaseResult;
  channel: TasteTestPhaseResult;
};

/** Mirrors next-movie ChannelPayload for taste-test channel hint phase */
export type TasteTestChannel = {
  id: string;
  name: string;
  genres: string[];
  timePeriods: string[];
  language: string;
  artists: string;
  freeText: string;
  popularity: number;
};

export type TasteTestOptions = {
  preference: string;
  baseUrl?: string;
  maxRounds?: number;
  llm?: string;
  categoryTree?: CategoryTree;
  targetPaths?: CategoryPath[];
};

/** @deprecated Use runTasteTestDual — returns All-channel phase only for backwards compat */
export type TasteTestResult = TasteTestPhaseResult;

const BATCH_SIZE = 5;

interface Movie {
  title: string;
  type: "movie" | "tv";
  plot?: string;
  year?: number | null;
  director?: string | null;
  actors?: string[];
  rtScore?: string | null;
  predictedRating?: number;
  reason?: string | null;
  categories?: string[];
  categoryPaths?: CategoryPath[];
}

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
  categories?: string[];
  categoryPaths?: CategoryPath[];
}

function extractDecadeHint(preference: string): string {
  const m = preference.match(/\b(19\d0s|20\d0s)\b/i);
  return m ? m[0]! : "";
}

function genresFromTargetPaths(targetPaths: CategoryPath[]): string[] {
  const genres: string[] = [];
  for (const p of targetPaths) {
    if (p.dimension === "genre" && p.leaf) {
      genres.push(p.leaf.replace(/_/g, " "));
    } else if (p.leaf && p.dimension !== "era" && p.dimension !== "region") {
      genres.push(p.leaf.replace(/_/g, " "));
    }
  }
  return [...new Set(genres)].slice(0, 4);
}

/** Structured channel matching real channel UX (Style/era/genres split across fields). */
function buildChannelFromPreference(preference: string, targetPaths: CategoryPath[]): TasteTestChannel {
  const decade = extractDecadeHint(preference);
  const genres = genresFromTargetPaths(targetPaths);
  return {
    id: "taste-test-channel",
    name: preference,
    genres,
    timePeriods: decade ? [decade] : [],
    language: "",
    artists: "",
    freeText: preference,
    popularity: 60,
  };
}

async function fetchSessionCategoryTree(
  preference: string,
  baseUrl: string,
  llm: string,
  existing?: CategoryTree,
): Promise<{ tree: CategoryTree; targetPaths: CategoryPath[] }> {
  const res = await fetch(`${baseUrl}/api/category-tree`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      llm,
      preference,
      ...(existing ? { tree: existing } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`category-tree HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { tree?: CategoryTree; targetPaths?: CategoryPath[] };
  if (!data.tree) throw new Error("category-tree returned no tree");
  return { tree: data.tree, targetPaths: data.targetPaths ?? [] };
}

async function scoreMoviesBatch(
  movies: Movie[],
  preference: string,
  baseUrl: string,
  llm: string,
  categoryTree: CategoryTree,
  targetPaths: CategoryPath[],
  channelHint: boolean,
  discoveryMode: boolean,
): Promise<Array<{ title: string; stars: number; reason: string }>> {
  if (movies.length === 0) return [];

  const res = await fetch(`${baseUrl}/api/taste-test-score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preference,
      movies: movies.map((m) => ({
        title: m.title,
        year: m.year,
        plot: m.plot,
        categories: m.categories,
        categoryPaths: m.categoryPaths,
      })),
      llm,
      categoryTree,
      targetPaths,
      channelHint,
      discoveryMode,
    }),
  });

  if (!res.ok) {
    throw new Error(`taste-test-score HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { scores?: Array<{ title: string; stars: number; reason: string }> };
  const scores = data.scores ?? [];
  if (scores.length !== movies.length) {
    throw new Error(`taste-test-score returned ${scores.length} scores for ${movies.length} movies`);
  }
  return scores;
}

async function getRecommendations(
  history: RatingEntry[],
  tasteSummary: string | null,
  skipped: string[],
  triedCategories: string[],
  baseUrl: string,
  llm: string,
  categoryTree: CategoryTree,
  activeChannel?: TasteTestChannel | null,
): Promise<Movie[]> {
  const res = await fetch(`${baseUrl}/api/next-movie`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      history,
      tasteSummary: tasteSummary ?? undefined,
      skipped,
      triedCategories,
      watchlistTitles: [],
      notInterestedItems: [],
      mediaType: "both",
      llm,
      count: BATCH_SIZE,
      historySync: "reuse",
      baseLength: history.length,
      skipAssets: true,
      categoryTree,
      ...(activeChannel ? { activeChannel } : {}),
    }),
  });
  if (!res.ok) throw new Error(`next-movie HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { movies?: Movie[] };
  return data.movies ?? [];
}

async function getTasteSummary(
  history: RatingEntry[],
  existing: string | null,
  baseUrl: string,
  llm: string,
): Promise<string | null> {
  if (!history.length) return null;
  const res = await fetch(`${baseUrl}/api/taste-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history, existingSummary: existing ?? undefined, llm }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { tasteSummary?: string | null };
  return data.tasteSummary ?? null;
}

function printPhaseSummary(
  label: string,
  stats: TasteTestPhaseResult["stats"],
  converged: boolean,
  convergeRound: number | null,
  totalRated: number,
  maxRounds: number,
) {
  console.log(`\n  ${label} — ${totalRated} ratings`);
  console.log("  Rnd  Avg★  Range         Progress");
  for (const d of stats) {
    const bar = "▓".repeat(Math.round(d.avgRating)) + "░".repeat(5 - Math.round(d.avgRating));
    console.log(`   ${String(d.round).padStart(2)}  ${d.avgRating.toFixed(1)}  [${d.minRating}-${d.maxRating}]  ${bar}`);
  }
  console.log(
    converged
      ? `  → Converged: round ${convergeRound} (${totalRated} ratings)`
      : `  → Did not converge within ${maxRounds} rounds`,
  );
}

async function runPhase(opts: {
  preference: string;
  baseUrl: string;
  llm: string;
  maxRounds: number;
  mode: TasteTestChannelMode;
  categoryTree: CategoryTree;
  targetPaths: CategoryPath[];
}): Promise<TasteTestPhaseResult> {
  const { preference, baseUrl, llm, maxRounds, mode, categoryTree, targetPaths } = opts;
  const isAll = mode === "all";
  const label = isAll ? "All channel (discovery)" : `Channel hint ("${preference}")`;
  const activeChannel = isAll ? null : buildChannelFromPreference(preference, targetPaths);

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Phase: ${label}`);
  console.log(`  channel: ${activeChannel ? activeChannel.name : "(All — no constraints)"}`);
  console.log(`  batch: ${BATCH_SIZE} films/round`);
  console.log("─".repeat(72));

  const history: RatingEntry[] = [];
  const seenTitles = new Set<string>();
  const triedCategories = new Set<string>();
  let tasteSummary: string | null = null;

  type RoundStat = { round: number; avgRating: number; maxRating: number; minRating: number; total: number };
  const stats: RoundStat[] = [];
  let converged = false;
  let roundsRun = 0;
  let convergeRound: number | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    roundsRun = round;
    console.log(`\n  Round ${round}  (${history.length} rated) ${"·".repeat(24)}`);
    if (triedCategories.size > 0) {
      console.log(`   Tried: ${Array.from(triedCategories).slice(0, 12).join(", ")}${triedCategories.size > 12 ? "…" : ""}`);
    }

    let movies: Movie[];
    try {
      movies = await getRecommendations(
        history,
        tasteSummary,
        [...seenTitles],
        [...triedCategories],
        baseUrl,
        llm,
        categoryTree,
        activeChannel,
      );
    } catch (e) {
      console.error("    ✗ Fetch failed:", e);
      break;
    }
    if (!movies.length) {
      console.error("    ✗ No movies");
      break;
    }

    const novel = movies.filter((m) => !seenTitles.has(m.title.toLowerCase().trim()));
    const dups = movies.length - novel.length;
    if (dups > 0) console.log(`  [${dups} duplicate(s)]`);

    let scored: Array<{ title: string; stars: number; reason: string }>;
    try {
      scored = await scoreMoviesBatch(
        novel,
        preference,
        baseUrl,
        llm,
        categoryTree,
        targetPaths,
        !isAll,
        isAll,
      );
    } catch (e) {
      console.error("    ✗ Oracle scoring failed:", e);
      break;
    }

    let totalRating = 0;
    let maxRating = 0;
    let minRating = 5;

    for (const s of scored) {
      const key = s.title.toLowerCase().trim();
      seenTitles.add(key);
      totalRating += s.stars;
      maxRating = Math.max(maxRating, s.stars);
      minRating = Math.min(minRating, s.stars);

      const m = novel.find((x) => x.title === s.title);
      const starStr = "★".repeat(Math.round(s.stars)) + "☆".repeat(5 - Math.round(s.stars));
      const plot = (m?.plot ?? "").slice(0, 80);
      const pathStr = m?.categoryPaths?.length
        ? ` {${m.categoryPaths.map((p) => `${p.dimension}/${p.super}${p.leaf ? `/${p.leaf}` : ""}`).join(", ")}}`
        : "";
      const catStr = m?.categories?.length ? ` [${m.categories.join(", ")}]` : " [no categories]";
      console.log(`    ${starStr}  ${s.title}${m?.year ? ` (${m.year})` : ""}${catStr}${pathStr}`);
      console.log(`             ${s.reason}`);
      console.log(`             ${plot}`);

      if (m?.categories?.length) {
        for (const cat of m.categories) {
          triedCategories.add(cat);
        }
      }

      history.push({
        title: s.title,
        type: m?.type ?? "movie",
        userRating: s.stars,
        predictedRating: m?.predictedRating ?? 3,
        rtScore: m?.rtScore ?? null,
        categories: m?.categories,
        categoryPaths: m?.categoryPaths,
      });
    }

    tasteSummary = await getTasteSummary(history, tasteSummary, baseUrl, llm);

    const novelCount = novel.length;
    const avgRating = novelCount > 0 ? totalRating / novelCount : 0;
    console.log(`\n    Avg: ${avgRating.toFixed(1)}★  Range: ${minRating}-${maxRating}★`);
    if (tasteSummary) console.log(`    Summary: "${tasteSummary.slice(0, 120)}${tasteSummary.length > 120 ? "…" : ""}"`);

    stats.push({ round, avgRating, maxRating, minRating, total: novelCount });

    if (avgRating >= 4.0 && novelCount > 0) {
      converged = true;
      convergeRound = round;
      console.log(`\n    ✓ CONVERGED — round ${round}, avg ${avgRating.toFixed(1)}★`);
      break;
    }
    if (round === maxRounds) console.log(`\n    ✗ Did not converge within ${maxRounds} rounds`);
  }

  printPhaseSummary(label, stats, converged, convergeRound, history.length, maxRounds);

  return {
    mode,
    label,
    converged,
    roundsRun,
    totalRated: history.length,
    convergeRound,
    stats,
  };
}

export async function runTasteTestDual(opts: TasteTestOptions): Promise<TasteTestDualResult> {
  const preference = opts.preference.trim();
  const baseUrl = opts.baseUrl ?? "http://localhost:3000";
  const maxRounds = opts.maxRounds ?? 20;
  const llm = opts.llm ?? "deepseek";

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Trailer taste test — "${preference}"`);
  console.log(
    `Oracle: All = best-dimension match (discovery); Channel = compound average + display fit`,
  );
  console.log(`Server: ${baseUrl}   Max rounds/phase: ${maxRounds}`);
  console.log(`Success: batch averages ≥4★`);
  console.log("=".repeat(72));

  let categoryTree: CategoryTree;
  let targetPaths: CategoryPath[];
  try {
    const session = await fetchSessionCategoryTree(preference, baseUrl, llm, opts.categoryTree);
    categoryTree = session.tree;
    targetPaths = opts.targetPaths?.length ? opts.targetPaths : session.targetPaths;
    console.log(`Category tree: ${categoryTree.dimensions.length} dimensions`);
    if (targetPaths.length) {
      console.log(
        `Target paths: ${targetPaths.map((p) => `${p.dimension}/${p.super}${p.leaf ? `/${p.leaf}` : ""}`).join(", ")}`,
      );
    }
  } catch (e) {
    console.error("  ✗ Category tree failed:", e);
    throw e;
  }

  const all = await runPhase({
    preference,
    baseUrl,
    llm,
    maxRounds,
    mode: "all",
    categoryTree,
    targetPaths,
  });

  const channel = await runPhase({
    preference,
    baseUrl,
    llm,
    maxRounds,
    mode: "channel",
    categoryTree,
    targetPaths,
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log("COMPARISON");
  console.log("=".repeat(72));
  const allTime = all.converged ? `round ${all.convergeRound} (${all.totalRated} ratings)` : `no convergence in ${maxRounds} rounds`;
  const chTime = channel.converged
    ? `round ${channel.convergeRound} (${channel.totalRated} ratings)`
    : `no convergence in ${maxRounds} rounds`;
  console.log(`  All channel (discovery):  ${all.converged ? "✓" : "✗"}  ${allTime}`);
  console.log(`  Channel hint (answer):    ${channel.converged ? "✓" : "✗"}  ${chTime}`);
  if (all.converged && channel.converged && all.convergeRound != null && channel.convergeRound != null) {
    const delta = all.convergeRound - channel.convergeRound;
    console.log(
      delta > 0
        ? `  Channel hint converged ${delta} round(s) faster`
        : delta < 0
          ? `  All channel converged ${-delta} round(s) faster (unexpected)`
          : "  Both converged in the same round",
    );
  }

  return { preference, targetPaths, all, channel };
}

/** Backwards-compatible wrapper — runs dual test, returns All-channel phase */
export async function runTasteTest(opts: TasteTestOptions): Promise<TasteTestPhaseResult> {
  const result = await runTasteTestDual(opts);
  return result.all;
}

const isMain = process.argv[1]?.includes("taste-test.ts");
if (isMain) {
  const preference = process.argv[2];
  const baseUrl = process.argv[3] ?? "http://localhost:3000";
  const maxRounds = Number(process.argv[4] ?? 20);

  if (!preference) {
    console.error("Usage: npx tsx scripts/taste-test.ts <preference> [base-url] [max-rounds]");
    console.error("       npx tsx scripts/taste-test-all.ts [base-url] [max-rounds] [count]");
    process.exit(1);
  }

  runTasteTestDual({ preference, baseUrl, maxRounds }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
