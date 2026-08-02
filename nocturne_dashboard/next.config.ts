import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // MUI + emotion are transpiled fine by default in Next 15; listed here so the
  // intent is explicit if we later add ESM-only chart packages.
  transpilePackages: [],
};

export default nextConfig;
