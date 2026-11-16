import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** The API key tests sign AppSumo's webhooks with (APPSUMO_API_KEY). */
export const FAKE_APPSUMO_API_KEY = "appsumo-test-key";

/**
 * AppSumo's sign-in (OAuth) for licenses, as the app uses it: `POST /openid/token/` trades a code given out by `code(key)`
 * (single-use, for this client and redirect URI) for an access token, and `GET /openid/license_key/?access_token=…`
 * gives that token's license key. `env`: APPSUMO_URL, APPSUMO_CLIENT_ID, APPSUMO_CLIENT_SECRET and APPSUMO_API_KEY for
 * an app using it. `requests`: each token request's form, in order. Journeys (other processes) get a code with
 * `POST /_fake/code?key=…`.
 */
export type AppsumoFake = {
  url: string;
  env: Record<string, string>;
  /** A fresh code for license `key`, as AppSumo puts in the redirect URL. */
  code: (key: string) => string;
  requests: Record<string, string>[];
  close: () => Promise<void>;
};

export async function startAppsumoFake(): Promise<AppsumoFake> {
  const codes = new Map<string, string>();
  const tokens = new Map<string, string>();
  const requests: Record<string, string>[] = [];
  const clientId = "appsumo-test-client";
  const clientSecret = "appsumo-test-secret";
  let url = "";
  const server = createServer(async (req, res) => {
    const address = new URL(req.url!, "http://fake");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && address.pathname === "/openid/token/") {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
      }
      const form = req.headers["content-type"]?.includes("json") ? (JSON.parse(text) as Record<string, string>) : Object.fromEntries(new URLSearchParams(text));
      requests.push(form);
      const key = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      if (!key || form.client_id !== clientId || form.client_secret !== clientSecret || form.grant_type !== "authorization_code" || !form.redirect_uri) {
        return send(403, { error: "invalid_grant" });
      }
      const token = randomUUID().replaceAll("-", "");
      tokens.set(token, key);
      return send(200, { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: randomUUID(), id_token: "fake" });
    }
    if (req.method === "POST" && address.pathname === "/_fake/code") {
      const code = randomUUID().replaceAll("-", "");
      codes.set(code, address.searchParams.get("key") ?? "");
      return send(200, { code });
    }
    if (req.method === "GET" && address.pathname === "/openid/license_key/") {
      const key = tokens.get(address.searchParams.get("access_token") ?? "");
      return key ? send(200, { license_key: key, status: "active", scopes: ["read_license"] }) : send(401, { error: "invalid_token" });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url,
    env: { APPSUMO_URL: url, APPSUMO_CLIENT_ID: clientId, APPSUMO_CLIENT_SECRET: clientSecret, APPSUMO_API_KEY: FAKE_APPSUMO_API_KEY },
    code: (key) => {
      const code = randomUUID().replaceAll("-", "");
      codes.set(code, key);
      return code;
    },
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * One of AppSumo's webhook calls: its body (JSON) and headers, signed with `key` as AppSumo signs them (HMAC-SHA256 of the
 * timestamp then the body, hex) at `at` (ms).
 */
export function appsumoWebhook(payload: Record<string, unknown>, { key = FAKE_APPSUMO_API_KEY, at = Date.now() } = {}): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ event_timestamp: at, created_at: Math.floor(at / 1000), test: false, ...payload });
  const timestamp = String(Math.floor(at / 1000));
  return {
    body,
    headers: { "content-type": "application/json", "x-appsumo-timestamp": timestamp, "x-appsumo-signature": createHmac("sha256", key).update(timestamp + body).digest("hex") },
  };
}
