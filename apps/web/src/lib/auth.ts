import { prisma } from "@tuti/db";
import { sendEmail, verifyEmail } from "@tuti/email";
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
  // Verify ownership of the email address (invites are sent to addresses).
  // Signing in doesn't need it; the link signs people in if they aren't yet.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 24 * 60 * 60,
    sendVerificationEmail: async ({ user, url }, request) => {
      try {
        await sendEmail({ to: user.email, ...verifyEmail({ name: user.name, url }) });
      } catch (error) {
        console.error("Sending the verification email failed", error);
        // A failed email mustn't fail a sign-up (it can be sent again), but asking
        // to send it again should say it failed.
        if (request && new URL(request.url).pathname.endsWith("/send-verification-email")) {
          throw error;
        }
      }
    },
  },
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [jwtSso(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
