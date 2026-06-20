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

async function forward(req: NextRequest): Promise<NextResponse> {
  const url = `${EXTERNAL_BASE}/node`;
  try {
    const body = req.method !== "GET" ? await req.text() : undefined;
    const res = await fetch(url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status, headers: CORS_HEADERS });
  } catch (e) {
    console.warn("[/node] forward failed:", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502, headers: CORS_HEADERS });
  }
}

export async function POST(req: NextRequest) { return forward(req); }
export async function GET(req: NextRequest) { return forward(req); }
