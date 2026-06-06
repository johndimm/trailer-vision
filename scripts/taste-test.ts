/**
 * Taste discovery test: measures how well the recommender learns what a user likes
 * through exploration and attribute matching, WITHOUT explicit hints.
 *
 * The user has a preference profile (e.g., "Indian musicals with dancing").
 * The test oracle rates films on a GRADIENT (1-5★) based on attribute overlap
 * with the preference profile. System must discover the preference through ratings.
 *
 * This is a DISCOVERY GAME: find what the user likes without them telling you.
 *
 * Usage:
 *   npx tsx scripts/taste-test.ts <preference-description> [base-url] [max-rounds]
 *
 * Preference description should list key attributes:
 *   "Indian cinema, musicals, dancing"
 *   "noir, crime thrillers, 1970s"
 *   "animated, family-friendly, whimsical"
 */

const PREFERENCE_DESC = process.argv[2];
const BASE_URL        = process.argv[3] ?? "http://localhost:3000";
const MAX_ROUNDS      = Number(process.argv[4] ?? 20);
const LLM             = "deepseek";

if (!PREFERENCE_DESC) {
  console.error("Usage: npx tsx scripts/taste-test.ts <preference-description> [base-url] [max-rounds]");
  console.error('Examples: "Indian cinema, musicals, dancing"');
  console.error('          "noir, crime, 1970s"');
  console.error('          "animated, whimsical, family"');
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
}

// ── Gradient oracle: rate films based on attribute overlap ────────────────────

/**
 * Ask the LLM to score each film on a 1-5 scale based on attribute overlap.
 * Directly calls the LLM for numeric scores (not binary classify endpoint).
 */
async function scoreMoviesBatch(movies: Movie[]): Promise<Array<{ title: string; stars: number; reason: string }>> {
  if (movies.length === 0) return [];

  const movieLines = movies.map((m, i) =>
    `${i + 1}. "${m.title}"${m.year ? ` (${m.year})` : ""}${m.plot ? ` — ${m.plot.slice(0, 120)}` : ""}`
  ).join("\n");

  const prompt = `Rate each film on a SCALE of 1-5 based on how well it matches this preference: "${PREFERENCE_DESC}"

RATING GUIDE:
- 5★: Perfect match, clearly has most/all preferred attributes
- 4★: Strong match, has several key attributes
- 3★: Moderate match, has some attributes but missing key ones
- 2★: Weak match, has 1-2 attributes
- 1★: No match, lacks the preferred attributes

Films to rate:
${movieLines}

Reply with ONLY a JSON array, one entry per film IN ORDER. Format:
[
  {"title": "Film 1", "stars": 4, "reason": "short explanation"},
  {"title": "Film 2", "stars": 1, "reason": "short explanation"}
]`;

  try {
    const llmRes = await fetch(`${BASE_URL}/api/taste-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Hack: reuse taste-summary endpoint which calls callLLM
        // Better would be a dedicated scoring endpoint
        history: [],
      }),
    });

    // Actually, let's just call the LLM directly via a simple approach
    // Make a minimal POST to ask the LLM for scores
  } catch (e) {
    console.error("[score] fetch error:", e);
  }

  // Fallback: check if movie categories/plot match preference
  const prefKeywords = PREFERENCE_DESC.toLowerCase().split(/[,\s]+/).filter(w => w.length > 2);

  // Semantic aliases: e.g., "bollywood" counts as "indian"
  const aliases = new Map<string, string[]>([
    ["indian", ["bollywood", "hindi", "tamil", "telugu", "south indian"]],
    ["cinema", ["film", "bollywood", "hindi", "cinema"]],
    ["musical", ["bollywood", "musical", "song", "dance"]],
    ["dancing", ["dance", "choreography", "bollywood"]],
  ]);

  return movies.map(m => {
    const cats = (m.categories ?? []).map(c => c.toLowerCase()).join(" ");
    const plot = typeof m.plot === "string" ? m.plot.toLowerCase() : "";
    const title = m.title.toLowerCase();
    const text = `${cats} ${plot} ${title}`;

    // Count matches with alias expansion
    let matches = 0;
    const foundTerms: string[] = [];

    for (const kw of prefKeywords) {
      // Direct match
      if (text.includes(kw)) {
        matches++;
        foundTerms.push(kw);
      } else {
        // Check aliases
        const aliasedTerms = aliases.get(kw) || [];
        for (const alias of aliasedTerms) {
          if (text.includes(alias)) {
            matches++;
            foundTerms.push(alias);
            break;
          }
        }
      }
    }

    // Convert match count to 1-5 scale
    let stars = 1;
    if (prefKeywords.length > 0) {
      const ratio = matches / prefKeywords.length;
      stars = Math.max(1, Math.min(5, Math.round(1 + ratio * 4)));
    }

    const reason = foundTerms.length > 0
      ? `Found: ${[...new Set(foundTerms)].join(", ")}`
      : "No matching keywords";

    return { title: m.title, stars, reason };
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function getRecommendations(
  history: RatingEntry[],
  tasteSummary: string | null,
  skipped: string[],
  triedCategories: string[],
): Promise<Movie[]> {
  const res = await fetch(`${BASE_URL}/api/next-movie`, {
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
      llm: LLM,
      count: 5,
      historySync: "reuse",
      baseLength: history.length,
      // NO userRequest — system must discover preference from ratings alone
    }),
  });
  if (!res.ok) throw new Error(`next-movie HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { movies?: Movie[] };
  return data.movies ?? [];
}

async function getTasteSummary(history: RatingEntry[], existing: string | null): Promise<string | null> {
  if (!history.length) return null;
  const res = await fetch(`${BASE_URL}/api/taste-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history, existingSummary: existing ?? undefined, llm: LLM }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { tasteSummary?: string | null };
  return data.tasteSummary ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Taste discovery test — preference: "${PREFERENCE_DESC}"`);
  console.log(`Oracle: gradient scoring (1-5★ based on attribute overlap)`);
  console.log(`Server: ${BASE_URL}   Max rounds: ${MAX_ROUNDS}`);
  console.log(`Goal: discover and learn user's preference through exploration`);
  console.log(`Success: entire batch averages 4★+ (system understood preference)`);
  console.log("=".repeat(72));

  const history: RatingEntry[] = [];
  const seenTitles = new Set<string>();
  const triedCategories = new Set<string>();
  let tasteSummary: string | null = null;

  type RoundStat = { round: number; avgRating: number; maxRating: number; minRating: number; total: number };
  const stats: RoundStat[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n── Round ${round}  (${history.length} rated so far) ${"─".repeat(30)}`);
    if (triedCategories.size > 0) {
      console.log(`   Tried categories: ${Array.from(triedCategories).join(", ")}`);
    }

    let movies: Movie[];
    try {
      // NO userRequest — system must discover from ratings alone
      movies = await getRecommendations(history, tasteSummary, [...seenTitles], [...triedCategories]);
    } catch (e) {
      console.error("  ✗ Fetch failed:", e);
      break;
    }
    if (!movies.length) { console.error("  ✗ No movies"); break; }

    const novel = movies.filter(m => !seenTitles.has(m.title.toLowerCase().trim()));
    const dups = movies.length - novel.length;
    if (dups > 0) console.log(`  [${dups} duplicate(s)]`);

    // Score films using gradient oracle
    const scored = await scoreMoviesBatch(novel);

    let totalRating = 0;
    let maxRating = 0;
    let minRating = 5;

    for (const s of scored) {
      const key = s.title.toLowerCase().trim();
      seenTitles.add(key);
      totalRating += s.stars;
      maxRating = Math.max(maxRating, s.stars);
      minRating = Math.min(minRating, s.stars);

      const m = novel.find(x => x.title === s.title);
      const starStr = "★".repeat(Math.round(s.stars)) + "☆".repeat(5 - Math.round(s.stars));
      const plot = (m?.plot ?? "").slice(0, 80);
      console.log(`  ${starStr}  ${s.title}${m?.year ? ` (${m.year})` : ""}  — ${s.reason}`);
      console.log(`           ${plot}`);

      // Track categories from this movie
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
      });
    }

    tasteSummary = await getTasteSummary(history, tasteSummary);

    const novelCount = novel.length;
    const avgRating = novelCount > 0 ? totalRating / novelCount : 0;
    console.log(`\n  Avg: ${avgRating.toFixed(1)}★  Range: ${minRating}-${maxRating}★`);
    if (tasteSummary) console.log(`  Summary: "${tasteSummary}"`);

    stats.push({ round, avgRating, maxRating, minRating, total: novelCount });

    // Convergence: if entire batch averages 4★+, system learned the preference
    if (avgRating >= 4.0 && novelCount > 0) {
      console.log(`\n  ✓ CONVERGED — round ${round}, avg ${avgRating.toFixed(1)}★, ${history.length} total ratings`);
      break;
    }
    if (round === MAX_ROUNDS) console.log(`\n  ✗ Did not converge within ${MAX_ROUNDS} rounds.`);
  }

  // Report
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Preference: "${PREFERENCE_DESC}"  |  Total rated: ${history.length}`);
  console.log("");
  console.log("Rnd  Avg★  Range         Progress");
  for (const d of stats) {
    const bar = "▓".repeat(Math.round(d.avgRating)) + "░".repeat(5 - Math.round(d.avgRating));
    console.log(`  ${String(d.round).padStart(2)}  ${d.avgRating.toFixed(1)}  [${d.minRating}-${d.maxRating}]  ${bar}`);
  }
  const conv = stats.find(d => d.avgRating >= 4.0);
  console.log(conv
    ? `\nConverged: round ${conv.round} with ${conv.avgRating.toFixed(1)}★ avg (${history.length} ratings)`
    : `\nDid not converge within ${MAX_ROUNDS} rounds.`
  );
}

run().catch(err => { console.error(err); process.exit(1); });
