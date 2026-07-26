import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const EXTERNAL_BASE = process.env.CONSTELLATIONS_EXTERNAL_URL ?? "https://constellations-beaf.onrender.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function forward(req: NextRequest, name: string): Promise<NextResponse> {
  const url = `${EXTERNAL_BASE}/graphs/${encodeURIComponent(name)}`;
  try {
    const body = req.method !== "GET" && req.method !== "DELETE" ? await req.text() : undefined;
    const res = await fetch(url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status, headers: CORS_HEADERS });
  } catch (e) {
    console.warn("[/graphs/:name] forward failed:", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502, headers: CORS_HEADERS });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return forward(req, name);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return forward(req, name);
}
