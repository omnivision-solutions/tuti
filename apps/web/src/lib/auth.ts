import { prisma } from "@tuti/db";
import { handOverOnVerified, projectSender } from "@tuti/jobs";
import { passwordChangedEmail, passwordResetEmail, sendEmail, signInLinkEmail, verifyEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";

import { portalAddress, requestTarget, sessionBinding, sessionWorksOn, siteMount } from "@/server/custom-domains";

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
    select: { project: { select: { id: true, slug: true, name: true } } },
  });
  const link = new URL(`${project ? await portalAddress(project.slug) : appUrl().origin}/reset-password`);
  link.searchParams.set("token", token);
  await sendEmail({
    to: user.email,
    ...passwordResetEmail({ siteName: project?.name ?? "Tuti", url: link.toString(), minutes: PASSWORD_RESET_MINUTES }),
    // A portal's reset comes from its project; the app's from Tuti.
    ...(project && (await projectSender(project.id))),
  });
}

/** handOverOnVerified, never failing what verified the address (it's verified either way); a failure is logged. */
const handOverPlaceholdersLogged = (userId: string) =>
  handOverOnVerified(userId).catch((error: unknown) => log.error("Handing an import's placeholders over failed", { error, userId }));

/** What a portal's session may do on its portal with Better Auth's own endpoints: be read, sign out, and its account page's rename and verification email. */
const PORTAL_SESSION_PATHS = new Set(["/get-session", "/sign-out", "/send-verification-email", "/update-user"]);

/**
 * Every auth request, auth.api.getSession's included: a session cookie is left out, as if there were none, unless its
 * session works here (sessionWorksOn: the app's, or this portal's own) and, for a portal's, the endpoint is one it may
 * use (PORTAL_SESSION_PATHS; renaming only). Sessions from before they were bound (boundTo null) work nowhere.
 */
async function withoutSessionBoundElsewhere(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const name = ctx.context.authCookies.sessionToken.name;
  const token = await ctx.getSignedCookie(name, ctx.context.secret);
  if (!token) {
    return;
  }
  const session = await prisma.session.findUnique({ where: { token }, select: { boundTo: true } });
  const portalMay = PORTAL_SESSION_PATHS.has(ctx.path) && (ctx.path !== "/update-user" || Object.keys(ctx.body ?? {}).every((key) => key === "name"));
  if (!session || ((session.boundTo === "app" || portalMay) && (await sessionWorksOn(session.boundTo, ctx.headers!.get("host"))))) {
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
  hooks: { before: createAuthMiddleware(async (ctx) => withoutSessionBoundElsewhere(ctx)) },
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
