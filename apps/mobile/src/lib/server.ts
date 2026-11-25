/** Tuti's cloud: where the app signs in unless the teammate types their own server's address. */
export const CLOUD_SERVER = "https://tuti.so";

/**
 * A server's address as typed ("feedback.acme.com", "https://Feedback.acme.com/app/inbox/") → its origin
 * ("https://feedback.acme.com"), or null if it isn't one. https unless http is typed. Hand-parsed: React Native's URL
 * leaves out most of the standard.
 */
export function normalizeServer(typed: string): string | null {
  const match = /^(?:(https?):\/\/)?([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?(?:[/?#].*)?$/i.exec(typed.trim());
  if (!match) {
    return null;
  }
  const [, scheme = "https", host, port = ""] = match;
  if (!host!.startsWith("[") && (!/[a-z0-9]$/i.test(host!) || host!.split(".").some((label) => !label))) {
    return null;
  }
  return `${scheme.toLowerCase()}://${host!.toLowerCase()}${port}`;
}

/** What to show for a server: its host ("tuti.so", "feedback.acme.com:8443"). */
export const hostOf = (server: string) => server.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");

/**
 * Whether the app can sign in to a server at this address: https only, as a password goes to it, and store builds refuse
 * plain http anyway (iOS's App Transport Security, Android's cleartext rule). A development build also takes http to this
 * computer (`localhost`, `127.0.0.1`, `[::1]`), for a local server.
 */
export function reachable(server: string, development: boolean): boolean {
  if (server.startsWith("https://")) {
    return true;
  }
  return development && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(server);
}
