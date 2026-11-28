import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { ApiError, authRequest, fetchUntil, TimedOut } from "./api";
import { hostOf } from "./server";
import { challengeOf, newState, newVerifier } from "./pkce";

/**
 * Signing in (apps/web/src/server/auth/app-sign-in.ts has the server's side): Google or GitHub in the system's browser sheet,
 * or the account's email and password in one call.
 *
 * Google and GitHub start with a new state and PKCE verifier, kept in secure storage (on Android the phone may close
 * the app while the browser is in front), and end at `tuti://sign-in?state=…&code=…` (or `…&error=…`): the sign-in
 * screen's route, so the router opens it with these as its params, beside the browser sheet's own result. Only the
 * latest sign-in's state is taken, and its code is exchanged once.
 */

export type SignedIn = { server: string; token: string; cookie: string };
type Pending = { server: string; state: string; verifier: string };
export type Params = Record<string, string | string[] | undefined>;

const RETURN = "tuti://sign-in";
const PENDING = "pending-sign-in";
export const STORE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function begin(server: string) {
  const pending: Pending = { server, state: newState(), verifier: newVerifier() };
  await SecureStore.setItemAsync(PENDING, JSON.stringify(pending), STORE_OPTIONS);
  return { state: pending.state, challenge: await challengeOf(pending.verifier) };
}

/**
 * Email and password: the session, or an Error in words. 401 is a wrong password or an unknown address alike; 403
 * `EMAIL_NOT_VERIFIED` comes with the verification email sent again; anything else (429, a 403 for a request that isn't
 * the app's) in the server's words.
 */
export async function signInWithPassword(server: string, email: string, password: string): Promise<SignedIn> {
  await checkServer(server);
  try {
    const { token, cookie } = await authRequest<{ token: string; cookie: string }>(server, "/app/sign-in/email", { body: { email, password } });
    return { server, token, cookie };
  } catch (error) {
    if (error instanceof ApiError && error.code === "INVALID_EMAIL_OR_PASSWORD") {
      // One answer for a wrong password and an address with no account, as the server gives.
      throw new Error("That email and password don't match. Try again, or reset your password.");
    }
    // A Tuti server from before the app's password sign-in (any other site's 404 keeps its own error: the wrong address).
    if (error instanceof ApiError && error.status === 404 && (await isTuti(server))) {
      throw new Error("This server doesn't take passwords from the app yet. Continue with Google or GitHub, or ask whoever runs it to update Tuti.");
    }
    if (error instanceof ApiError && error.code === "EMAIL_NOT_VERIFIED") {
      throw new Error("Your email address isn't verified yet. Tuti has sent you the verification email again: open its link, then sign in here.");
    }
    throw error;
  }
}

/** Said of a server too old for the app: one whose `conversations.reply` takes no `requestId` (#1070). */
export const OUTDATED_SERVER = "This server runs an older Tuti than the app needs. Ask whoever runs it to update Tuti, then sign in here.";
/** Said of a Tuti server whose spec couldn't be read just now (a 5xx, a broken answer): not signed in to unchecked. */
export const UNCHECKED_SERVER = "Couldn't check this server's version just now. Try again in a moment.";

/**
 * Before anything is sent (docs/plan.md, M10): the server's API spec, which every Tuti server serves with no session,
 * must have `conversations.reply` take a `requestId`, or a Retry after a lost answer could send a reply twice. No shim
 * for an older server (one whose spec lacks it, or that has none): it isn't signed in to. A Tuti server whose spec can't
 * be read just now isn't signed in to either, unchecked; a server that can't be reached, or another site, is left to the
 * sign-in's own request, and its error.
 */
export async function checkServer(server: string) {
  // Both its requests within one deadline: a connection that stalls (the spec's, or its `ok`'s) is a server that can't be
  // reached, said as the sign-in would, rather than a sign-in that waits forever.
  const timed = fetchUntil(Date.now() + CHECK_TIMEOUT_MS);
  let status = 0;
  let spec: unknown = null;
  try {
    // Not the cached one: it's served for five minutes, and a server just updated would be refused meanwhile.
    const response = await timed(`${server}/api/v1/openapi.json`, { credentials: "omit", cache: "no-store", headers: { accept: "application/json" } });
    status = response.status;
    spec = response.ok ? await response.json() : null;
  } catch (error) {
    if (error instanceof TimedOut) {
      throw unreachable(server);
    }
    spec = null;
  }
  const { openapi, paths } = (spec ?? {}) as { openapi?: unknown; paths?: unknown };
  const isSpec = typeof openapi === "string" && !!paths && typeof paths === "object";
  if (isSpec && replyTakesRequestId(spec as OpenApi)) {
    return;
  }
  // The rest is said only of a Tuti server: another site (one serving an API of its own there too) keeps the sign-in's
  // own error, the wrong address. Tuti's own spec says so (apps/web openapi.ts's title), whether or not its `ok` can be
  // reached (a proxy can block it); without one, `ok` tells.
  const tutiSpec = isSpec && (spec as { info?: { title?: unknown } }).info?.title === "Tuti API";
  // `ok` within the same deadline; a server it can't reach (or that stalls) is said so, as the sign-in would.
  const tuti =
    tutiSpec ||
    (await authRequest<{ ok?: unknown }>(server, "/ok", {}, timed).then(
      (answer) => answer?.ok === true,
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 0) {
          throw error;
        }
        return false;
      },
    ));
  if (!tuti) {
    return;
  }
  // A spec without it, or none at all (a server from before the spec): older. Anything else (a 5xx, a broken answer):
  // not read just now.
  throw new Error(isSpec || status === 404 ? OUTDATED_SERVER : UNCHECKED_SERVER);
}

type Schema = { $ref?: string; properties?: Record<string, unknown> };
type OpenApi = {
  paths: Record<string, Record<string, { operationId?: string; requestBody?: { content?: Record<string, { schema?: Schema }> } } | undefined>>;
  components?: { schemas?: Record<string, Schema> };
};

/** Whether the spec's `conversations.reply` takes `requestId` in its JSON body (inline, or a component it refers to). */
export function replyTakesRequestId(spec: OpenApi) {
  for (const operations of Object.values(spec.paths)) {
    for (const operation of Object.values(operations ?? {})) {
      if (operation?.operationId !== "conversations.reply") {
        continue;
      }
      let schema = operation.requestBody?.content?.["application/json"]?.schema;
      if (schema?.$ref?.startsWith("#/components/schemas/")) {
        schema = spec.components?.schemas?.[schema.$ref.slice("#/components/schemas/".length)];
      }
      return !!schema?.properties && "requestId" in schema.properties;
    }
  }
  return false;
}

/** Whether a Tuti server answers at the address: Better Auth's own `ok`. */
const isTuti = (server: string) => authRequest<{ ok?: unknown }>(server, "/ok").then((answer) => answer?.ok === true, () => false);

/** How long the check before signing in waits for the server, its requests together. */
export const CHECK_TIMEOUT_MS = 10_000;
/** What a request that couldn't reach the server says (api.ts `send`'s words). */
const unreachable = (server: string) => new ApiError(0, "unreachable", `Couldn't reach ${hostOf(server)}. Check the address and your connection.`);

/** Where "Forgot password?" goes: the web's own reset, in the system browser. */
export const forgotPasswordUrl = (server: string) => `${server}/app/auth/forgot-password`;

/** Google or GitHub in the system's browser sheet: signed in, or null if the teammate closed it. */
export async function continueWith(provider: "google" | "github", server: string): Promise<SignedIn | null> {
  await checkServer(server);
  const { state, challenge } = await begin(server);
  const { url } = await authRequest<{ url: string }>(server, "/sign-in/social", {
    body: { provider, callbackURL: `${RETURN}?state=${state}`, additionalData: { challenge } },
  });
  const result = await WebBrowser.openAuthSessionAsync(`${server}/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(url)}`, RETURN);
  return result.type === "success" ? finishSignIn(queryOf(result.url)) : null;
}

/**
 * Ways back already taken, by state. On Android one arrives twice (the browser sheet's result and the router's link):
 * the second gets the first's exchange while it runs, so both wait for the same session and the sign-in screen stays
 * busy until it's in; once it's settled, the same way back again does nothing.
 */
const taken = new Map<string, Promise<SignedIn | null> | null>();

/** The way back's params → the session, an Error in words, or null when there's nothing (new) to do. */
export function finishSignIn(params: Params): Promise<SignedIn | null> {
  const state = one(params.state);
  if (!state) {
    return Promise.resolve(null);
  }
  if (taken.has(state)) {
    return taken.get(state) ?? Promise.resolve(null);
  }
  const exchange = exchangeCode(params, state).finally(() => taken.set(state, null));
  taken.set(state, exchange);
  return exchange;
}

async function exchangeCode(params: Params, state: string): Promise<SignedIn | null> {
  const pending = JSON.parse((await SecureStore.getItemAsync(PENDING, STORE_OPTIONS)) ?? "null") as Pending | null;
  const result = readReturn(params, pending?.state);
  if (pending?.state === state) {
    await SecureStore.deleteItemAsync(PENDING, STORE_OPTIONS);
  }
  if ("error" in result) {
    throw new Error(result.error);
  }
  const { token, cookie } = await authRequest<{ token: string; cookie: string }>(pending!.server, "/app/session", { body: { code: result.code, verifier: pending!.verifier } });
  return { server: pending!.server, token, cookie };
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The way back, read: a code for the sign-in started here last, or why there's none, in words. */
export function readReturn(params: Params, expectedState: string | undefined): { code: string } | { error: string } {
  if (!expectedState || one(params.state) !== expectedState) {
    return { error: "That sign-in was started earlier. Try again." };
  }
  const error = one(params.error);
  if (error) {
    return { error: errorMessage(error, one(params.error_description)) };
  }
  const code = one(params.code);
  return code ? { code } : { error: "Signing in didn't finish. Try again." };
}

function errorMessage(code: string, description: string | undefined) {
  if (description) {
    return description;
  }
  switch (code) {
    case "signup_disabled":
      return "There's no Tuti account for that address yet. Create one on the web first, then sign in here.";
    case "access_denied":
      return "Signing in was cancelled.";
    default:
      return `Couldn't sign in (${code}). Try again.`;
  }
}

/** A link's query as params (React Native's URL can't). */
export function queryOf(url: string): Record<string, string> {
  const query = url.split("#")[0]!.split("?")[1] ?? "";
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const [key, value = ""] = pair.split("=");
    try {
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
      }
    } catch {
      // Not percent-encoded right: not ours.
    }
  }
  return params;
}

/**
 * Whether the sign-in screen is still finishing a way back it was opened with (`link`: its params as JSON): one with a
 * `state`, until the screen has settled that same link. Busy meanwhile, so no other sign-in starts and gets replaced.
 */
export const awaitingReturn = (link: string, settled: string | null) =>
  !!(JSON.parse(link) as Record<string, unknown>).state && settled !== link;
