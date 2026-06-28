import { fetchWatchOptions } from "../../lib/tmdbAssets";

export const maxDuration = 30;

/** Given a title, report whether it can be rented/bought on Amazon Video (US). */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { title?: unknown; type?: unknown; year?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const type = body.type === "tv" ? "tv" : "movie";
    const year = typeof body.year === "number" ? body.year : null;
    if (!title) return Response.json({ amazon: false });
    const options = await fetchWatchOptions(title, type, year);
    return Response.json(options);
  } catch {
    return Response.json({ amazon: false });
  }
}
