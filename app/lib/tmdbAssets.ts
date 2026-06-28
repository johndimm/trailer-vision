type MediaType = "movie" | "tv";

type TmdbSearchHit = {
  id?: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
};

function getYoutubeDataApiKey(): string | undefined {
  return process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY;
}

/** Flipped to true on first 400/403 from YouTube Data API — key is misconfigured, stop calling it. */
let youtubeDataApiDisabled = false;

function normalizeTitleForMatch(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function releaseYear(hit: TmdbSearchHit): number | null {
  const d = hit.release_date ?? hit.first_air_date ?? "";
  const y = parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function titleMatchScore(queryTitle: string, resultTitle: string): number {
  const q = normalizeTitleForMatch(queryTitle);
  const r = normalizeTitleForMatch(resultTitle);
  if (!q || !r) return 0;
  if (q === r) return 100;
  if (r.startsWith(q) || q.startsWith(r)) return 55;
  if (r.includes(q) || q.includes(r)) return 25;
  return 0;
}

function yearProximityScore(requestYear: number | null, hit: TmdbSearchHit): number {
  if (requestYear === null) return 0;
  const ry = releaseYear(hit);
  if (ry === null) return -5;
  const diff = Math.abs(ry - requestYear);
  if (diff === 0) return 30;
  if (diff === 1) return 18;
  if (diff <= 3) return 6;
  return -diff * 15;
}

function pickBestTmdbHit(title: string, year: number | null, results: TmdbSearchHit[]): TmdbSearchHit | null {
  if (results.length === 0) return null;
  let best: TmdbSearchHit | null = null;
  let bestScore = -Infinity;
  for (const hit of results) {
    const name = hit.title ?? hit.name ?? "";
    const titleScore = titleMatchScore(title, name);
    if (titleScore <= 0) continue;
    const posterBonus = hit.poster_path ? 4 : 0;
    const score = titleScore + yearProximityScore(year, hit) + posterBonus;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best;
}

function dedupeTmdbHits(results: TmdbSearchHit[]): TmdbSearchHit[] {
  const seen = new Set<number>();
  const out: TmdbSearchHit[] = [];
  for (const hit of results) {
    const id = hit.id;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
  }
  return out;
}

export async function youtubeOembedLooksOk(videoId: string): Promise<boolean | null> {
  try {
    const u = new URL("https://www.youtube.com/oembed");
    u.searchParams.set("url", `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    u.searchParams.set("format", "json");
    const res = await fetch(u.toString(), {
      headers: { "User-Agent": "movie-recs/1.0 (trailer oEmbed check)" },
    });
    if (res.status === 404 || res.status === 401 || res.status === 403) return false;
    if (res.status >= 200 && res.status < 300) return true;
    return null;
  } catch {
    return null;
  }
}

export async function youtubeVideoIsEmbeddableForSite(videoId: string): Promise<boolean> {
  const oembed = await youtubeOembedLooksOk(videoId);
  if (oembed === false) return false;

  const key = getYoutubeDataApiKey();
  if (!key || youtubeDataApiDisabled) return true;

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status,contentDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) {
      if (res.status === 400 || res.status === 403) {
        youtubeDataApiDisabled = true;
        console.warn(
          `[tmdbAssets] YouTube Data API returned ${res.status} — key may not have YouTube Data API v3 enabled. Disabling for this process.`,
        );
      } else {
        console.warn("[tmdbAssets] YouTube Data API HTTP", res.status);
      }
      return true;
    }
    const data = (await res.json()) as {
      items?: Array<{
        status?: { embeddable?: boolean };
        contentDetails?: { contentRating?: { ytRating?: string } };
      }>;
    };
    const item = data.items?.[0];
    if (!item) return false;
    if (item.status?.embeddable === false) return false;
    if (item.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") return false;
    return true;
  } catch (e) {
    console.warn("[tmdbAssets] YouTube Data API check failed", e);
    return true;
  }
}

function orderedYoutubeCandidateKeys(
  ytVideos: { key: string; site: string; type: string; official?: boolean }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (k: string | undefined) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  const trailers = ytVideos.filter((v) => v.type === "Trailer");
  trailers.sort((a, b) => Number(!!b.official) - Number(!!a.official));
  for (const v of trailers) add(v.key);
  for (const v of ytVideos) add(v.key);
  return out;
}

async function searchTmdb(
  apiKey: string,
  title: string,
  type: MediaType,
  year: number | null,
): Promise<TmdbSearchHit[]> {
  const base = "https://api.themoviedb.org/3";
  const path = type === "tv" ? "search/tv" : "search/movie";
  const params = new URLSearchParams({ api_key: apiKey, query: title });
  if (year !== null && year !== undefined) {
    if (type === "tv") params.set("first_air_date_year", String(year));
    else params.set("year", String(year));
  }
  const res = await fetch(`${base}/${path}?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[tmdbAssets] TMDB search HTTP", res.status, errBody.slice(0, 200));
    return [];
  }
  const data = (await res.json()) as { results?: TmdbSearchHit[] };
  return data.results ?? [];
}

export async function fetchTrailerFromTmdbVideos(
  apiKey: string,
  tmdbId: number,
  type: MediaType,
): Promise<string | null> {
  const base = "https://api.themoviedb.org/3";
  try {
    const videoPath = type === "tv" ? `tv/${tmdbId}/videos` : `movie/${tmdbId}/videos`;
    const vRes = await fetch(`${base}/${videoPath}?api_key=${apiKey}`);
    if (!vRes.ok) return null;
    const vData = (await vRes.json()) as {
      results?: { key: string; site: string; type: string; official?: boolean }[];
    };
    const ytVideos = (vData.results ?? []).filter((v) => v.site === "YouTube");
    for (const key of orderedYoutubeCandidateKeys(ytVideos)) {
      if (await youtubeVideoIsEmbeddableForSite(key)) return key;
    }
    return null;
  } catch (e) {
    console.error("[tmdbAssets] TMDB videos fetch failed:", e);
    return null;
  }
}

async function searchYoutubeTrailer(
  title: string,
  year: number | null,
  director: string | null,
  leadActor: string | null = null,
): Promise<string | null> {
  const key = getYoutubeDataApiKey();
  if (!key) return null;

  const yearBit = year ? ` ${year}` : "";
  const queries = [
    `${title}${yearBit}${director ? ` ${director}` : ""} official trailer`,
    `${title}${yearBit} official trailer`,
    `${title}${yearBit} trailer`,
    leadActor ? `${title}${yearBit} ${leadActor} trailer` : null,
  ].filter((q): q is string => !!q?.trim());

  for (const q of queries) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", "15");
      url.searchParams.set("q", q.trim());
      url.searchParams.set("key", key);
      const res = await fetch(url.toString());
      if (!res.ok) {
        console.warn("[tmdbAssets] YouTube search HTTP", res.status, "for", q.trim());
        continue;
      }
      const data = (await res.json()) as {
        items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
      };
      for (const item of data.items ?? []) {
        const videoId = item.id?.videoId;
        if (!videoId) continue;
        const snippetTitle = item.snippet?.title ?? "";
        if (!snippetMatchesTitle(snippetTitle, title)) continue;
        if (await youtubeVideoIsEmbeddableForSite(videoId)) return videoId;
      }
    } catch (e) {
      console.warn("[tmdbAssets] YouTube search failed for", q.trim(), e);
    }
  }
  return null;
}

function snippetMatchesTitle(snippetTitle: string, queryTitle: string): boolean {
  const norm = normalizeTitleForMatch(queryTitle);
  if (!norm) return true;
  const snippet = normalizeTitleForMatch(snippetTitle);
  // Match if query is in snippet, or if first 3+ chars of query match snippet
  if (snippet.includes(norm)) return true;
  const shortNorm = norm.substring(0, Math.min(3, norm.length));
  return shortNorm.length >= 3 && snippet.startsWith(shortNorm);
}

async function searchSerperTrailer(
  title: string,
  year: number | null,
  type: MediaType,
): Promise<string | null> {
  if (!process.env.SERPER_API_KEY) return null;
  const yearStr = year ? ` ${year}` : "";
  const query = `${title}${yearStr} ${type === "tv" ? "TV series" : "film"} official trailer site:youtube.com`;
  try {
    const res = await fetch("https://google.serper.dev/videos", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { videos?: { link?: string }[] };
    for (const v of data.videos ?? []) {
      const link = v.link ?? "";
      const m = link.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
      const videoId = m?.[1];
      if (!videoId) continue;
      if (await youtubeVideoIsEmbeddableForSite(videoId)) return videoId;
    }
    return null;
  } catch (e) {
    console.warn("[tmdbAssets] Serper video search failed", e);
    return null;
  }
}

async function resolveTrailerFallback(
  title: string,
  type: MediaType,
  year: number | null,
  director: string | null,
  tmdbReleaseYear: number | null = null,
  leadActor: string | null = null,
): Promise<string | null> {
  const yearsToTry: (number | null)[] = [];
  const seenYears = new Set<string>();
  const addYear = (y: number | null) => {
    const key = y === null ? "null" : String(y);
    if (seenYears.has(key)) return;
    seenYears.add(key);
    yearsToTry.push(y);
  };
  addYear(year);
  addYear(tmdbReleaseYear);
  addYear(null);

  for (const y of yearsToTry) {
    const fromYoutube = await searchYoutubeTrailer(title, y, director, leadActor);
    if (fromYoutube) return fromYoutube;
  }

  const fromSerper = await searchSerperTrailer(title, year ?? tmdbReleaseYear, type);
  if (fromSerper) return fromSerper;

  return null;
}

async function fetchPosterFromSerper(
  title: string,
  type: MediaType,
  year: number | null,
): Promise<string | null> {
  if (!process.env.SERPER_API_KEY) return null;
  const yearStr = year ? ` ${year}` : "";
  const query = `${title}${yearStr} ${type === "tv" ? "TV series" : "film"} official poster`;
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 3 }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { images?: { imageUrl: string; width?: number; height?: number }[] };
    const images = data.images ?? [];
    const portrait = images.find((img) => !img.width || !img.height || img.height >= img.width);
    const url = (portrait ?? images[0])?.imageUrl ?? null;
    return url ? url.replace(/^http:\/\//i, "https://") : null;
  } catch (e) {
    console.error("[tmdbAssets] Serper images fetch failed:", e);
    return null;
  }
}

export type TmdbResolvedMovie = {
  title: string;
  type: MediaType;
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  trailerKey: string | null;
};

async function findBestTmdbHit(
  apiKey: string,
  title: string,
  type: MediaType,
  year: number | null,
): Promise<TmdbSearchHit | null> {
  const withYear = year !== null ? await searchTmdb(apiKey, title, type, year) : [];
  const withoutYear = await searchTmdb(apiKey, title, type, null);
  const merged = dedupeTmdbHits([...withYear, ...withoutYear]);
  return pickBestTmdbHit(title, year, merged);
}

/** Resolve a named title directly from TMDB (search + details + credits + trailer). */
export async function resolveMovieFromTmdbByTitle(
  title: string,
  type: MediaType,
  year: number | null,
): Promise<TmdbResolvedMovie | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const hit = await findBestTmdbHit(apiKey, title, type, year);
    const tmdbId = hit?.id;
    if (!tmdbId) return null;

    const base = "https://api.themoviedb.org/3";
    const path = type === "tv" ? `tv/${tmdbId}` : `movie/${tmdbId}`;
    const [detailRes, credRes] = await Promise.all([
      fetch(`${base}/${path}?api_key=${apiKey}&language=en-US`),
      fetch(`${base}/${path}/credits?api_key=${apiKey}&language=en-US`),
    ]);
    if (!detailRes.ok) return null;

    const detail = (await detailRes.json()) as {
      title?: string;
      name?: string;
      release_date?: string;
      first_air_date?: string;
      overview?: string;
      poster_path?: string | null;
    };
    const credits = credRes.ok
      ? ((await credRes.json()) as {
          cast?: { name: string; order: number }[];
          crew?: { name: string; job: string }[];
        })
      : {};

    const resolvedTitle = detail.title || detail.name || hit.title || hit.name || title;
    const dateStr = detail.release_date || detail.first_air_date || hit.release_date || hit.first_air_date || "";
    const resolvedYear = dateStr ? parseInt(dateStr.slice(0, 4), 10) : releaseYear(hit);
    const director =
      credits.crew?.find((c) => c.job === "Director")?.name ??
      (type === "tv" ? credits.crew?.find((c) => c.job === "Creator")?.name ?? null : null);
    const actors = (credits.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((c) => c.name);
    const leadActor = actors[0] ?? null;
    const posterUrl = detail.poster_path
      ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
      : hit.poster_path
        ? `https://image.tmdb.org/t/p/w500${hit.poster_path}`
        : null;

    let trailerKey = await fetchTrailerFromTmdbVideos(apiKey, tmdbId, type);
    if (!trailerKey) {
      trailerKey = await resolveTrailerFallback(
        resolvedTitle,
        type,
        year,
        director,
        resolvedYear,
        leadActor,
      );
    }

    return {
      title: resolvedTitle,
      type,
      year: Number.isFinite(resolvedYear) ? resolvedYear : year,
      director,
      actors,
      plot: detail.overview ?? "",
      posterUrl,
      trailerKey,
    };
  } catch (e) {
    console.error("[tmdbAssets] resolveMovieFromTmdbByTitle failed:", e);
    return null;
  }
}

/** TMDB watch-provider id for Amazon Video (rent/buy); 9 is the separate Prime subscription. */
const AMAZON_VIDEO_PROVIDER_ID = 10;

export type WatchOptions = { amazon: boolean };

/**
 * Resolve a title to its TMDB id and report whether it's available to rent or buy on
 * Amazon Video in the US. Used to gate the affiliate link so it only appears for titles
 * the visitor can actually transact on.
 */
export async function fetchWatchOptions(
  title: string,
  type: MediaType,
  year: number | null,
): Promise<WatchOptions> {
  const none: WatchOptions = { amazon: false };
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !title.trim()) return none;

  try {
    const hit = await findBestTmdbHit(apiKey, title, type, year);
    const tmdbId = hit?.id;
    if (!tmdbId) return none;

    const path = type === "tv" ? `tv/${tmdbId}` : `movie/${tmdbId}`;
    const res = await fetch(
      `https://api.themoviedb.org/3/${path}/watch/providers?api_key=${apiKey}`,
    );
    if (!res.ok) return none;

    const json = (await res.json()) as {
      results?: Record<
        string,
        { rent?: { provider_id: number }[]; buy?: { provider_id: number }[] }
      >;
    };
    const us = json.results?.US;
    if (!us) return none;

    const transactional = [...(us.rent ?? []), ...(us.buy ?? [])];
    return { amazon: transactional.some((p) => p.provider_id === AMAZON_VIDEO_PROVIDER_ID) };
  } catch (e) {
    console.error("[tmdbAssets] fetchWatchOptions failed:", e);
    return none;
  }
}

export async function fetchTmdbAssets(
  title: string,
  type: MediaType,
  year: number | null,
  director: string | null = null,
): Promise<{ posterUrl: string | null; trailerKey: string | null; year: number | null }> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    const posterUrl = await fetchPosterFromSerper(title, type, year);
    const trailerKey = await resolveTrailerFallback(title, type, year, director, null);
    return { posterUrl, trailerKey, year: null };
  }

  try {
    const hit = await findBestTmdbHit(apiKey, title, type, year);
    const posterUrl = hit?.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
    const tmdbId = hit?.id ?? null;
    const tmdbReleaseYear = hit ? releaseYear(hit) : null;

    let trailerKey: string | null = null;
    if (tmdbId !== null) {
      trailerKey = await fetchTrailerFromTmdbVideos(apiKey, tmdbId, type);
      if (!trailerKey) {
        trailerKey = await resolveTrailerFallback(title, type, year, director, tmdbReleaseYear, null);
      }
    } else if (!posterUrl) {
      const serperPoster = await fetchPosterFromSerper(title, type, year);
      if (serperPoster) {
        return {
          posterUrl: serperPoster,
          trailerKey: await resolveTrailerFallback(title, type, year, director, null),
          year: null,
        };
      }
    }

    return { posterUrl, trailerKey, year: tmdbReleaseYear };
  } catch (e) {
    console.error("[tmdbAssets] TMDB assets fetch failed:", e);
    return { posterUrl: null, trailerKey: null, year: null };
  }
}
