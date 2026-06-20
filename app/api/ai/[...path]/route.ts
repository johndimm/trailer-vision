import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const EXTERNAL_BASE = process.env.CONSTELLATIONS_EXTERNAL_URL ?? "https://constellations-beaf.onrender.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const endpoint = `/api/ai/${path.join("/")}`;
  const url = `${EXTERNAL_BASE}${endpoint}`;
  try {
    const body = await req.text();
    const res = await fetch(url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: body || undefined,
      signal: AbortSignal.timeout(55_000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status, headers: CORS_HEADERS });
  } catch (e) {
    console.warn(`[ai/${path.join("/")}] forward failed:`, e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502, headers: CORS_HEADERS });
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
