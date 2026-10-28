import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // Lets the dev server be used from the dev box's domains (ALLOWED_DEV_ORIGINS, comma-separated):
  // Next.js blocks its dev resources (/_next chunks, HMR) on any other host, so client code wouldn't
  // run there.
  allowedDevOrigins:
    process.env.ALLOWED_DEV_ORIGINS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [],
  // Pages load Next.js's files from /_tuti/_next (proxy.ts serves them there): a path of its own on
  // every host, so a team's site that has its portal under a path (acme.com/portal) forwards /_tuti
  // too, instead of answering /_next itself (it may be a Next.js site). Not in development.
  ...(phase !== PHASE_DEVELOPMENT_SERVER && { assetPrefix: "/_tuti" }),
});

export default nextConfig;
