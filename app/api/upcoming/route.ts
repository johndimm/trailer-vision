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

// TMDB watch-provider IDs (US region). Used with /discover `with_watch_providers`.
const STREAMING_PROVIDER_IDS: Record<string, number> = {
  "Netflix": 8,
  "Amazon Prime": 9,
  "Apple TV+": 350,
  "Disney+": 337,
  "HBO Max": 1899,
  "Hulu": 15,
  "Paramount+": 531,
  "Peacock": 386,
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

/** Date window for the streaming-filtered discover queries: recently released through ~4 weeks out. */
function recentReleaseWindow(): { gte: string; lte: string } {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const fourWeeksOut = new Date();
  fourWeeksOut.setDate(fourWeeksOut.getDate() + 28);
  return { gte: sixMonthsAgo.toISOString().slice(0, 10), lte: fourWeeksOut.toISOString().slice(0, 10) };
}

async function fetchItems(
  apiKey: string,
  kind: "movie" | "tv",
  page: number,
  watchProviders: string,
): Promise<{ items: TmdbItem[]; totalPages: number }> {
  // For TV use /discover/tv with a date window so we get genuinely new series,
  // not long-running shows that happen to have an episode airing this week.
  // When a streaming filter is active, use /discover (which supports watch providers)
  // for movies too, over a recent-release window — upcoming theatrical films aren't
  // on a service yet, so the curated /movie/upcoming list wouldn't match.
  const providerParams = watchProviders
    ? `&with_watch_providers=${watchProviders}&watch_region=US`
    : "";
  let endpoint: string;
  if (kind === "movie") {
    if (watchProviders) {
      const { gte, lte } = recentReleaseWindow();
      endpoint = `${TMDB_BASE}/discover/movie?api_key=${apiKey}&language=en-US&page=${page}&sort_by=primary_release_date.desc&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}${providerParams}`;
    } else {
      endpoint = `${TMDB_BASE}/movie/upcoming?api_key=${apiKey}&language=en-US&page=${page}`;
    }
  } else {
    const { gte, lte } = recentReleaseWindow();
    endpoint = `${TMDB_BASE}/discover/tv?api_key=${apiKey}&language=en-US&page=${page}&sort_by=first_air_date.desc&first_air_date.gte=${gte}&first_air_date.lte=${lte}${providerParams}`;
  }

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
    streaming?: string[];
    skipped?: string[];
  };

  const page = Math.max(1, body.page ?? 1);
  const mediums = body.mediums ?? [];
  const wantMovies = mediums.length === 0 || mediums.includes("movie");
  const wantTv = mediums.length === 0 || mediums.includes("tv");

  // Pipe-joined TMDB provider IDs = "available on any of these" for /discover.
  const watchProviders = (body.streaming ?? [])
    .map((s) => STREAMING_PROVIDER_IDS[s])
    .filter((id): id is number => id !== undefined)
    .join("|");

  const filterMovieGenreIds = (body.genres ?? [])
    .map((g) => GENRE_NAME_TO_ID[g])
    .filter((id): id is number => id !== undefined);
  const filterTvGenreIds = (body.genres ?? [])
    .map((g) => TV_GENRE_NAME_TO_ID[g])
    .filter((id): id is number => id !== undefined);
  const langNames = (body.language ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const filterLangCodes = new Set(langNames.map((n) => LANGUAGE_TO_CODE[n]).filter((c): c is string => !!c));
  const skippedKeys = new Set((body.skipped ?? []).map(normTitle));

  // Fetch from TMDB in parallel
  const [movieResult, tvResult] = await Promise.all([
    wantMovies ? fetchItems(apiKey, "movie", page, watchProviders) : Promise.resolve({ items: [], totalPages: 1 }),
    wantTv ? fetchItems(apiKey, "tv", page, watchProviders) : Promise.resolve({ items: [], totalPages: 1 }),
  ]);

  const totalPages = Math.max(movieResult.totalPages, tvResult.totalPages);

  // Filter movies — include anything releasing from 2 weeks ago onward
  // (TMDB's upcoming window can trail slightly behind today's date)
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const twoWeeksAgoStr = twoWeeksAgo.toISOString().slice(0, 10);
  let movies = movieResult.items as TmdbMovieItem[];
  // The streaming path already constrains dates via the discover window; the 2-week
  // floor only applies to the curated /movie/upcoming list.
  if (!watchProviders) movies = movies.filter((m) => !m.release_date || m.release_date >= twoWeeksAgoStr);
  if (filterMovieGenreIds.length > 0) movies = movies.filter((m) => m.genre_ids.some((g) => filterMovieGenreIds.includes(g)));
  if (filterLangCodes.size > 0) movies = movies.filter((m) => filterLangCodes.has(m.original_language));
  movies = movies.filter((m) => !skippedKeys.has(normTitle(m.title)));

  let shows = tvResult.items as TmdbTvItem[];
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
