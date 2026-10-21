import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server be used through the Cloudflare tunnel (dev.tuti.so and
  // <workspace>--dev.tuti.so portals) and from <workspace>.localhost.
  allowedDevOrigins: ["dev.tuti.so", "*.tuti.so", "*.localhost"],
  // Where pages load Next.js's files (/_next/static) from, set when building: the app's own origin,
  // so a portal under a path of a team's site (acme.com/portal) doesn't ask that site for them.
  assetPrefix: process.env.ASSET_PREFIX || undefined,
  async headers() {
    // Fonts load across origins only with CORS; the files are public and the same for everyone.
    return [{ source: "/_next/static/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] }];
  },
};

export default nextConfig;
