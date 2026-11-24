/** Tuti's cloud: where the app signs in unless the teammate types their own server's address. */
export const CLOUD_SERVER = "https://tuti.so";

/**
 * A server's address as typed ("feedback.acme.com", "https://Feedback.acme.com/app/inbox/") → its origin
 * ("https://feedback.acme.com"), or null if it isn't one. https unless http is typed (a server on the local network).
 * Hand-parsed: React Native's URL leaves out most of the standard.
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
