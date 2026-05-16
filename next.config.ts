import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@johndimm/constellations"],
  env: {
    NEXT_PUBLIC_API_KEY: process.env.GEMINI_API_KEY ?? "",
    NEXT_PUBLIC_VITE_CACHE_URL: (
      process.env.NEXT_PUBLIC_VITE_CACHE_URL ||
      process.env.VITE_CACHE_URL ||
      process.env.VITE_CACHE_API_URL ||
      ""
    ),
  },
};

export default nextConfig;
