import { NextRequest, NextResponse } from "next/server";
import { fetchTrailerFromTmdbVideos } from "@/app/lib/tmdbAssets";

export const maxDuration = 60;

const TMDB_BASE = "https://api.themoviedb.org/3";

type TmdbMultiHit = {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  original_language?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
};

type CurrentMovie = {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  trailerKey: string | null;
  rtScore: null;
  reason: null;
  predictedRating: number;
  streaming: string[];
};

async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function fetchMovieCredits(apiKey: string, tmdbId: number): Promise<{ director: string | null; actors: string[] }> {
  try {
    const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits?api_key=${apiKey}&language=en-US`);
    if (!res.ok) return { director: null, actors: [] };
    const data = (await res.json()) as {
      cast?: { name: string; order: number }[];
      crew?: { name: string; job: string }[];
    };
    const director = data.crew?.find((c) => c.job === "Director")?.name ?? null;
    const actors = (data.cast ?? []).sort((a, b) => a.order - b.order).slice(0, 5).map((c) => c.name);
    return { director, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

async function fetchTvCredits(apiKey: string, tmdbId: number): Promise<{ director: string | null; actors: string[] }> {
  try {
    const [detailsRes, creditsRes] = await Promise.all([
      fetch(`${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey}&language=en-US`),
      fetch(`${TMDB_BASE}/tv/${tmdbId}/credits?api_key=${apiKey}&language=en-US`),
    ]);
    const details = detailsRes.ok
      ? (await detailsRes.json()) as { created_by?: { name: string }[] }
      : null;
    const credits = creditsRes.ok
      ? (await creditsRes.json()) as { cast?: { name: string; order: number }[] }
      : null;
    const creator = details?.created_by?.[0]?.name ?? null;
    const actors = (credits?.cast ?? []).sort((a, b) => a.order - b.order).slice(0, 5).map((c) => c.name);
    return { director: creator, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No TMDB key configured" }, { status: 500 });

  const body = (await req.json()) as { query?: string };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ movies: [] });

  // Multi-search returns movies, TV, and people in one shot. We keep titles only.
  const res = await fetch(
    `${TMDB_BASE}/search/multi?api_key=${apiKey}&language=en-US&include_adult=false&query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) {
    console.error("[search] TMDB multi search failed", res.status);
    return NextResponse.json({ movies: [] });
  }

  const data = (await res.json()) as { results?: TmdbMultiHit[] };
  const hits = (data.results ?? [])
    .filter((h) => (h.media_type === "movie" || h.media_type === "tv") && (h.title || h.name))
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 8);

  if (hits.length === 0) return NextResponse.json({ movies: [] });

  // Fetch trailers + credits in parallel for the top hits.
  const trailerKeys = await pLimit(
    hits.map((h) => () => fetchTrailerFromTmdbVideos(apiKey, h.id, h.media_type as "movie" | "tv")),
    6,
  );
  const credits = await pLimit(
    hits.map((h) => () =>
      h.media_type === "movie" ? fetchMovieCredits(apiKey, h.id) : fetchTvCredits(apiKey, h.id),
    ),
    6,
  );

  const movies: CurrentMovie[] = hits
    .map((h, i): CurrentMovie | null => {
      const posterUrl = h.poster_path ? `https://image.tmdb.org/t/p/w500${h.poster_path}` : null;
      const trailerKey = trailerKeys[i];
      // Nothing to show -- skip.
      if (!posterUrl && !trailerKey) return null;
      const dateStr = h.release_date || h.first_air_date || "";
      return {
        title: (h.title || h.name) as string,
        type: h.media_type as "movie" | "tv",
        year: dateStr ? parseInt(dateStr.slice(0, 4), 10) : null,
        director: credits[i].director,
        actors: credits[i].actors,
        plot: h.overview ?? "",
        posterUrl,
        trailerKey,
        rtScore: null,
        reason: null,
        predictedRating: 3,
        streaming: [],
      };
    })
    .filter((m): m is CurrentMovie => m !== null);

  return NextResponse.json({ movies });
}
