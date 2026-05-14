import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@johndimm/constellations"],
  env: {
    NEXT_PUBLIC_API_KEY: process.env.GEMINI_API_KEY ?? "",
  },
};

export default nextConfig;
