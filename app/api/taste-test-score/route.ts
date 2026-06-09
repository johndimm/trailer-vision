import {
  mapPreferenceToTreePaths,
  normalizeCategoryTree,
  parseCategoryPathsFromRaw,
  tasteTestStarScore,
  type CategoryPath,
  type CategoryTree,
} from "../../lib/categoryTree";
import { callLLM } from "../next-movie/llm";

interface ScoreMovieInput {
  title: string;
  year?: number | null;
  plot?: string;
  categories?: string[];
  categoryPaths?: CategoryPath[];
}

interface ScoreResult {
  title: string;
  stars: number;
  reason: string;
}

function stripMarkdownJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    preference?: string;
    movies?: ScoreMovieInput[];
    llm?: string;
    categoryTree?: CategoryTree;
    targetPaths?: CategoryPath[];
    channelHint?: boolean;
    /** All-channel discovery: reward best-matching dimension, not compound average */
    discoveryMode?: boolean;
  };

  const preference = raw.preference?.trim();
  const movies = Array.isArray(raw.movies) ? raw.movies : [];
  const llm = raw.llm ?? "deepseek";
  const categoryTree = raw.categoryTree ? normalizeCategoryTree(raw.categoryTree) : null;

  if (!preference) {
    return Response.json({ error: "preference required" }, { status: 400 });
  }
  if (!movies.length) {
    return Response.json({ scores: [] });
  }

  let targetPaths = raw.targetPaths ?? [];
  if (categoryTree && !targetPaths.length) {
    targetPaths = await mapPreferenceToTreePaths(categoryTree, preference, llm);
  }

  const useTreeScoring = categoryTree && targetPaths.length > 0;

  if (useTreeScoring) {
    const scores: ScoreResult[] = movies.map((m) => {
      const filmPaths = m.categoryPaths?.length
        ? m.categoryPaths
        : parseCategoryPathsFromRaw(m.categoryPaths);
      const { stars, reason } = tasteTestStarScore(
        preference,
        targetPaths,
        { categories: m.categories, categoryPaths: filmPaths, year: m.year },
        {
          channelHint: raw.channelHint === true,
          discoveryMode: raw.discoveryMode === true,
        },
      );
      return { title: m.title, stars, reason };
    });
    return Response.json({ scores, targetPaths });
  }

  const movieLines = movies
    .map((m, i) => {
      const cats =
        m.categories?.length
          ? m.categories.join(", ")
          : "(no category tags — score cautiously from title/plot only)";
      const plot = m.plot?.trim() ? ` Plot: ${m.plot.slice(0, 160)}` : "";
      return `${i + 1}. "${m.title}"${m.year ? ` (${m.year})` : ""} — Categories: ${cats}${plot}`;
    })
    .join("\n");

  const systemPrompt = `You are a taste-test oracle scoring how well films match a target preference.

The PRIMARY signal is each film's category tags (assigned by the recommendation LLM). Do NOT keyword-match plot or title text — judge whether the category tags indicate a genuine fit for the preference.

Be strict about nuance: "family drama" is not "animated family"; "Iranian cinema" is not "Bollywood"; "crime thriller" is not "romantic comedy".

Reply with ONLY a JSON array, one object per film IN ORDER:
[{"title":"...","stars":4,"reason":"short explanation citing category tags"}]

stars must be an integer 1–5.`;

  const userMessage = `Target preference: "${preference}"

Rate each film 1–5 by how well its CATEGORY TAGS fit that preference:
- 5★: category tags are a clear, strong match
- 4★: several tags align well
- 3★: partial overlap
- 2★: weak or misleading overlap (e.g. shared word but wrong genre)
- 1★: category tags do not match the preference

Films:
${movieLines}`;

  try {
    const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 1200 });
    const cleaned = stripMarkdownJsonFence(text);
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      return Response.json({ error: "invalid LLM response", raw: text }, { status: 502 });
    }
    const parsed = JSON.parse(match[0]) as Array<{ title?: string; stars?: number; reason?: string }>;
    const scores: ScoreResult[] = movies.map((m, i) => {
      const row = parsed[i];
      const starsRaw = Number(row?.stars);
      const stars = Number.isFinite(starsRaw)
        ? Math.max(1, Math.min(5, Math.round(starsRaw)))
        : 3;
      const reason =
        typeof row?.reason === "string" && row.reason.trim()
          ? row.reason.trim()
          : m.categories?.length
            ? `Categories: ${m.categories.join(", ")}`
            : "No category tags";
      return { title: m.title, stars, reason };
    });
    return Response.json({ scores });
  } catch (err) {
    console.error("[taste-test-score]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "scoring failed" },
      { status: 500 },
    );
  }
}
