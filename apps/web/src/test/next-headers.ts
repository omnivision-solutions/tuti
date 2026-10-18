/**
 * Stand-in for next/headers in database tests (mocked in vitest.db-setup.ts):
 * the "request" carries the cookie of whoever actAs() signed in.
 */
export const request = { cookie: "" };

export async function headers() {
  return new Headers(request.cookie ? { cookie: request.cookie } : {});
}

export async function cookies() {
  return { get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} };
}
