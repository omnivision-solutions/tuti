import { prisma } from "@tuti/db";
import { passwordChangedEmail, passwordResetEmail, sendEmail, signInLinkEmail, verifyEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";

import { portalAddress, requestTarget, siteMount } from "@/server/custom-domains";

import { allowedHostPatterns, appUrl, portalTemplate } from "./hosts";
import { hashSecret, portalHandoff } from "./portal-handoff";
import { PASSWORD_RESET_MINUTES, SIGN_IN_LINK_MINUTES, type SignInLinkMetadata } from "./sign-in-link";
import { jwtSso } from "./sso";

/** Remembers which portal a sign-in link's token is for, and emails the portal's own link (see lib/sign-in-link.ts). */
async function sendSignInLink({ email, token, metadata }: { email: string; token: string; metadata?: Record<string, unknown> }) {
  const { linkId, slug, projectName, next } = metadata as SignInLinkMetadata;
  await prisma.signInLink.update({ where: { id: linkId }, data: { tokenHash: hashSecret(token) } });
  const url = new URL("/sign-in/link", await portalAddress(slug));
  url.searchParams.set("token", token);
  if (next !== "/") {
    url.searchParams.set("next", next);
  }
  await sendEmail({ to: email, ...signInLinkEmail({ projectName, url: url.toString(), minutes: SIGN_IN_LINK_MINUTES }) });
}

/**
 * Binds a password reset link's token to the host it was asked on and emails a link to
 * that host's /reset-password. Better Auth's request endpoint isn't served: only
 * emailPasswordReset (server/password-reset.ts) asks, passing its sign_in_link row's id
 * as `redirectTo`, which comes back here as the URL's callbackURL.
 */
async function sendPasswordReset({ user, url, token }: { user: { email: string }; url: string; token: string }) {
  const linkId = new URL(url).searchParams.get("callbackURL")!;
  const { project } = await prisma.signInLink.update({
    where: { id: linkId },
    data: { tokenHash: hashSecret(token) },
    select: { project: { select: { slug: true, name: true } } },
  });
  const link = new URL("/reset-password", project ? await portalAddress(project.slug) : appUrl());
  link.searchParams.set("token", token);
  await sendEmail({
    to: user.email,
    ...passwordResetEmail({ siteName: project?.name ?? "Tuti", url: link.toString(), minutes: PASSWORD_RESET_MINUTES }),
  });
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
  // A portal on its own domain (help.acme.com) while it's verified: its forms post from there.
  trustedOrigins: async (request) => {
    const host = request?.headers.get("host") ?? null;
    const target = await requestTarget(host);
    if (target.kind !== "portal") {
      return [];
    }
    // A portal under a path of its team's site posts from that site, once it's verified.
    const mount = await siteMount(target.slug);
    return [...(target.customDomain ? [`${new URL(portalTemplate()).protocol}//${host}`] : []), ...(mount ? [mount.origin] : [])];
  },
  advanced: {
    // tuti.session_token and the like: a portal under a path of a team's site (acme.com/portal) has its
    // cookies on that site, beside the site's own, which may be Better Auth's too.
    cookiePrefix: "tuti",
    // Behind a proxy (Cloudflare tunnel / load balancer) the original host and
    // protocol arrive in x-forwarded-* headers.
    trustedProxyHeaders: true,
  },
  emailAndPassword: {
    enabled: true,
    sendResetPassword: sendPasswordReset,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_MINUTES * 60,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      await prisma.$transaction([
        // Opening the emailed link proved they own the inbox.
        prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } }),
        // Any other reset links they were sent stop working (only reset tokens store a bare user id).
        prisma.verification.deleteMany({ where: { value: user.id } }),
      ]);
      try {
        await sendEmail({ to: user.email, ...passwordChangedEmail() });
      } catch (error) {
        // The password is already changed; a missing notice mustn't make it look like it wasn't.
        log.error("Sending the password changed email failed", { error });
      }
    },
  },
  // Reset tokens are stored hashed: a copy of the database mustn't be able to reset passwords.
  verification: { storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } } },
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
  // Password resets (server/password-reset.ts) likewise: asked for through emailPasswordReset (limits)
  // and set through setNewPassword (bound to the host that asked).
  disabledPaths: ["/sign-in/magic-link", "/magic-link/verify", "/request-password-reset", "/reset-password"],
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [
    jwtSso(),
    portalHandoff(),
    magicLink({ expiresIn: SIGN_IN_LINK_MINUTES * 60, storeToken: "hashed", sendMagicLink: sendSignInLink }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
