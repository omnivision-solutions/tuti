import { createHmac, timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import { handOverOnVerified, projectSender } from "@tuti/jobs";
import { passwordChangedEmail, passwordResetEmail, sendEmail, signInLinkEmail, verifyEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";

import { portalAddress, requestTarget, sessionBinding, sessionWorksOn, siteMount } from "@/server/custom-domains";

import { CLIENT_IP_HEADER, withClientIp } from "./client-ip";
import { allowedHostPatterns, appUrl, portalTemplate } from "./hosts";
import { hashSecret, portalHandoff } from "./portal-handoff";
import { PASSWORD_RESET_MINUTES, SIGN_IN_LINK_MINUTES, type SignInLinkMetadata } from "./sign-in-link";
import { socialSignInConfig } from "./social-sign-in";
import { jwtSso } from "./sso";

/** Remembers which portal a sign-in link's token is for, and emails the portal's own link (see lib/sign-in-link.ts). */
async function sendSignInLink({ email, token, metadata }: { email: string; token: string; metadata?: Record<string, unknown> }) {
  const { linkId, slug, projectName, next } = metadata as SignInLinkMetadata;
  await prisma.signInLink.update({ where: { id: linkId }, data: { tokenHash: hashSecret(token) } });
  // After the address: it can have a path (a portal under its site's /portal).
  const url = new URL(`${await portalAddress(slug)}/sign-in/link`);
  url.searchParams.set("token", token);
  if (next !== "/") {
    url.searchParams.set("next", next);
  }
  // From the project (see projectSender); it never waits for approval: people need to sign in.
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  await sendEmail({
    to: email,
    ...signInLinkEmail({ projectName, url: url.toString(), minutes: SIGN_IN_LINK_MINUTES }),
    ...(project && (await projectSender(project.id))),
  });
}

/**
 * Remembers a password reset link's token on the sign_in_link row of where it was asked and emails a link to the
 * app's /app/auth/reset-password, wherever that was: a portal's address can be its team's own domain or site, and the
 * password is the account's everywhere. Better Auth's request endpoint isn't served: only emailPasswordReset
 * (server/password-reset.ts) asks, passing its row's id as `redirectTo`, which comes back here as the URL's callbackURL.
 */
async function sendPasswordReset({ user, url, token }: { user: { email: string }; url: string; token: string }) {
  const linkId = new URL(url).searchParams.get("callbackURL")!;
  const { project } = await prisma.signInLink.update({
    where: { id: linkId },
    data: { tokenHash: hashSecret(token) },
    select: { project: { select: { id: true, name: true } } },
  });
  const link = new URL("/app/auth/reset-password", appUrl());
  link.searchParams.set("token", token);
  await sendEmail({
    to: user.email,
    ...passwordResetEmail({ siteName: project?.name ?? "Tuti", url: link.toString(), minutes: PASSWORD_RESET_MINUTES }),
    // A portal's reset comes from its project; the app's from Tuti.
    ...(project && (await projectSender(project.id))),
  });
}

/** How long an emailed verification link works (emailVerification.expiresIn), and so the way back it carries. */
export const VERIFICATION_SECONDS = 24 * 60 * 60;

/**
 * What marks a way back to a portal as one the app made for one account (withoutHandoffState): an HMAC, with the auth
 * secret, of the portal, the path, the account and when it was made.
 */
async function wayBackMac(portal: string, redirect: string, userId: string, issued: string): Promise<string> {
  return createHmac("sha256", (await auth.$context).secret)
    .update(`continue\n${portal}\n${redirect}\n${userId}\n${issued}`)
    .digest("base64url");
}

/**
 * Whether the app's /continue may start a new handoff for `portal` and `redirect` on its own: only for a way back it made
 * itself (`mac`), for the account signed in (`userId`: verifying signs it in just before), and no older than its link. Never
 * for a link someone crafts or lifts from their own email, since a portal's address can be its team's own domain or site.
 */
export async function isOwnWayBack(
  { portal, redirect, issued, mac }: { portal: string; redirect: string; issued: unknown; mac: unknown },
  userId: string | undefined,
): Promise<boolean> {
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!userId || typeof issued !== "string" || typeof mac !== "string" || !(age >= 0 && age <= VERIFICATION_SECONDS)) {
    return false;
  }
  const given = Buffer.from(mac);
  const wanted = Buffer.from(await wayBackMac(portal, redirect, userId, issued));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * A way back to `portal`'s `redirect` for the account `userId`, made by the app: the app's /continue with when it was made
 * and its MAC, which shows that account the "Continue to <project>" card, with the portal's address, to click on.
 */
export async function signedWayBack(portal: string, redirect: string, userId: string): Promise<string> {
  const issued = String(Math.floor(Date.now() / 1000));
  return `/app/auth/continue?${new URLSearchParams({ portal, redirect, issued, mac: await wayBackMac(portal, redirect, userId, issued) })}`;
}

/**
 * A verification link is opened later, maybe much later: its way back (callbackURL) mustn't carry a "Continue as"
 * handoff's state, used once and kept 10 minutes (lib/portal-handoff.ts). A sign-up from a portal has one (its `next` is
 * the app's /continue); in its place go when it was made and the app's MAC for this account (isOwnWayBack), with which
 * /continue starts a new handoff. Only for the sign-up's own email (`signingUp`): sending it again takes any address and
 * callbackURL from anyone, so there it would sign a way back for someone else's account. Elsewhere it goes to the app.
 */
async function withoutHandoffState(link: string, userId: string, signingUp: boolean): Promise<string> {
  const url = new URL(link);
  const back = url.searchParams.get("callbackURL");
  if (back?.startsWith("/app/auth/continue?") && !signingUp) {
    url.searchParams.set("callbackURL", "/");
  } else if (back?.startsWith("/app/auth/continue?")) {
    const callback = new URL(back, url);
    const portal = callback.searchParams.get("portal");
    url.searchParams.set("callbackURL", portal ? await signedWayBack(portal, callback.searchParams.get("redirect") ?? "", userId) : "/");
  }
  return url.toString();
}

/** handOverOnVerified, never failing what verified the address (it's verified either way); a failure is logged. */
const handOverPlaceholdersLogged = (userId: string) =>
  handOverOnVerified(userId).catch((error: unknown) => log.error("Handing an import's placeholders over failed", { error, userId }));

/**
 * What a portal's session may do on its portal with Better Auth's own endpoints: be read, sign out, and its account page's
 * verification email. Nothing of the account: its name is changed on the app (the portal's account page links there).
 */
const PORTAL_SESSION_PATHS = new Set(["/get-session", "/sign-out", "/send-verification-email"]);

/** Where the account's password is typed or set: the app's own host only (see passwordOnAppOnly). */
const PASSWORD_PATHS = new Set(["/sign-in/email", "/sign-up/email", "/change-password"]);

/**
 * A request to sign in, sign up or change the password from any host but the app's is refused: a portal's team may run
 * its host (its own domain, or its site's path) and see what's typed there. Portals send people to the app for it.
 * Calls from the server itself (auth.api, no host) aren't requests from a browser.
 */
async function passwordOnAppOnly(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const host = ctx.headers?.get("host");
  if (PASSWORD_PATHS.has(ctx.path) && host && (await requestTarget(host)).kind !== "app") {
    throw new APIError("FORBIDDEN", { message: "Sign in with a password on Tuti itself." });
  }
}

/**
 * Every auth request, auth.api.getSession's included: a session cookie is left out, as if there were none, unless its
 * session works here (sessionWorksOn: the app's, or this portal's own) and, for a portal's, the endpoint is one it may
 * use (PORTAL_SESSION_PATHS). Sessions from before they were bound (boundTo null) work nowhere.
 */
async function withoutSessionBoundElsewhere(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const name = ctx.context.authCookies.sessionToken.name;
  const token = await ctx.getSignedCookie(name, ctx.context.secret);
  if (!token) {
    return;
  }
  const session = await prisma.session.findUnique({ where: { token }, select: { boundTo: true } });
  if (!session || ((session.boundTo === "app" || PORTAL_SESSION_PATHS.has(ctx.path)) && (await sessionWorksOn(session.boundTo, ctx.headers!.get("host"))))) {
    return;
  }
  // Every copy, its name read as Better Auth reads it (better-call's parseCookies: trimmed, up to the first "=").
  const headers = new Headers(ctx.headers);
  const kept = headers.get("cookie")!.split(";").filter((part) => !part.includes("=") || part.slice(0, part.indexOf("=")).trim() !== name);
  headers.set("cookie", kept.join(";"));
  return { context: { headers } };
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
    // Who a request is from, for Better Auth's own limits (password sign-in, sign-up, verification emails): the address
    // in TRUSTED_IP_HEADER, read as the app's own limits read it (trustedClientIp), which the auth route and hooks.before
    // put in CLIENT_IP_HEADER. Better Auth's default, X-Forwarded-For, is whatever the visitor sends, or, when a proxy
    // appends to it, one bucket everyone shares. Without TRUSTED_IP_HEADER (README) that default stays.
    ...(process.env.TRUSTED_IP_HEADER?.trim() ? { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } } : {}),
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
      // Verified now: an import's placeholders for this address hand over (they're on the team).
      await handOverPlaceholdersLogged(user.id);
      try {
        await sendEmail({ to: user.email, ...passwordChangedEmail() });
      } catch (error) {
        // The password is already changed; a missing notice mustn't make it look like it wasn't.
        log.error("Sending the password changed email failed", { error });
      }
    },
  },
  // A session is bound to where it was started: a portal's (signing in there, "Continue as", SSO) to its project, as a
  // team runs its portal's custom domain or site, so can see its cookies there. It works there only (hooks.before).
  session: { additionalFields: { boundTo: { type: "string", required: false, input: false } } },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await passwordOnAppOnly(ctx);
      const headers = (await withoutSessionBoundElsewhere(ctx))?.context.headers ?? ctx.headers;
      // auth.api calls too (a session's IP address): the visitor's IP address as the auth route gives it.
      return headers && { context: { headers: withClientIp(headers) } };
    }),
  },
  // Continue with Google / GitHub only signs people in: their tokens are never used, and GitHub's (through tuti.so's
  // GitHub App) could read code where the App is installed. So none is kept, and none can be handed out again.
  databaseHooks: {
    // Where it's started: see `session` above.
    session: {
      create: { before: async (session, ctx) => ({ data: { ...session, boundTo: await sessionBinding(ctx?.headers?.get("host") ?? null) } }) },
    },
    // However an address comes to be verified (its link, a sign-in link, an account from Google or GitHub), an import's
    // placeholders for it hand over, in the projects they're on (a password reset is a direct update: it calls it too).
    user: { update: { after: async (user) => void (user.emailVerified && (await handOverPlaceholdersLogged(user.id))) } },
    account: {
      create: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) },
      update: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) },
    },
  },
  // Reset tokens are stored hashed: a copy of the database mustn't be able to reset passwords.
  verification: { storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } } },
  // Verify ownership of the email address (invites are sent to addresses).
  // Signing in doesn't need it; the link signs people in if they aren't yet.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: VERIFICATION_SECONDS,
    sendVerificationEmail: async ({ user, url }, request) => {
      try {
        const signingUp = !!request && new URL(request.url).pathname.endsWith("/sign-up/email");
        await sendEmail({ to: user.email, ...verifyEmail({ name: user.name, url: await withoutHandoffState(url, user.id, signingUp) }) });
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
  // and set through setNewPassword (on the app's host only).
  // Listing and revoking sessions: unused, and they'd show a portal's session (bound there, above) the account's others.
  disabledPaths: [
    "/sign-in/magic-link",
    "/magic-link/verify",
    "/request-password-reset",
    "/reset-password",
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
  ],
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [
    jwtSso(),
    portalHandoff(),
    magicLink({ expiresIn: SIGN_IN_LINK_MINUTES * 60, storeToken: "hashed", sendMagicLink: sendSignInLink }),
    // Continue with Google / GitHub on the app's sign-in and sign-up (lib/social-sign-in.ts).
    genericOAuth({ config: socialSignInConfig(appUrl().origin) }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
