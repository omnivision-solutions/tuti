import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // Lets the dev server be used through the Cloudflare tunnel (dev.tuti.so and
  // <workspace>--dev.tuti.so portals) and from <workspace>.localhost.
  allowedDevOrigins: ["dev.tuti.so", "*.tuti.so", "*.localhost"],
  // Pages load Next.js's files from /_tuti/_next (proxy.ts serves them there): a path of its own on
  // every host, so a team's site that has its portal under a path (acme.com/portal) forwards /_tuti
  // too, instead of answering /_next itself (it may be a Next.js site). Not in development.
  ...(phase !== PHASE_DEVELOPMENT_SERVER && { assetPrefix: "/_tuti" }),
});

export default nextConfig;
