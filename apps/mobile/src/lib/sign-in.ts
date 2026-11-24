import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { authRequest } from "./api";
import { challengeOf, newState, newVerifier } from "./pkce";

/**
 * Signing in (apps/web/src/lib/app-sign-in.ts has the server's side). Every way starts with a new state and PKCE
 * verifier, kept in secure storage so an emailed link still works if the phone closed the app meanwhile, and ends at
 * `tuti://sign-in?state=…&code=…` (or `…&error=…`): the sign-in screen's route, so the router opens it with these as
 * its params. Only the latest sign-in's state is taken, and its code is exchanged once.
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

/** Emails a sign-in link, if the address has an account (the server says the same either way). */
export async function emailSignInLink(server: string, email: string) {
  const { state, challenge } = await begin(server);
  await authRequest(server, "/app/sign-in-link", { body: { email, state, challenge } });
}

/** Google or GitHub in the system's browser sheet: signed in, or null if the teammate closed it. */
export async function continueWith(provider: "google" | "github", server: string): Promise<SignedIn | null> {
  const { state, challenge } = await begin(server);
  const { url } = await authRequest<{ url: string }>(server, "/sign-in/social", {
    body: { provider, callbackURL: `${RETURN}?state=${state}`, additionalData: { challenge } },
  });
  const result = await WebBrowser.openAuthSessionAsync(`${server}/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(url)}`, RETURN);
  return result.type === "success" ? finishSignIn(queryOf(result.url)) : null;
}

/** States already taken: on Android the way back arrives twice (the browser sheet's result and the router's link). */
const taken = new Set<string>();

/** The way back's params → the session, an Error in words, or null when there's nothing (new) to do. */
export async function finishSignIn(params: Params): Promise<SignedIn | null> {
  const state = one(params.state);
  if (!state || taken.has(state)) {
    return null;
  }
  taken.add(state);
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
    return { error: "That link is from an earlier sign-in. Use the latest link you asked for, or ask for a new one." };
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
    case "INVALID_TOKEN":
    case "EXPIRED_TOKEN":
      return "That link has expired or was already used. Ask for a new one.";
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
