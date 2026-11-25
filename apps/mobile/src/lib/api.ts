import { hostOf } from "./server";

/**
 * Talking to a Tuti server. `/api/v1` (the operations, docs at the server's /api/docs) takes the teammate's session
 * token and the project's slug; `/api/auth` (signing in and out) takes the session's cookie and the app's scheme in
 * place of an origin (apps/web/src/lib/app-sign-in.ts has the contract).
 */

/** What went wrong, in the server's words when it gives them: `{ error: { code, message } }` from /api/v1, `{ code, message }` from /api/auth. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
type Init = { method?: string; body?: unknown; headers?: Record<string, string> };

async function send<T>(url: string, { method = "GET", body, headers }: Init, fetchFn: Fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      // No cookie jar: a session goes only where the app puts it (the bearer token, or /api/auth's Cookie).
      credentials: "omit",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "unreachable", `Couldn't reach ${hostOf(url)}. Check the address and your connection.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    // Not JSON: not a Tuti server's answer (a Wi-Fi login page, a proxy, the wrong address). Never read as a `null`.
    throw new ApiError(response.status, "not_tuti", `${hostOf(url)} didn't answer like a Tuti server (${response.status}). Check the address and your connection.`);
  }
  if (!response.ok) {
    const body = json as { error?: { code?: string; message?: string }; code?: string; message?: string } | null;
    const error = body?.error ?? body;
    throw new ApiError(response.status, error?.code ?? `http_${response.status}`, error?.message || `${hostOf(url)} answered ${response.status}. Try again.`);
  }
  return json as T;
}

/** The app's scheme, standing in for the origin a page's request would have. */
const APP_ORIGIN = "tuti://";

/** `/api/auth<path>`: a POST with `body`, a GET without. */
export const authRequest = <T>(server: string, path: string, { body, cookie }: { body?: unknown; cookie?: string } = {}, fetchFn: Fetch = fetch) =>
  send<T>(`${server}/api/auth${path}`, { method: body === undefined ? "GET" : "POST", body, headers: { "expo-origin": APP_ORIGIN, ...(cookie ? { cookie } : {}) } }, fetchFn);

/** Calls `/api/v1<path>` as the signed-in teammate, in their chosen project. */
export type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** The API as the session's teammate. A 401 means the session is over (signed out elsewhere, expired): `onUnauthorized` signs out here too. */
export function createApi(session: { server: string; token: string; project?: string }, onUnauthorized: () => void, fetchFn: Fetch = fetch): Api {
  const headers = { authorization: `Bearer ${session.token}`, ...(session.project ? { "tuti-project": session.project } : {}) };
  return async (path, init = {}) => {
    try {
      return await send(`${session.server}/api/v1${path}`, { ...init, headers }, fetchFn);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();
      }
      throw error;
    }
  };
}

/** What a request given up on at its deadline (`fetchUntil`) fails with. */
export class TimedOut extends Error {
  constructor() {
    super("Timed out");
  }
}

/** A fetch whose requests all give up at one deadline (`deadlineAt`, a time in ms), answers' bodies included. */
export function fetchUntil(deadlineAt: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new TimedOut());
        },
        Math.max(0, deadlineAt - Date.now()),
      );
    });
    try {
      // The answer's body too: headers can come and the body never (the network gone in between).
      const response = await Promise.race([fetch(input, { ...init, signal: controller.signal }), deadline]);
      const body = await Promise.race([response.text(), deadline]);
      return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
    }
  };
}
