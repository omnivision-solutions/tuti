import { prisma } from "@tuti/db";
import { sendEmail, signInLinkEmail, verifyEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";

import { allowedHostPatterns, appUrl, portalUrl } from "./hosts";
import { hashSecret, portalHandoff } from "./portal-handoff";
import { SIGN_IN_LINK_MINUTES, type SignInLinkMetadata } from "./sign-in-link";
import { jwtSso } from "./sso";

/** Remembers which portal a sign-in link's token is for, and emails the portal's own link (see lib/sign-in-link.ts). */
async function sendSignInLink({ email, token, metadata }: { email: string; token: string; metadata?: Record<string, unknown> }) {
  const { linkId, slug, projectName, next } = metadata as SignInLinkMetadata;
  await prisma.signInLink.update({ where: { id: linkId }, data: { tokenHash: hashSecret(token) } });
  const url = new URL("/sign-in/link", portalUrl(slug));
  url.searchParams.set("token", token);
  if (next !== "/") {
    url.searchParams.set("next", next);
  }
  await sendEmail({ to: email, ...signInLinkEmail({ projectName, url: url.toString(), minutes: SIGN_IN_LINK_MINUTES }) });
}

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
        log.error("Sending the verification email failed", { error });
        // A failed email mustn't fail a sign-up (it can be sent again), but asking
        // to send it again should say it failed.
        if (request && new URL(request.url).pathname.endsWith("/send-verification-email")) {
          throw error;
        }
      }
    },
  },
  // Portal sign-in links (lib/sign-in-link.ts) are only asked for through the emailSignInLink
  // action (which applies the limits) and opened at the portal's /sign-in/link (bound to that portal).
  disabledPaths: ["/sign-in/magic-link", "/magic-link/verify"],
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [
    jwtSso(),
    portalHandoff(),
    magicLink({ expiresIn: SIGN_IN_LINK_MINUTES * 60, storeToken: "hashed", sendMagicLink: sendSignInLink }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
