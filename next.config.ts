import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@johndimm/constellations"],
  env: {
    NEXT_PUBLIC_API_KEY: process.env.GEMINI_API_KEY ?? "",
    VITE_API_KEY: process.env.GEMINI_API_KEY ?? "",
    VITE_AI_PROVIDER: (
      process.env.VITE_AI_PROVIDER ||
      process.env.NEXT_PUBLIC_VITE_AI_PROVIDER ||
      (process.env.NEXT_PUBLIC_VITE_CACHE_URL || process.env.VITE_CACHE_URL || process.env.VITE_CACHE_API_URL ? "" : "gemini")
    ),
    // Route Constellations AI calls through this app so /api/ai/connections can
    // use TMDB credits instead of the external LLM (which hallucinates for new films).
    // Must be same-origin as the page to avoid CORS. Priority:
    //   1. NEXT_PUBLIC_APP_URL  – set this in Vercel dashboard to the production domain
    //   2. VERCEL_PROJECT_PRODUCTION_URL – Vercel's canonical production URL (no hash)
    //   3. VERCEL_URL – per-deployment preview URL (different origin → CORS risk)
    //   4. localhost fallback
    NEXT_PUBLIC_VITE_CACHE_URL: (
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000")
    ),
    // Keep a reference to the original Constellations backend for forwarding.
    CONSTELLATIONS_EXTERNAL_URL: (
      process.env.NEXT_PUBLIC_VITE_CACHE_URL ||
      process.env.VITE_CACHE_URL ||
      "https://constellations-beaf.onrender.com"
    ),
  },
};

export default nextConfig;
