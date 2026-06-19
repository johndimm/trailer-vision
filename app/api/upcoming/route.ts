import { NextRequest, NextResponse } from "next/server";
import { fetchTrailerFromTmdbVideos } from "@/app/lib/tmdbAssets";

const TMDB_BASE = "https://api.themoviedb.org/3";

const GENRE_NAME_TO_ID: Record<string, number> = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80,
  Documentary: 99, Drama: 18, Fantasy: 14, Horror: 27, Musical: 10402,
  Mystery: 9648, Romance: 10749, "Sci-Fi": 878, Thriller: 53, War: 10752, Western: 37,
};

const LANGUAGE_TO_CODE: Record<string, string> = {
  English: "en", French: "fr", Italian: "it", Spanish: "es", German: "de",
  Japanese: "ja", Korean: "ko", Mandarin: "zh", Cantonese: "zh", Hindi: "hi",
  Portuguese: "pt", Russian: "ru", Arabic: "ar", Persian: "fa", Swedish: "sv",
  Danish: "da", Norwegian: "no", Finnish: "fi", Polish: "pl", Greek: "el",
  Turkish: "tr", Hebrew: "he",
};

type TmdbUpcomingItem = {
  id: number;
  title: string;
  original_language: string;
  overview: string;
  poster_path: string | null;
  release_date: string;
  genre_ids: number[];
};

type CurrentMovie = {
  title: string;
  type: "movie";
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

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function fetchCredits(
  apiKey: string,
  tmdbId: number,
): Promise<{ director: string | null; actors: string[] }> {
  try {
    const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits?api_key=${apiKey}&language=en-US`);
    if (!res.ok) return { director: null, actors: [] };
    const data = (await res.json()) as {
      cast?: { name: string; order: number }[];
      crew?: { name: string; job: string }[];
    };
    const director = data.crew?.find((c) => c.job === "Director")?.name ?? null;
    const actors = (data.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((c) => c.name);
    return { director, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No TMDB key configured" }, { status: 500 });

  const body = (await req.json()) as {
    page?: number;
    genres?: string[];
    language?: string;
    skipped?: string[];
  };

  const page = Math.max(1, body.page ?? 1);
  const filterGenreIds = (body.genres ?? [])
    .map((g) => GENRE_NAME_TO_ID[g])
    .filter((id): id is number => id !== undefined);
  const filterLangCode = body.language ? (LANGUAGE_TO_CODE[body.language] ?? null) : null;
  const skippedKeys = new Set((body.skipped ?? []).map(normTitle));

  const upcomingRes = await fetch(
    `${TMDB_BASE}/movie/upcoming?api_key=${apiKey}&language=en-US&page=${page}`,
  );
  if (!upcomingRes.ok) {
    console.error("[upcoming] TMDB fetch failed", upcomingRes.status);
    return NextResponse.json({ error: "TMDB fetch failed" }, { status: 502 });
  }

  const upcomingData = (await upcomingRes.json()) as {
    results?: TmdbUpcomingItem[];
    total_pages?: number;
    page?: number;
  };

  let movies = upcomingData.results ?? [];
  const totalPages = upcomingData.total_pages ?? 1;

  // TMDB upcoming can include re-releases of old films — drop anything already out.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  movies = movies.filter((m) => !m.release_date || m.release_date >= today);

  // Client-side filters (genre, language, already-seen)
  if (filterGenreIds.length > 0) {
    movies = movies.filter((m) => m.genre_ids.some((g) => filterGenreIds.includes(g)));
  }
  if (filterLangCode) {
    movies = movies.filter((m) => m.original_language === filterLangCode);
  }
  movies = movies.filter((m) => !skippedKeys.has(normTitle(m.title)));

  if (movies.length === 0) {
    return NextResponse.json({ movies: [], totalPages, page });
  }

  // Fetch trailers in parallel (embeddability-checked)
  const trailerTasks = movies.map(
    (m) => () => fetchTrailerFromTmdbVideos(apiKey, m.id, "movie"),
  );
  const trailerKeys = await pLimit(trailerTasks, 6);

  // Keep only movies with a working trailer
  const withTrailers = movies
    .map((m, i) => ({ movie: m, trailerKey: trailerKeys[i] }))
    .filter((x): x is { movie: TmdbUpcomingItem; trailerKey: string } => !!x.trailerKey);

  if (withTrailers.length === 0) {
    return NextResponse.json({ movies: [], totalPages, page });
  }

  // Fetch credits for movies that have trailers
  const creditTasks = withTrailers.map(({ movie }) => () => fetchCredits(apiKey, movie.id));
  const credits = await pLimit(creditTasks, 6);

  const result: CurrentMovie[] = withTrailers.map(({ movie, trailerKey }, i) => ({
    title: movie.title,
    type: "movie",
    year: movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : null,
    director: credits[i].director,
    actors: credits[i].actors,
    plot: movie.overview,
    posterUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
    trailerKey,
    rtScore: null,
    reason: null,
    predictedRating: 3,
    streaming: [],
  }));

  return NextResponse.json({ movies: result, totalPages, page });
}
