import * as SecureStore from "expo-secure-store";

import { authRequest } from "./api";
import { type SignedIn, STORE_OPTIONS } from "./sign-in";

/** The signed-in teammate's session: the server, its token for /api/v1, its cookie for /api/auth, and the project they chose. */
export type Session = SignedIn & { project?: string };

const KEY = "session";

/** The stored session; none if there's none, or it can't be read (signed out, rather than stuck on the splash screen). */
export const readSession = () =>
  SecureStore.getItemAsync(KEY, STORE_OPTIONS)
    .then((stored) => (stored ? (JSON.parse(stored) as Session) : null))
    .catch(() => null);

export const writeSession = (session: Session | null) =>
  session ? SecureStore.setItemAsync(KEY, JSON.stringify(session), STORE_OPTIONS) : SecureStore.deleteItemAsync(KEY, STORE_OPTIONS);

/**
 * Whether a restored session still holds. Reading it keeps it going (API calls don't). Only the server saying it ended
 * (`null`) is a no: offline, or a page that isn't the server's, keeps it.
 */
export const sessionHolds = (session: Session) =>
  authRequest<unknown>(session.server, "/get-session", { cookie: session.cookie }).then(
    (current) => current !== null,
    () => true,
  );

/** How often a session that stays open is read again: Better Auth extends a session read a day after it was last. */
export const RECHECK_MS = 12 * 60 * 60 * 1000;
/** Whether it's time to read the session again (on coming back to the foreground; a launch always reads it). */
export const dueForRecheck = (lastChecked: number, now: number) => now - lastChecked >= RECHECK_MS;

/**
 * Signs out: forgets the session here and ends it on the server. `only`: only if it's still that session (a check or a
 * 401 that answers late, about a session someone has since signed out of and back in after, leaves the new one alone).
 */
export async function forgetSession(only?: Session) {
  const stored = await readSession();
  if (only && stored?.token !== only.token) {
    return;
  }
  await writeSession(null);
  if (stored) {
    await authRequest(stored.server, "/sign-out", { body: {}, cookie: stored.cookie }).catch(() => {});
  }
}

/**
 * The session in use once `ended` is found to have ended (a check or a 401, which can answer late): none if it was
 * `ended`, else unchanged, so someone who signed out and back in meanwhile stays signed in.
 */
export const afterEnded = <T extends { token: string }>(now: T | null | undefined, ended: { token: string }) =>
  now?.token === ended.token ? null : now;

/** Whether coming back to the foreground reads the session again: signed in, and RECHECK_MS since it was last read. */
export const recheckOnForeground = (state: string, signedIn: boolean, lastChecked: number, now: number) =>
  state === "active" && signedIn && dueForRecheck(lastChecked, now);

/**
 * Saves a session, then shows it: only once it's stored, so a failed write (a keystore invalidated by a backup restore)
 * rejects with nothing shown as signed in or chosen, and the caller's error path says so.
 */
export async function keepSession<T>(next: T, show: (next: T) => void, write: (next: T) => Promise<unknown>) {
  await write(next);
  show(next);
}

/** The session in use once a change to `next` is saved (the project chosen): only if it's still that session in use. */
export const afterChanged = <T extends { token: string }>(now: T | null | undefined, next: T) => (now?.token === next.token ? next : now);
