import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // As the app's (apps/web/next.config.ts): the dev server used from the dev box's domains.
  allowedDevOrigins:
    process.env.ALLOWED_DEV_ORIGINS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [],
  // The home page's screenshots (landing.tsx), resized per screen.
  images: { formats: ["image/avif", "image/webp"] },
  env: {
    // Where links to the app go (src/app/links.ts). In production nowhere else: the domain sends /app, /api, /_tuti and
    // /help to the app, the rest here (README, "Production routing"). In development the app is its own dev server.
    APP_LINKS: phase === PHASE_DEVELOPMENT_SERVER ? new URL(process.env.APP_URL || "http://localhost:3100").origin : "",
  },
});

export default nextConfig;
