import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";

import { socialSignInConfig } from "./social-sign-in";

/**
 * Signing in from Tuti's mobile app (docs/plan.md, Mobile app). The app has no web view of its own for it: Google,
 * GitHub and an emailed link finish in the device's browser, which then opens the app through its link scheme with the
 * session. Only this scheme is trusted (lib/auth.ts), on the app's host only, on every server: a self-hosted one needs
 * no setting for it.
 *
 * The app uses Better Auth's Expo client (`@better-auth/expo/client`), and this is the server it expects: what that
 * package's own server plugin does, written here, narrower. Its package isn't a dependency of the web app: beside the
 * mobile app in one workspace, its optional peers would bring Expo and React Native into the web app's install.
 */
export const APP_ORIGIN = "tuti://";

/** Whether an address is the app's, as Better Auth reads the scheme: in any case, with or without the slashes. */
export const isAppLink = (url: unknown): url is string => typeof url === "string" && /^tuti:/i.test(url);

/** What the app made up when it asked for a link, which it gets back with the session: it takes no session it didn't ask for. */
const APP_SIGN_IN_STATE = /^[A-Za-z0-9_-]{16,128}$/;
export const isAppSignInState = (state: unknown): state is string => typeof state === "string" && APP_SIGN_IN_STATE.test(state);

/** Where an emailed link's "Open the app" sends the browser: the app, which checks `state`. */
export const appSignInReturn = (state: string) => `${APP_ORIGIN}sign-in?state=${state}`;

const refused = () => new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });

export const appSignIn = () =>
  ({
    id: "tuti-app-sign-in",
    // The app's requests come from no page, so they have no Origin; the Expo client says its scheme in `expo-origin`
    // instead, and that stands in for it: Better Auth checks it like any origin (trusted on the app's host only). A page
    // in a browser can't send that header to another site, and a request that has an Origin keeps it.
    async onRequest(request) {
      if (request.headers.get("origin") || !isAppLink(request.headers.get("expo-origin"))) {
        return;
      }
      const headers = new Headers(request.headers);
      headers.set("origin", APP_ORIGIN);
      return { request: new Request(request, { headers }) };
    },
    hooks: {
      after: [
        {
          // A sign-in that ends with a redirect to the app (Google's or GitHub's way back, the emailed link's
          // "Open the app"): the session's cookie rides in that redirect, as `cookie`, for the app to keep, and is the
          // app's alone. The browser it went through, which had no say in whose sign-in it finished, gets none.
          matcher: (ctx) => !!ctx.path?.startsWith("/callback") || ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.context.responseHeaders;
            const location = headers?.get("location");
            if (!headers || !isAppLink(location) || !ctx.context.isTrustedOrigin(location)) {
              return;
            }
            const cookie = headers.get("set-cookie");
            headers.delete("set-cookie");
            if (cookie) {
              const to = new URL(location);
              to.searchParams.set("cookie", cookie);
              ctx.setHeader("location", to.toString());
            }
          }),
        },
      ],
    },
    endpoints: {
      /**
       * GET /api/auth/expo-authorization-proxy?authorizationURL=…: the device's browser's first stop for Google or
       * GitHub. The app's own request started the sign-in, so the browser has nothing of it: this gives it the sign-in's
       * state (the cookie a provider's way back is checked against) and sends it on to the provider.
       *
       * Only for a sign-in that can only end at the app, where a session nobody asked for is refused by its state:
       * every way back it was started with (an account's, a new account's, an error's) is the app's. Never one of the
       * web's: any page could send a visitor here with the state of its own sign-in, and have their browser finish it,
       * signed in to the page's account. And only on to a provider set up here: never an open redirect.
       */
      expoAuthorizationProxy: createAuthEndpoint("/expo-authorization-proxy", { method: "GET", query: z.object({ authorizationURL: z.string().max(4000) }) }, async (ctx) => {
        const { authorizationURL } = ctx.query;
        const url = URL.canParse(authorizationURL) ? new URL(authorizationURL) : null;
        const state = url?.searchParams.get("state");
        const providers = socialSignInConfig("").map((provider) => new URL(provider.authorizationUrl!).origin);
        if (!url || !state || url.hash || !providers.includes(url.origin)) {
          throw refused();
        }
        // As Better Auth keeps a sign-in's state (`auth-state:`), with everywhere it may go back to.
        const kept = await ctx.context.internalAdapter.findVerificationValue(`auth-state:${state}`);
        let ends: { callbackURL?: unknown; newUserURL?: unknown; errorURL?: unknown } = {};
        try {
          ends = (kept && new Date(kept.expiresAt) > new Date() && (JSON.parse(kept.value) as typeof ends)) || {};
        } catch {}
        const appOrNone = (back: unknown) => back === undefined || back === null || isAppLink(back);
        if (!isAppLink(ends.callbackURL) || !appOrNone(ends.newUserURL) || !appOrNone(ends.errorURL)) {
          throw refused();
        }
        // The cookie Better Auth's own start of a sign-in sets (`state`, signed), for five minutes.
        const cookie = ctx.context.createAuthCookie("state", { maxAge: 300 });
        await ctx.setSignedCookie(cookie.name, state, ctx.context.secret, cookie.attributes);
        throw ctx.redirect(url.toString());
      }),
      /**
       * POST /api/auth/app/sign-in-link `{ email, state }`: emails an account a link that signs the app in (the page it
       * opens: /app/auth/app-link). Under the limits of every emailed link (server/email-link-limits.ts), and it answers
       * the same whether or not the address has an account: one without gets nothing, as the app has no sign-up.
       */
      appSignInLink: createAuthEndpoint(
        "/app/sign-in-link",
        {
          method: "POST",
          body: z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()), state: z.string().regex(APP_SIGN_IN_STATE) }),
        },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers();
          if (!emailConfigured() || (await requestTarget(headers.get("host"))).kind !== "app") {
            throw new APIError("BAD_REQUEST", { message: "Sign-in links aren't available here." });
          }
          const { email, state } = ctx.body;
          const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          // Imported here: both import lib/auth.ts, which imports this file.
          const { countEmailedLink } = await import("@/server/email-link-limits");
          const limited = await countEmailedLink(null, email, headers, account ? "address" : "nobody");
          if ("error" in limited) {
            throw new APIError("TOO_MANY_REQUESTS", { message: limited.error });
          }
          if (limited.id && account) {
            try {
              const { auth } = await import("./auth");
              await auth.api.signInMagicLink({ body: { email, metadata: { linkId: limited.id, app: state } }, headers });
            } catch (error) {
              // Only an address with an account gets this far, so the answer stays the same.
              log.error("Sending the app's sign-in link failed", { error });
            }
          }
          return ctx.json({ status: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
