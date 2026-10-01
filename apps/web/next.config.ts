import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server be used through the Cloudflare tunnel (dev.tuti.so and
  // <workspace>--dev.tuti.so portals) and from <workspace>.localhost.
  allowedDevOrigins: ["dev.tuti.so", "*.tuti.so", "*.localhost"],
};

export default nextConfig;
