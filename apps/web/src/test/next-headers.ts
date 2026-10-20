/**
 * Stand-in for next/headers in database tests (mocked in vitest.db-setup.ts):
 * the "request" carries the cookie of whoever actAs() signed in (and a user agent or host, if a test sets one).
 */
export const request = { cookie: "", userAgent: "", host: "" };

export async function headers() {
  return new Headers({
    ...(request.cookie && { cookie: request.cookie }),
    ...(request.userAgent && { "user-agent": request.userAgent }),
    ...(request.host && { host: request.host }),
  });
}

/** Reads the same cookies as `headers()` (writes are ignored: route handlers set cookies on their responses). */
export async function cookies() {
  const all = request.cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1) }));
  return {
    get: (name: string) => all.find((cookie) => cookie.name === name),
    getAll: () => all,
    has: (name: string) => all.some((cookie) => cookie.name === name),
    set: () => {},
    delete: () => {},
  };
}
