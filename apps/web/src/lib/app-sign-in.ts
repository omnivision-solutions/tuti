import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import type { BetterAuthPlugin } from "better-auth";
import { addOAuthServerContext, APIError, createAuthEndpoint, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { z } from "zod";

import { hashSecret, randomSecret } from "./portal-handoff";

/**
 * Signing in from Tuti's mobile app (docs/plan.md, Mobile app): Google, GitHub, or the account's email and password.
 * The app has no web view of its own for it: Google and GitHub finish in the device's browser, which then opens the app
 * through its link scheme. Only this scheme is trusted (lib/auth.ts), on the app's host only, on every server: a
 * self-hosted one needs no setting.
 *
 * A link scheme belongs to nobody: on Android another app can register it and receive the redirect. So the redirect
 * carries no session, only a code, and the code is worth nothing without a secret the app that started the sign-in
 * kept (PKCE, as RFC 8252 asks of native apps). A password goes over HTTPS straight to the server and the session comes
 * back in the answer, never through a redirect, so it needs none of that. The app signs in to an account that exists:
 * none is made from it.
 *
 * The contract, all under the server's /api/auth, JSON in and out. The app's requests come from no page: it sends its
 * scheme in an `expo-origin: tuti://` header (Better Auth's Expo client does), which stands in for an origin.
 *
 * Email and password, one call: `POST /app/sign-in/email { email, password }` → `{ token, cookie }`, as step 3 below
 * answers. It is the web's own password sign-in (Better Auth's /sign-in/email) and answers as it does: 401
 * `INVALID_EMAIL_OR_PASSWORD` for a wrong password and an address with no account (or no password) alike, 403
 * `EMAIL_NOT_VERIFIED` for an address not verified yet on a server that sends email (it emails the verification link,
 * as the web does), 429 under the web's limit (shared with the web's sign-in, per visitor). The answer sets no cookie.
 * "Forgot password?" opens `<server>/app/auth/forgot-password` in the device's browser: the web's reset, whose new
 * password the app then signs in with.
 *
 * Google or GitHub, before the sign-in the app makes up:
 * - `verifier`: 43 to 128 random characters of A-Z a-z 0-9 - . _ ~, kept on the device, never sent until step 3;
 * - `challenge`: the verifier's SHA-256, base64url without padding (43 characters);
 * - `state`: 16 to 128 random characters of A-Z a-z 0-9 - _.
 *
 * 1. `POST /sign-in/social { provider: "google" | "github", callbackURL: "tuti://sign-in?state=<state>",
 *    additionalData: { challenge } }` and nothing else → `{ url }`. The app opens the device's browser (an auth
 *    session) at `GET /expo-authorization-proxy?authorizationURL=<url>`, with `url` exactly as it came, which goes on
 *    to the provider.
 * 2. The browser is redirected to `tuti://sign-in?state=<state>&code=<code>`, or `…&error=<code>` (and maybe
 *    `error_description`): `signup_disabled` for someone with no account (they make one on the web first), a
 *    provider's own otherwise. The app takes only a `state` it made up.
 * 3. `POST /app/session { code, verifier }` → `{ token, cookie }`, within two minutes, once. `token` is the bearer
 *    token for /api/v1 (`Authorization: Bearer <token>`, with `Tuti-Project`); `cookie` is the `Cookie` header for
 *    /api/auth itself (`GET /get-session`, which also extends the session; `POST /sign-out`). Both go in the device's
 *    secure storage. Anything wrong (401 `INVALID_CODE`: the verifier isn't the challenge's, the code was used, is
 *    unknown or too old) ends the session behind the code: someone else has it. So the app posts a code once.
 *
 * What this doesn't stop: a Google or GitHub sign-in another app on the phone starts itself, with its own verifier: the
 * person would be signing in from that app.
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

/** A verifier's SHA-256, base64url: what the app sends when it starts, and what `verifier` must hash to at the end. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const isChallenge = (challenge: unknown): challenge is string => typeof challenge === "string" && CHALLENGE.test(challenge);

/** How long a code works: the time for the app to come to the front and post it. */
const CODE_SECONDS = 120;

/** Where the `verification` rows are: a code's session by the code, hashed. */
const codeRow = (code: string, used = false) => `app-sign-in-${used ? "used" : "code"}:${hashSecret(code)}`;

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

/**
 * What the app gets for a session (the contract above): its cookie's value, signed as Better Auth signs it, which /api/v1
 * takes as the bearer token, and the cookie itself, for /api/auth.
 */
async function handOver(ctx: { context: { secret: string }; json: (body: { token: string; cookie: string }) => unknown }, session: string, cookie: string) {
  const token = encodeURIComponent(`${session}.${await makeSignature(session, ctx.context.secret)}`);
  return ctx.json({ token, cookie: `${cookie}=${token}` });
}

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
    // Beside Better Auth's own limits: the code's exchange, per visitor. The password sign-in is limited where the web's
    // is (its own sign-in, which it goes through).
    rateLimit: [{ pathMatcher: (path) => path === "/app/session", window: 60, max: 10 }],
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
          // A sign-in that ends with a redirect to the app (Google's or GitHub's way back). The session it made isn't the browser's, which had no say in whose sign-in it finished:
          // its cookies come out of the answer. Nor does it ride in the redirect, which any app that registered the
          // scheme may get: a code does, for the app that holds the verifier of this sign-in's challenge to exchange
          // (/app/session). No challenge kept (a sign-in the start above didn't mark as the app's): no session at all.
          matcher: (ctx) => !!ctx.path?.startsWith("/callback"),
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
            const challenge = appSignInOf(await getOAuthState())?.challenge;
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
        return handOver(ctx, kept.session, kept.cookie);
      }),
      /**
       * POST /api/auth/app/sign-in/email `{ email, password }`: the app's password sign-in, for `{ token, cookie }` (the
       * contract above). It is the web's (Better Auth's /sign-in/email), asked of the server as a request of its own,
       * so that everything the web's goes through applies as it is: its limit, counted with the web's for the visitor
       * (the inner request carries their address), its answer for a wrong password, an unknown or an unverified
       * address, and no account made. Only that answer's session cookie is taken, and given as the app's session: the
       * answer sets no cookie.
       *
       * Only from the app: a page's request has an Origin, which onRequest above leaves, so a page can't get a token here.
       */
      appPasswordSignIn: createAuthEndpoint(
        "/app/sign-in/email",
        { method: "POST", body: z.object({ email: z.string().max(320), password: z.string().max(1000) }) },
        async (ctx) => {
          if (!ctx.request || ctx.headers?.get("origin") !== APP_ORIGIN) {
            throw new APIError("FORBIDDEN", { message: "This sign-in is the Tuti app's." });
          }
          const headers = new Headers(ctx.request.headers);
          // Signed in or not on this device, the answer is a new session: never a cookie of the caller's.
          headers.delete("cookie");
          headers.delete("content-length");
          headers.set("content-type", "application/json");
          const { email, password } = ctx.body;
          // Imported here, and its type named: lib/auth.ts imports this file.
          const { auth } = (await import("./auth")) as { auth: { handler: (request: Request) => Promise<Response> } };
          const answer = await auth.handler(
            new Request(new URL("/api/auth/sign-in/email", ctx.request.url), { method: "POST", headers, body: JSON.stringify({ email, password }) }),
          );
          const name = ctx.context.authCookies.sessionToken.name;
          const signed = parseSetCookieHeader(answer.headers.get("set-cookie") ?? "").get(name)?.value;
          if (!answer.ok) {
            // The web's refusal as it is, without its headers: the status, its body, and when to try again.
            const retry = answer.headers.get("x-retry-after");
            return new Response(await answer.text(), { status: answer.status, headers: { "content-type": "application/json", ...(retry && { "x-retry-after": retry }) } });
          }
          if (!signed) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Signing in failed. Try again." });
          }
          return handOver(ctx, sessionTokenOf(signed), name);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
