import { NextRequest, NextResponse } from "next/server";

const TMDB_BASE = "https://api.themoviedb.org/3";
const EXTERNAL_BASE = process.env.CONSTELLATIONS_EXTERNAL_URL ?? "https://constellations-beaf.onrender.com";

type GeminiPerson = {
  name: string;
  wikipediaTitle?: string;
  role: string;
  description: string;
  isAtomic: boolean;
  evidenceSnippet: string;
  evidencePageTitle: string;
};

/** Parse "Title (YYYY film)" or "Title (YYYY TV series)" → { title, year, isTV } */
function parseFilmWorkTerm(nodeName: string): { title: string; year: number | null; isTV: boolean } | null {
  const m = nodeName.match(/^(.+?)\s*\((\d{4})\s+(film|movie|TV series|television series)\)$/i);
  if (!m) return null;
  return {
    title: m[1].trim(),
    year: parseInt(m[2], 10),
    isTV: /tv|television/i.test(m[3]),
  };
}

async function tmdbConnections(apiKey: string, nodeName: string): Promise<{ sourceYear?: number; people: GeminiPerson[] } | null> {
  const parsed = parseFilmWorkTerm(nodeName);
  if (!parsed) return null;

  const { title, year, isTV } = parsed;

  // Search TMDB
  const searchEndpoint = isTV
    ? `${TMDB_BASE}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=en-US&page=1`
    : `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=en-US&page=1`;

  const searchRes = await fetch(searchEndpoint);
  if (!searchRes.ok) return null;

  const searchData = (await searchRes.json()) as {
    results?: Array<{ id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }>;
  };

  // Pick the best match: exact title match preferred, then closest year
  const results = searchData.results ?? [];
  let best = results[0];
  if (year) {
    const withYear = results.find((r) => {
      const d = r.release_date ?? r.first_air_date ?? "";
      return d.startsWith(String(year));
    });
    if (withYear) best = withYear;
  }
  if (!best) return null;

  const mediaType = isTV ? "tv" : "movie";
  const creditsRes = await fetch(
    `${TMDB_BASE}/${mediaType}/${best.id}/credits?api_key=${apiKey}&language=en-US`,
  );
  if (!creditsRes.ok) return null;

  const credits = (await creditsRes.json()) as {
    cast?: Array<{ name: string; character: string; order: number }>;
    crew?: Array<{ name: string; job: string }>;
  };

  const people: GeminiPerson[] = [];

  // Directors (movies) or Creators (TV)
  const directors = (credits.crew ?? []).filter((c) => c.job === "Director");
  for (const d of directors) {
    people.push({
      name: d.name,
      role: "Director",
      description: `Director of ${title}`,
      isAtomic: true,
      evidenceSnippet: `${d.name} directed ${title}.`,
      evidencePageTitle: title,
    });
  }

  // Top cast
  const cast = (credits.cast ?? []).sort((a, b) => a.order - b.order).slice(0, 10);
  for (const actor of cast) {
    people.push({
      name: actor.name,
      role: actor.character ? `Actor — ${actor.character}` : "Actor",
      description: actor.character ? `Played ${actor.character} in ${title}` : `Appeared in ${title}`,
      isAtomic: true,
      evidenceSnippet: actor.character
        ? `${actor.name} played ${actor.character} in ${title}.`
        : `${actor.name} appeared in ${title}.`,
      evidencePageTitle: title,
    });
  }

  // Screenplay / Writer
  const writers = (credits.crew ?? [])
    .filter((c) => ["Screenplay", "Writer", "Story"].includes(c.job))
    .slice(0, 2);
  for (const w of writers) {
    people.push({
      name: w.name,
      role: w.job,
      description: `${w.job} of ${title}`,
      isAtomic: true,
      evidenceSnippet: `${w.name} wrote the ${w.job.toLowerCase()} for ${title}.`,
      evidencePageTitle: title,
    });
  }

  const releaseStr = best.release_date ?? best.first_air_date ?? "";
  const sourceYear = releaseStr ? parseInt(releaseStr.slice(0, 4), 10) : year ?? undefined;

  return { sourceYear: sourceYear ?? undefined, people };
}

async function forwardToExternal(req: NextRequest, body: unknown): Promise<NextResponse> {
  try {
    const res = await fetch(`${EXTERNAL_BASE}/api/ai/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ people: [] });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { nodeName?: string; atomicType?: string; [key: string]: unknown };
  const apiKey = process.env.TMDB_API_KEY;

  if (apiKey && body.nodeName) {
    try {
      const result = await tmdbConnections(apiKey, body.nodeName);
      if (result && result.people.length > 0) {
        console.log(`[ai/connections] TMDB hit for "${body.nodeName}": ${result.people.length} people`);
        return NextResponse.json(result);
      }
    } catch (e) {
      console.warn("[ai/connections] TMDB lookup failed:", e);
    }
  }

  return forwardToExternal(req, body);
}
