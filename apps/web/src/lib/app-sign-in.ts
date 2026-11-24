import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import type { BetterAuthPlugin } from "better-auth";
import { addOAuthServerContext, APIError, createAuthEndpoint, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";

import { hashSecret, randomSecret } from "./portal-handoff";

/**
 * Signing in from Tuti's mobile app (docs/plan.md, Mobile app). The app has no web view of its own for it: Google,
 * GitHub and an emailed link finish in the device's browser, which then opens the app through its link scheme. Only
 * this scheme is trusted (lib/auth.ts), on the app's host only, on every server: a self-hosted one needs no setting.
 *
 * A link scheme belongs to nobody: on Android another app can register it and receive the redirect. So the redirect
 * carries no session, only a code, and the code is worth nothing without a secret the app that started the sign-in
 * kept (PKCE, as RFC 8252 asks of native apps). The app signs in to an account that exists: none is made from it.
 *
 * The contract, all under the server's /api/auth, JSON in and out. The app's requests come from no page: it sends its
 * scheme in an `expo-origin: tuti://` header (Better Auth's Expo client does), which stands in for an origin.
 *
 * Before any sign-in the app makes up:
 * - `verifier`: 43 to 128 random characters of A-Z a-z 0-9 - . _ ~, kept on the device, never sent until step 3;
 * - `challenge`: the verifier's SHA-256, base64url without padding (43 characters);
 * - `state`: 16 to 128 random characters of A-Z a-z 0-9 - _.
 *
 * 1. Start, one of:
 *    - the emailed link: `POST /app/sign-in-link { email, state, challenge }` → `{ status: true }`, whether or not the
 *      address has an account (one without gets no email). The person opens the link and taps "Open the app".
 *    - Google or GitHub: `POST /sign-in/social { provider: "google" | "github", callbackURL: "tuti://sign-in?state=<state>",
 *      additionalData: { challenge } }` and nothing else → `{ url }`. The app opens the device's browser (an auth
 *      session) at `GET /expo-authorization-proxy?authorizationURL=<url>`, with `url` exactly as it came, which goes
 *      on to the provider.
 * 2. The browser is redirected to `tuti://sign-in?state=<state>&code=<code>`, or `…&error=<code>` (and maybe
 *    `error_description`): `signup_disabled` for someone with no account (they make one on the web first),
 *    `INVALID_TOKEN` for a link used or expired, a provider's own otherwise. The app takes only a `state` it made up.
 * 3. `POST /app/session { code, verifier }` → `{ token, cookie }`, within two minutes, once. `token` is the bearer
 *    token for /api/v1 (`Authorization: Bearer <token>`, with `Tuti-Project`); `cookie` is the `Cookie` header for
 *    /api/auth itself (`GET /get-session`, which also extends the session; `POST /sign-out`). Both go in the device's
 *    secure storage. Anything wrong (401 `INVALID_CODE`: the verifier isn't the challenge's, the code was used, is
 *    unknown or too old) ends the session behind the code: someone else has it. So the app posts a code once.
 *
 * What this doesn't stop: a sign-in another app on the phone starts itself, with its own verifier. For Google and
 * GitHub the person would be signing in from that app; for the emailed link they'd be tapping "Open the app" on a link
 * they didn't ask for.
 *
 * Signed in, the Inbox stays current while it's open through `GET /api/live` (not /api/auth; not in the API reference
 * yet), a Server-Sent Events stream with the same headers as /api/v1: `Authorization: Bearer <token>` and
 * `Tuti-Project: <slug>`, one stream per project. Refused as /api/v1 refuses (401 session, 400 project_required, 403
 * forbidden, 429 rate_limited; the stream's opening counts as one request). Its events:
 * - `ready`, once open and again after each reconnect: fetch everything shown, since changes until then were missed.
 * - `change` with `{ "conversation": <number> }`: that conversation changed (new, a message, its status or assignee, an
 *   email's delivery). Fetch it, its row and the views' counts; a number the list hasn't got is a new conversation.
 * - `change` with `{}`: anything may have changed (someone came online, the server's listener reconnected): fetch
 *   everything shown.
 * - comments (`: ping`) every 25 seconds. The stream ends (closes, no event) once the session ends or the teammate
 *   leaves the team; reopening it then is refused. On errors, reconnect after the `retry:` it sends (3 seconds) and,
 *   while it keeps failing, fetch every 10 seconds instead, as the web app does.
 */
export const APP_ORIGIN = "tuti://";

/** Whether an address is the app's, as Better Auth reads the scheme: in any case, with or without the slashes. */
export const isAppLink = (url: unknown): url is string => typeof url === "string" && /^tuti:/i.test(url);

/** What the app made up when it started a sign-in, which it gets back with the code: it takes no code it didn't ask for. */
const APP_SIGN_IN_STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** A verifier's SHA-256, base64url: what the app sends when it starts, and what `verifier` must hash to at the end. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const isChallenge = (challenge: unknown): challenge is string => typeof challenge === "string" && CHALLENGE.test(challenge);

/** How long a code works: the time for the app to come to the front and post it. */
const CODE_SECONDS = 120;

/** Where the `verification` rows are: an emailed link's state and challenge by its token, a code's session by the code, both hashed. */
const linkRow = (token: string) => `app-sign-in-link:${hashSecret(token)}`;
const codeRow = (code: string, used = false) => `app-sign-in-${used ? "used" : "code"}:${hashSecret(code)}`;

/** Keeps what the app asked an emailed link with, for as long as the link works (sendSignInLink, lib/auth.ts). */
export async function keepAppSignInLink(token: string, asked: { state: string; challenge: string }, expiresAt: Date) {
  await prisma.verification.create({ data: { id: randomUUID(), identifier: linkRow(token), value: JSON.stringify(asked), expiresAt } });
}

/** What the app asked an emailed link with, if the link can still be used (read only: the sign-in itself uses it up). */
export async function appSignInLink(token: string): Promise<{ state: string; challenge: string } | null> {
  const row = await prisma.verification.findFirst({ where: { identifier: linkRow(token), expiresAt: { gt: new Date() } }, select: { value: true } });
  return row && (JSON.parse(row.value) as { state: string; challenge: string });
}

/** Where an emailed link's "Open the app" sends the browser: the app, which checks `state`. */
export const appSignInReturn = (state: string) => `${APP_ORIGIN}sign-in?state=${state}`;

const refused = () => new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });

/** What the server keeps with a Google or GitHub sign-in the app started: in its state's server context, as `app`. */
type AppSignIn = { challenge: string; provider: unknown };
const appSignInOf = (state: unknown) => (state as { serverContext?: { app?: Partial<AppSignIn> } } | null)?.serverContext?.app;

/**
 * For `databaseHooks.user.create.before` (lib/auth.ts): the app has no sign-up, so a Google or GitHub sign-in it
 * started makes no account. Someone new goes back to the app with this error, to make their account on the web first.
 * Every other way an account is made, the web's Continue with Google and GitHub among them, is as it was.
 */
export async function noAccountFromApp() {
  // No sign-in under way (an account made outside a request): nothing to read.
  const state = await getOAuthState().catch(() => null);
  if (appSignInOf(state)) {
    throw new APIError("FORBIDDEN", { code: "signup_disabled", message: "There's no account for this address yet. Create one on the web first." });
  }
}

/** The session token a signed cookie's value holds (`<token>.<signature>`, percent-encoded). */
const sessionTokenOf = (signed: string) => decodeURIComponent(signed).split(".")[0]!;

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
    // Beside Better Auth's own limits: the app's two posts, per visitor.
    rateLimit: [{ pathMatcher: (path) => path === "/app/session" || path === "/app/sign-in-link", window: 60, max: 10 }],
    hooks: {
      before: [
        {
          // Continue with Google or GitHub starts here, for the web and the app; the web's start is left as it is.
          // The app's (any way back is the app's) comes back to the app, must come with a challenge, and tells the app
          // of an error where it tells it of the rest. What marks the sign-in as the app's is kept with its state,
          // where only the server writes (Better Auth's server context): its challenge, and its provider.
          matcher: (ctx) => ctx.path === "/sign-in/social",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown> & { additionalData?: { challenge?: unknown } };
            if (![body.callbackURL, body.newUserCallbackURL, body.errorCallbackURL].some(isAppLink)) {
              return;
            }
            const challenge = body.additionalData?.challenge;
            if (!isAppLink(body.callbackURL) || !isChallenge(challenge)) {
              throw new APIError("BAD_REQUEST", { code: "CHALLENGE_REQUIRED", message: "A sign-in from the app comes back to the app and has a challenge." });
            }
            // Nothing of the caller's goes into the provider's address: the browser's stop (below) makes it again from
            // what's kept, and sends the browser nowhere else.
            if (["scopes", "loginHint", "additionalParams", "idToken"].some((extra) => body[extra] !== undefined)) {
              throw new APIError("BAD_REQUEST", { message: "A sign-in from the app takes a provider, where to come back to and a challenge." });
            }
            await addOAuthServerContext({ app: { challenge, provider: body.provider } satisfies AppSignIn });
            return { context: { body: { ...body, errorCallbackURL: body.errorCallbackURL ?? body.callbackURL } } };
          }),
        },
      ],
      after: [
        {
          // A sign-in that ends with a redirect to the app (Google's or GitHub's way back, the emailed link's
          // "Open the app"). The session it made isn't the browser's, which had no say in whose sign-in it finished:
          // its cookies come out of the answer. Nor does it ride in the redirect, which any app that registered the
          // scheme may get: a code does, for the app that holds the verifier of this sign-in's challenge to exchange
          // (/app/session). No challenge kept (a sign-in the start above didn't mark as the app's): no session at all.
          matcher: (ctx) => !!ctx.path?.startsWith("/callback") || ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.context.responseHeaders;
            const location = headers?.get("location");
            if (!headers || !isAppLink(location) || !ctx.context.isTrustedOrigin(location)) {
              return;
            }
            const name = ctx.context.authCookies.sessionToken.name;
            const signed = parseSetCookieHeader(headers.get("set-cookie") ?? "").get(name)?.value;
            headers.delete("set-cookie");
            if (!signed) {
              // No session: an error on its way to the app.
              return;
            }
            const token = typeof ctx.query?.token === "string" ? ctx.query.token : "";
            const challenge = ctx.path === "/magic-link/verify" ? (await appSignInLink(token))?.challenge : appSignInOf(await getOAuthState())?.challenge;
            const now = Date.now();
            await prisma.verification.deleteMany({ where: { identifier: { startsWith: "app-sign-in-" }, expiresAt: { lt: new Date(now) } } });
            const to = new URL(location);
            if (!isChallenge(challenge)) {
              await ctx.context.internalAdapter.deleteSession(sessionTokenOf(signed));
              to.searchParams.set("error", "challenge_required");
            } else {
              const code = randomSecret();
              await prisma.verification.create({
                data: { id: randomUUID(), identifier: codeRow(code), value: JSON.stringify({ session: sessionTokenOf(signed), cookie: name, challenge }), expiresAt: new Date(now + CODE_SECONDS * 1000) },
              });
              to.searchParams.set("code", code);
            }
            ctx.setHeader("location", to.toString());
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
       * Only for a sign-in the app started: one with a challenge, whose every way back (an account's, a new account's,
       * an error's) is the app's, so it can only end at the app, with a code. Never one of the web's: any page could
       * send a visitor here with the state of its own sign-in, and have their browser finish it, signed in to the
       * page's account. And never an open redirect, not even within a provider's site (another page of it, another
       * app's consent there): the browser goes to the address this server makes again from the sign-in it kept, and
       * `authorizationURL`, the address the start gave the app, must be that address to the letter.
       */
      expoAuthorizationProxy: createAuthEndpoint("/expo-authorization-proxy", { method: "GET", query: z.object({ authorizationURL: z.string().max(4000) }) }, async (ctx) => {
        const { authorizationURL } = ctx.query;
        const state = URL.canParse(authorizationURL) ? new URL(authorizationURL).searchParams.get("state") : null;
        // As Better Auth keeps a sign-in's state (`auth-state:`), with everywhere it may go back to and what it was started with.
        const kept = state ? await ctx.context.internalAdapter.findVerificationValue(`auth-state:${state}`) : null;
        let started: { callbackURL?: unknown; newUserURL?: unknown; errorURL?: unknown; codeVerifier?: string; idTokenNonce?: string } = {};
        try {
          started = (kept && new Date(kept.expiresAt) > new Date() && (JSON.parse(kept.value) as typeof started)) || {};
        } catch {}
        const appOrNone = (back: unknown) => back === undefined || back === null || isAppLink(back);
        const app = appSignInOf(started);
        const provider = ctx.context.socialProviders.find((one) => one.id === app?.provider);
        if (!state || !provider || !isAppLink(started.callbackURL) || !appOrNone(started.newUserURL) || !appOrNone(started.errorURL) || !isChallenge(app?.challenge)) {
          throw refused();
        }
        // Where the browser goes is made here, from what was kept, as the start made it (Better Auth's /sign-in/social):
        // the address the caller gives only names the sign-in, and must be that one exactly.
        const onward = (
          await provider.createAuthorizationURL({ state, codeVerifier: started.codeVerifier!, idTokenNonce: started.idTokenNonce, redirectURI: `${ctx.context.baseURL}/callback/${provider.id}` })
        ).toString();
        if (onward !== authorizationURL) {
          throw refused();
        }
        // The cookie Better Auth's own start of a sign-in sets (`state`, signed), for five minutes.
        const cookie = ctx.context.createAuthCookie("state", { maxAge: 300 });
        await ctx.setSignedCookie(cookie.name, state, ctx.context.secret, cookie.attributes);
        throw ctx.redirect(onward);
      }),
      /**
       * POST /api/auth/app/sign-in-link `{ email, state, challenge }`: emails an account a link that signs the app in
       * (the page it opens: /app/auth/app-link). Under the limits of every emailed link (server/email-link-limits.ts),
       * and it answers the same whether or not the address has an account: one without gets nothing, as the app has no
       * sign-up.
       */
      appSignInLink: createAuthEndpoint(
        "/app/sign-in-link",
        {
          method: "POST",
          body: z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()), state: z.string().regex(APP_SIGN_IN_STATE), challenge: z.string().regex(CHALLENGE) }),
        },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers();
          if (!emailConfigured() || (await requestTarget(headers.get("host"))).kind !== "app") {
            throw new APIError("BAD_REQUEST", { message: "Sign-in links aren't available here." });
          }
          const { email, state, challenge } = ctx.body;
          // A verified account only. Opening the link verifies the address, and an unverified account's password may be
          // someone else's, who signed up with this address first: verifying would let them in (as onExistingUserSignUp
          // in lib/auth.ts never sends the verification link). Its owner verifies on the web first.
          const account = await prisma.user.findUnique({ where: { email }, select: { emailVerified: true } });
          const sends = !!account?.emailVerified;
          // Imported here: both import lib/auth.ts, which imports this file.
          const { countEmailedLink } = await import("@/server/email-link-limits");
          const limited = await countEmailedLink(null, email, headers, sends ? "address" : "nobody");
          if ("error" in limited) {
            throw new APIError("TOO_MANY_REQUESTS", { message: limited.error });
          }
          if (limited.id && sends) {
            try {
              const { auth } = await import("./auth");
              await auth.api.signInMagicLink({ body: { email, metadata: { linkId: limited.id, app: { state, challenge } } }, headers });
            } catch (error) {
              // Only an address with an account gets this far, so the answer stays the same.
              log.error("Sending the app's sign-in link failed", { error });
            }
          }
          return ctx.json({ status: true });
        },
      ),
      /**
       * POST /api/auth/app/session `{ code, verifier }`: the app's last step. The code from the redirect, with the
       * verifier whose challenge the sign-in was started with, for the session: `{ token, cookie }` (the contract above).
       * Once: the first post claims the code, right or wrong. A wrong verifier, a code used before or too old: refused,
       * and, while its record is kept (its two minutes), the session behind it is ended, since someone other than the app
       * that asked has the code. After that a code is refused and nothing else happens: an unclaimed code's session was
       * never handed to anyone, and a claimed one needs the verifier only the app that started the sign-in holds.
       */
      appSession: createAuthEndpoint("/app/session", { method: "POST", body: z.object({ code: z.string().max(200), verifier: z.string().max(200) }) }, async (ctx) => {
        const { code, verifier } = ctx.body;
        // Renaming the row claims it: of two posts at once, one has it.
        const [claimed] = await prisma.$queryRaw<{ value: string; expiresAt: Date }[]>`
          UPDATE verification SET identifier = ${codeRow(code, true)} WHERE identifier = ${codeRow(code)} RETURNING value, "expiresAt"`;
        const row = claimed ?? (await prisma.verification.findFirst({ where: { identifier: codeRow(code, true) }, select: { value: true } }));
        // The session's token as the session table has it (never its signed form, which is as good as the cookie), and its cookie's name.
        const kept = row && (JSON.parse(row.value) as { session: string; cookie: string; challenge: string });
        const proof = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
        const proven = !!kept && proof.length === kept.challenge.length && timingSafeEqual(proof, Buffer.from(kept.challenge));
        if (!kept || !claimed || claimed.expiresAt <= new Date() || !proven) {
          if (kept) {
            await ctx.context.internalAdapter.deleteSession(kept.session);
          }
          throw new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "This code doesn't work. Sign in again." });
        }
        // Signed as Better Auth signs the session's cookie: its value is what /api/v1 takes as the bearer token.
        const token = encodeURIComponent(`${kept.session}.${await makeSignature(kept.session, ctx.context.secret)}`);
        return ctx.json({ token, cookie: `${kept.cookie}=${token}` });
      }),
    },
  }) satisfies BetterAuthPlugin;
