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

/** Signing out: the stored session is forgotten, then ended on the server (signed out here either way). */
export async function forgetSession() {
  const stored = await readSession();
  await writeSession(null);
  if (stored) {
    await authRequest(stored.server, "/sign-out", { body: {}, cookie: stored.cookie }).catch(() => {});
  }
}
