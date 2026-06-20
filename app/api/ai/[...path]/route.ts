import { NextRequest, NextResponse } from "next/server";

const EXTERNAL_BASE = process.env.CONSTELLATIONS_EXTERNAL_URL ?? "https://constellations-beaf.onrender.com";

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const endpoint = `/api/ai/${path.join("/")}`;
  const url = `${EXTERNAL_BASE}${endpoint}`;
  try {
    const body = await req.text();
    const res = await fetch(url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: body || undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    console.warn(`[ai/${path.join("/")}] forward failed:`, e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return forward(req, path);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return forward(req, path);
}
