import { prisma } from "@tuti/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { allowedHostPatterns, appUrl } from "./hosts";
import { jwtSso } from "./sso";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // One deployment serves the app host and every portal host. Each host gets its
  // own (host-only) session cookies: a portal sign-in only applies to that portal.
  // Never enable advanced.crossSubDomainCookies — it would share sessions with
  // every project's subdomain.
  baseURL: {
    allowedHosts: allowedHostPatterns(),
    fallback: appUrl().origin,
    protocol: "auto",
  },
  advanced: {
    // Behind a proxy (Cloudflare tunnel / load balancer) the original host and
    // protocol arrive in x-forwarded-* headers.
    trustedProxyHeaders: true,
  },
  emailAndPassword: {
    enabled: true,
  },
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [jwtSso(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
