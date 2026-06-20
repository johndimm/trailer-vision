import { NextRequest, NextResponse } from "next/server";

const EXTERNAL_BASE = process.env.CONSTELLATIONS_EXTERNAL_URL ?? "https://constellations-beaf.onrender.com";

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
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    console.warn("[/node] forward failed:", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) { return forward(req); }
export async function GET(req: NextRequest) { return forward(req); }
