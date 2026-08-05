import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cloud Run runs the app as a container, so the build has to emit a server
  // that carries its own traced node_modules rather than one that expects the
  // repo to be present. `next start` still works locally either way.
  output: "standalone",
  // MUI + emotion are transpiled fine by default in Next 15; listed here so the
  // intent is explicit if we later add ESM-only chart packages.
  transpilePackages: [],

  async headers() {
    return [
      {
        // Next marks prerendered pages `s-maxage=31536000`, telling a shared
        // cache to hold them for a year. Behind Firebase Hosting that means a
        // deployed UI change never reaches anyone whose edge node already has
        // an older copy — including a login page still listing demo
        // credentials. These pages are shells that fetch live data after
        // hydration, so there is nothing here worth caching at the edge.
        //
        // Hashed build assets under _next/static are excluded: their filenames
        // change every build, so caching those hard is both free and correct.
        source: "/((?!_next/static|_next/image).*)",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
