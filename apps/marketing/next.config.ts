import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // As the app's (apps/web/next.config.ts): the dev server used from the dev box's domains.
  allowedDevOrigins:
    process.env.ALLOWED_DEV_ORIGINS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [],
  // The home page's screenshots (landing.tsx), resized per screen.
  // 1280 and 1536 too: the bento's pictures on a 2× phone (640px) and a 2× laptop (about 730px) would otherwise jump to 1920.
  images: { formats: ["image/avif", "image/webp"], deviceSizes: [640, 750, 828, 1080, 1200, 1280, 1536, 1920, 2048, 3840] },
  env: {
    // Where links to the app go (src/app/links.ts). In production nowhere else: the domain sends /app, /api, /_tuti and
    // /help to the app, the rest here (README, "Production routing"). In development the app is its own dev server.
    APP_LINKS: phase === PHASE_DEVELOPMENT_SERVER ? new URL(process.env.APP_URL || "http://localhost:3100").origin : "",
  },
});

export default nextConfig;
