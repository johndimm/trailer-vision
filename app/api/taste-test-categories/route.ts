import { callLLM } from "../next-movie/llm";

function stripMarkdownJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function POST(request: Request) {
  const raw = (await request.json()) as { count?: number; llm?: string };
  const count = Math.min(20, Math.max(1, Math.floor(Number(raw.count) || 7)));
  const llm = raw.llm ?? "deepseek";

  const systemPrompt = `You propose taste profiles for testing a movie/TV recommendation discovery system.

Each profile is a short phrase (roughly 2–5 words) describing one coherent viewing preference the system must infer from ratings alone — without being told the profile upfront.

Profiles should be diverse across regions, eras, genres, moods, and formats. Invent them freely; do not copy a fixed checklist. No two profiles in one batch should overlap heavily.`;

  const userMessage = `Suggest exactly ${count} distinct taste profiles for separate test runs.

Reply ONLY with JSON:
{"categories":["profile one","profile two",...]}`;

  try {
    const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 400 });
    const cleaned = stripMarkdownJsonFence(text);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return Response.json({ error: "invalid LLM response", raw: text }, { status: 502 });
    }
    const parsed = JSON.parse(match[0]) as { categories?: unknown };
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, count)
      : [];
    if (!categories.length) {
      return Response.json({ error: "no categories in response", raw: text }, { status: 502 });
    }
    return Response.json({ categories });
  } catch (err) {
    console.error("[taste-test-categories]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "category list failed" },
      { status: 500 },
    );
  }
}
