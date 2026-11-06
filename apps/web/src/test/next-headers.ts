/**
 * Stand-in for next/headers in database tests (mocked in vitest.db-setup.ts):
 * the "request" carries the cookie of whoever actAs() signed in (and a user agent, host or other headers, if a test sets them).
 * `outside`: there's no request (a timer's work, as instrumentation.ts's), and these throw as Next.js's do.
 */
export const request = { cookie: "", userAgent: "", host: "", headers: {} as Record<string, string>, outside: false };

/** What Next.js throws for next/headers called outside a request (throwForMissingRequestStore). */
const outsideRequest = (expression: string) => new Error(`\`${expression}\` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context`);

export async function headers() {
  if (request.outside) {
    throw outsideRequest("headers");
  }
  return new Headers({
    ...request.headers,
    ...(request.cookie && { cookie: request.cookie }),
    ...(request.userAgent && { "user-agent": request.userAgent }),
    ...(request.host && { host: request.host }),
  });
}

/** Reads the same cookies as `headers()` (writes are ignored: route handlers set cookies on their responses). */
export async function cookies() {
  if (request.outside) {
    throw outsideRequest("cookies");
  }
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
