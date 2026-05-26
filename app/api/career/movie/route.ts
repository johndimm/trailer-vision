import { NextRequest, NextResponse } from "next/server";
import { fetchTmdbAssets } from "../../../lib/tmdbAssets";

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

export async function GET(req: NextRequest) {
  const tmdbId = parseInt(req.nextUrl.searchParams.get("tmdbId") ?? "");
  const type = (req.nextUrl.searchParams.get("type") ?? "movie") as "movie" | "tv";
  if (!tmdbId || !TMDB_KEY) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  try {
    const path = type === "tv" ? `tv/${tmdbId}` : `movie/${tmdbId}`;
    const [detailRes, credRes] = await Promise.all([
      fetch(`${BASE}/${path}?api_key=${TMDB_KEY}&language=en-US`),
      fetch(`${BASE}/${path}/credits?api_key=${TMDB_KEY}&language=en-US`),
    ]);

    if (!detailRes.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const detail = (await detailRes.json()) as {
      title?: string; name?: string;
      release_date?: string; first_air_date?: string;
      overview?: string;
      poster_path?: string | null;
      vote_average?: number;
    };

    const credits = credRes.ok
      ? (await credRes.json()) as {
          cast?: { name: string; order: number }[];
          crew?: { name: string; job: string }[];
        }
      : {};

    const title = detail.title || detail.name || "Untitled";
    const dateStr = detail.release_date || detail.first_air_date || "";
    const year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
    const director = credits.crew?.find((c) => c.job === "Director")?.name ?? null;
    const actors = (credits.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((c) => c.name);
    const posterUrl = detail.poster_path
      ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
      : null;

    const assets = await fetchTmdbAssets(title, type, year, director);
    const trailerKey = assets.trailerKey;

    return NextResponse.json({
      title,
      type,
      year,
      director,
      actors,
      plot: detail.overview ?? "",
      posterUrl: posterUrl ?? assets.posterUrl,
      trailerKey: trailerKey ?? null,
      predictedRating: 3,
      rtScore: null,
      reason: null,
    });
  } catch (e) {
    console.error("[career/movie]", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
