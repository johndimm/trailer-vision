import { callLLM } from "../next-movie/llm";
import { migrateRatingValue } from "../../lib/ratingScale";

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
  categories?: string[];
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    history?: RatingEntry[];
    existingSummary?: string;
    llm?: string;
  };

  const llm = raw.llm ?? "deepseek";
  const history = (raw.history ?? []).filter(e => e.userRating != null);

  if (history.length === 0) {
    return Response.json({ tasteSummary: null });
  }

  // ── Category pattern analysis ──────────────────────────────────────────────
  // Group ratings by category (from LLM-assigned tags) and compute averages.
  const catRatings = new Map<string, number[]>();
  let entriesWithCategories = 0;

  for (const entry of history) {
    const u = migrateRatingValue(entry.userRating);
    if (entry.categories && entry.categories.length > 0) {
      entriesWithCategories++;
      for (const cat of entry.categories) {
        if (!catRatings.has(cat)) catRatings.set(cat, []);
        catRatings.get(cat)!.push(u);
      }
    }
  }

  // Build a structured category preference list when we have enough data
  const categorySection = (() => {
    if (entriesWithCategories < 3) return "";

    const stats = [...catRatings.entries()]
      .map(([cat, ratings]) => ({
        cat,
        avg: ratings.reduce((a, b) => a + b, 0) / ratings.length,
        count: ratings.length,
      }))
      .filter(s => s.count >= 2)
      .sort((a, b) => b.avg - a.avg);

    if (stats.length === 0) return "";

    const loved    = stats.filter(s => s.avg >= 4.0).map(s => `${s.cat} (${s.avg.toFixed(1)}★, n=${s.count})`);
    const neutral  = stats.filter(s => s.avg > 2.0 && s.avg < 4.0).map(s => `${s.cat} (${s.avg.toFixed(1)}★, n=${s.count})`);
    const disliked = stats.filter(s => s.avg <= 2.0).map(s => `${s.cat} (${s.avg.toFixed(1)}★, n=${s.count})`);

    const lines: string[] = [];
    if (loved.length)    lines.push(`Consistently rates HIGH (4-5★): ${loved.join(", ")}`);
    if (neutral.length)  lines.push(`Mixed response (2-4★): ${neutral.join(", ")}`);
    if (disliked.length) lines.push(`Consistently rates LOW (1-2★): ${disliked.join(", ")}`);

    return `\nCATEGORY PREFERENCES (derived from ${entriesWithCategories} rated titles):\n${lines.join("\n")}\n`;
  })();

  // ── Recent ratings with categories ────────────────────────────────────────
  const MAX_LINES = 20;
  const recent = history.slice(-Math.min(MAX_LINES, history.length));
  const ratingLines = recent.map(h => {
    const u = migrateRatingValue(h.userRating);
    const cats = h.categories?.length ? ` [${h.categories.join(", ")}]` : "";
    return `- "${h.title}" (${h.type}): ${u}/5★${cats}`;
  }).join("\n");

  const existingNote = raw.existingSummary
    ? `\nPrevious summary to refine: "${raw.existingSummary}"\n`
    : "";

  const isExploring = history.length < 20;
  const systemPrompt = `You analyze movie/TV viewer taste to write a short, specific taste profile in second person ("You..."). Focus primarily on which GENRES and CATEGORIES the viewer consistently enjoys or avoids — use the category preference data when available.
${isExploring ? "NOTE: The viewer is in early exploration mode (still discovering preferences). Low ratings don't mean they dislike movies — they're testing different categories to find what resonates. Be neutral and observational, not judgmental. You're describing a search in progress, not condemning their taste." : "Do not moralize about diverging from critics; the viewer may simply prefer certain genres."}
Be concrete and descriptive. 2–4 sentences max. Reply with ONLY the profile text.`;

  const userMessage = `${existingNote}${categorySection}
RECENT RATINGS (${history.length} total):
${ratingLines}`;

  let summary: string;
  try {
    summary = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 256 });
  } catch (err) {
    console.error("[taste-summary] LLM failed:", err);
    return Response.json({ tasteSummary: null });
  }

  return Response.json({ tasteSummary: summary.trim() || null });
}
