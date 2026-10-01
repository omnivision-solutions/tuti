import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server be used through the Cloudflare tunnel.
  allowedDevOrigins: ["dev.tuti.so"],
};

export default nextConfig;
