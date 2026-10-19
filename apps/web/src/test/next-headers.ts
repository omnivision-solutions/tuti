/**
 * Stand-in for next/headers in database tests (mocked in vitest.db-setup.ts):
 * the "request" carries the cookie of whoever actAs() signed in.
 */
export const request = { cookie: "" };

export async function headers() {
  return new Headers(request.cookie ? { cookie: request.cookie } : {});
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
