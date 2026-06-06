/**
 * Classify a batch of movies against a taste profile description.
 * Used by the taste-adaptation test script (scripts/taste-test.ts).
 *
 * POST body: { movies: Movie[], profileDescription: string, llm?: string }
 * Response:  { results: { title: string; match: boolean; reason: string }[] }
 */
import { callLLM } from "../next-movie/llm";

interface Movie {
  title: string;
  type?: string;
  plot?: string;
  year?: number | null;
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    movies?: Movie[];
    profileDescription?: string;
    llm?: string;
  };

  const movies = raw.movies ?? [];
  const profileDescription = raw.profileDescription ?? "";
  const llm = raw.llm ?? "deepseek";

  if (!movies.length || !profileDescription) {
    return Response.json({ results: [] });
  }

  const movieLines = movies.map((m, i) =>
    `${i + 1}. "${m.title}"${m.year ? ` (${m.year})` : ""}${m.plot ? ` — ${m.plot.slice(0, 120)}` : ""}`
  ).join("\n");

  const systemPrompt = `You classify movies against a viewer taste profile. For each movie, decide: does this movie genuinely match the described preference? Reply ONLY with a JSON array, one entry per movie, in the same order. Each entry: { "title": string, "match": boolean, "reason": string (≤15 words) }. No other text.`;

  const userMessage = `Taste profile: "${profileDescription}"

Movies to classify:
${movieLines}`;

  let raw2: string;
  try {
    raw2 = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 400 });
  } catch (err) {
    console.error("[classify] LLM failed:", err);
    return Response.json({ results: [] }, { status: 500 });
  }

  try {
    // Extract JSON array from response (may have markdown fences)
    const match = raw2.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : raw2) as { title: string; match: boolean; reason: string }[];
    return Response.json({ results: parsed });
  } catch {
    console.error("[classify] Could not parse LLM response:", raw2.slice(0, 200));
    return Response.json({ results: [] }, { status: 500 });
  }
}
