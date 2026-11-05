import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A Google account signing in to Tuti with Google; `verified` (default true) is the ID token's `email_verified`. */
export type FakeGoogleSignIn = { sub: string; email: string; name: string; verified?: boolean };

export type GoogleFake = {
  url: string;
  /** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_URL for an app that signs in with this fake. */
  env: Record<string, string>;
  close(): Promise<void>;
};

/**
 * A local stand-in for Google's OAuth: `POST /_fake/next-sign-in {forwardedFor, sub, email, name, verified}` says who
 * that browser (its X-Forwarded-For) is when it next continues with Google; the authorize page sends it back with a
 * code, and the token endpoint answers that code with an ID token for them (unsigned: the app takes it from the token
 * endpoint, as it does Google's, and doesn't check signatures).
 */
export async function startGoogleFake(): Promise<GoogleFake> {
  const next = new Map<string, FakeGoogleSignIn>();
  const codes = new Map<string, FakeGoogleSignIn>();
  const CLIENT_ID = "test-google-client";

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(req.url ?? "/", "http://fake");
      if (req.method === "POST" && url.pathname === "/_fake/next-sign-in") {
        const { forwardedFor, ...person } = JSON.parse(raw) as FakeGoogleSignIn & { forwardedFor: string };
        next.set(forwardedFor, person);
        return send(200, {});
      }
      const forwardedFor = String(req.headers["x-forwarded-for"] ?? "");
      const person = next.get(forwardedFor);
      if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth" && person && url.searchParams.get("client_id") === CLIENT_ID) {
        next.delete(forwardedFor);
        const code = randomUUID();
        codes.set(code, person);
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return res.writeHead(302, { location: back.href }).end();
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const code = new URLSearchParams(raw).get("code") ?? "";
        const signedIn = codes.get(code);
        codes.delete(code);
        if (!signedIn) {
          return send(400, { error: "invalid_grant" });
        }
        const claims = {
          iss: "https://accounts.google.com",
          aud: CLIENT_ID,
          sub: signedIn.sub,
          email: signedIn.email,
          email_verified: signedIn.verified ?? true,
          name: signedIn.name,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
        const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        return send(200, {
          access_token: `google-${code}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`,
        });
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-google-secret", GOOGLE_URL: url },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
