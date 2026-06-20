import { NextRequest, NextResponse } from "next/server";
import { fetchTrailerFromTmdbVideos } from "@/app/lib/tmdbAssets";

const TMDB_BASE = "https://api.themoviedb.org/3";

const GENRE_NAME_TO_ID: Record<string, number> = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80,
  Documentary: 99, Drama: 18, Fantasy: 14, Horror: 27, Musical: 10402,
  Mystery: 9648, Romance: 10749, "Sci-Fi": 878, Thriller: 53, War: 10752, Western: 37,
};

// TV genres use different IDs
const TV_GENRE_NAME_TO_ID: Record<string, number> = {
  Action: 10759, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99,
  Drama: 18, Fantasy: 10765, "Sci-Fi": 10765, Mystery: 9648, Romance: 10749,
  War: 10768, Western: 37,
};

const LANGUAGE_TO_CODE: Record<string, string> = {
  English: "en", French: "fr", Italian: "it", Spanish: "es", German: "de",
  Japanese: "ja", Korean: "ko", Mandarin: "zh", Cantonese: "zh", Hindi: "hi",
  Portuguese: "pt", Russian: "ru", Arabic: "ar", Persian: "fa", Swedish: "sv",
  Danish: "da", Norwegian: "no", Finnish: "fi", Polish: "pl", Greek: "el",
  Turkish: "tr", Hebrew: "he",
};

type TmdbMovieItem = {
  _kind: "movie";
  id: number;
  title: string;
  original_language: string;
  overview: string;
  poster_path: string | null;
  release_date: string;
  genre_ids: number[];
};

type TmdbTvItem = {
  _kind: "tv";
  id: number;
  name: string;
  original_language: string;
  overview: string;
  poster_path: string | null;
  first_air_date: string;
  genre_ids: number[];
};

type TmdbItem = TmdbMovieItem | TmdbTvItem;

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

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

async function fetchItems(
  apiKey: string,
  kind: "movie" | "tv",
  page: number,
): Promise<{ items: TmdbItem[]; totalPages: number }> {
  const endpoint = kind === "movie"
    ? `${TMDB_BASE}/movie/upcoming?api_key=${apiKey}&language=en-US&page=${page}`
    : `${TMDB_BASE}/tv/on_the_air?api_key=${apiKey}&language=en-US&page=${page}`;

  const res = await fetch(endpoint);
  if (!res.ok) {
    console.error(`[upcoming] TMDB ${kind} fetch failed`, res.status);
    return { items: [], totalPages: 1 };
  }

  const data = (await res.json()) as { results?: unknown[]; total_pages?: number };
  const totalPages = data.total_pages ?? 1;

  const items: TmdbItem[] = (data.results ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown>;
    if (kind === "movie") {
      return {
        _kind: "movie" as const,
        id: row.id as number,
        title: row.title as string,
        original_language: row.original_language as string,
        overview: (row.overview as string) ?? "",
        poster_path: (row.poster_path as string | null) ?? null,
        release_date: (row.release_date as string) ?? "",
        genre_ids: (row.genre_ids as number[]) ?? [],
      };
    } else {
      return {
        _kind: "tv" as const,
        id: row.id as number,
        name: row.name as string,
        original_language: row.original_language as string,
        overview: (row.overview as string) ?? "",
        poster_path: (row.poster_path as string | null) ?? null,
        first_air_date: (row.first_air_date as string) ?? "",
        genre_ids: (row.genre_ids as number[]) ?? [],
      };
    }
  });

  return { items, totalPages };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No TMDB key configured" }, { status: 500 });

  const body = (await req.json()) as {
    page?: number;
    genres?: string[];
    language?: string;
    mediums?: string[];
    skipped?: string[];
  };

  const page = Math.max(1, body.page ?? 1);
  const mediums = body.mediums ?? [];
  const wantMovies = mediums.length === 0 || mediums.includes("movie");
  const wantTv = mediums.length === 0 || mediums.includes("tv");

  const filterMovieGenreIds = (body.genres ?? [])
    .map((g) => GENRE_NAME_TO_ID[g])
    .filter((id): id is number => id !== undefined);
  const filterTvGenreIds = (body.genres ?? [])
    .map((g) => TV_GENRE_NAME_TO_ID[g])
    .filter((id): id is number => id !== undefined);
  const langNames = (body.language ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const filterLangCodes = new Set(langNames.map((n) => LANGUAGE_TO_CODE[n]).filter((c): c is string => !!c));
  const skippedKeys = new Set((body.skipped ?? []).map(normTitle));
  const today = new Date().toISOString().slice(0, 10);

  // Fetch from TMDB in parallel
  const [movieResult, tvResult] = await Promise.all([
    wantMovies ? fetchItems(apiKey, "movie", page) : Promise.resolve({ items: [], totalPages: 1 }),
    wantTv ? fetchItems(apiKey, "tv", page) : Promise.resolve({ items: [], totalPages: 1 }),
  ]);

  const totalPages = Math.max(movieResult.totalPages, tvResult.totalPages);

  // Filter movies
  let movies = movieResult.items as TmdbMovieItem[];
  movies = movies.filter((m) => !m.release_date || m.release_date >= today);
  if (filterMovieGenreIds.length > 0) movies = movies.filter((m) => m.genre_ids.some((g) => filterMovieGenreIds.includes(g)));
  if (filterLangCodes.size > 0) movies = movies.filter((m) => filterLangCodes.has(m.original_language));
  movies = movies.filter((m) => !skippedKeys.has(normTitle(m.title)));

  // Filter TV shows — only include shows that premiered within the last 2 years
  // /tv/on_the_air includes any show with episodes airing this week, including decades-old series
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const twoYearsAgoStr = twoYearsAgo.toISOString().slice(0, 10);
  let shows = tvResult.items as TmdbTvItem[];
  shows = shows.filter((s) => s.first_air_date && s.first_air_date >= twoYearsAgoStr);
  if (filterTvGenreIds.length > 0) shows = shows.filter((s) => s.genre_ids.some((g) => filterTvGenreIds.includes(g)));
  if (filterLangCodes.size > 0) shows = shows.filter((s) => filterLangCodes.has(s.original_language));
  shows = shows.filter((s) => !skippedKeys.has(normTitle(s.name)));

  console.log(`[upcoming] page=${page} movies=${movies.length} tv=${shows.length} langs=[${[...filterLangCodes].join(",")}]`);

  const allItems: TmdbItem[] = [...movies, ...shows];
  if (allItems.length === 0) return NextResponse.json({ movies: [], totalPages, page });

  // Fetch trailers in parallel
  const trailerTasks = allItems.map(
    (item) => () => fetchTrailerFromTmdbVideos(apiKey, item.id, item._kind),
  );
  const trailerKeys = await pLimit(trailerTasks, 6);

  const withTrailers = allItems
    .map((item, i) => ({ item, trailerKey: trailerKeys[i] }))
    .filter((x): x is { item: TmdbItem; trailerKey: string } => !!x.trailerKey);

  if (withTrailers.length === 0) return NextResponse.json({ movies: [], totalPages, page });

  // Fetch credits
  const creditTasks = withTrailers.map(({ item }) =>
    () => item._kind === "movie"
      ? fetchMovieCredits(apiKey, item.id)
      : fetchTvCredits(apiKey, item.id),
  );
  const credits = await pLimit(creditTasks, 6);

  const result: CurrentMovie[] = withTrailers.map(({ item, trailerKey }, i) => {
    if (item._kind === "movie") {
      return {
        title: item.title,
        type: "movie",
        year: item.release_date ? parseInt(item.release_date.slice(0, 4), 10) : null,
        director: credits[i].director,
        actors: credits[i].actors,
        plot: item.overview,
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        trailerKey,
        rtScore: null,
        reason: null,
        predictedRating: 3,
        streaming: [],
      };
    } else {
      return {
        title: item.name,
        type: "tv",
        year: item.first_air_date ? parseInt(item.first_air_date.slice(0, 4), 10) : null,
        director: credits[i].director,
        actors: credits[i].actors,
        plot: item.overview,
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        trailerKey,
        rtScore: null,
        reason: null,
        predictedRating: 3,
        streaming: [],
      };
    }
  });

  return NextResponse.json({ movies: result, totalPages, page });
}
