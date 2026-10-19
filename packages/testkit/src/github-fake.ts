import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type GithubFake = {
  /** Use as GITHUB_URL and GITHUB_API_URL. */
  url: string;
  /** Env vars for an App that uses this fake. */
  env: Record<string, string>;
  /** The GitHub user behind an OAuth `code`, and the installations they can see. */
  user(code: string, installations: { id: number; account: string }[]): void;
  /**
   * What the next install does, like GitHub: the install page sends the browser to
   * `setupUrl` with this installation; then the authorize page sends it to the
   * given `redirect_uri` with `code` (this user, who can see the installation) and the `state`.
   */
  nextInstall(setupUrl: string, installation: { id: number; account: string; code: string }): void;
  /**
   * A repository's data for the App's API (installation tokens required):
   * releases, commits between two tags (`"v1...v2"`), and pull requests.
   */
  repo(
    fullName: string,
    data: {
      releases?: { tag_name: string; draft?: boolean; published_at: string }[];
      compare?: Record<string, string[]>;
      pulls?: Record<number, { merged_at: string | null; merge_commit_sha: string | null }>;
    },
  ): void;
  /** A signed webhook delivery, as GitHub would send it. */
  webhook(event: string, payload: unknown): { body: string; headers: Record<string, string> };
  close(): Promise<void>;
};

const WEBHOOK_SECRET = "test-github-webhook-secret";

/** A local stand-in for GitHub: OAuth code exchange, a user's installations, signed webhooks. */
export async function startGithubFake(): Promise<GithubFake> {
  const users = new Map<string, { id: number; account: string }[]>();
  let install: { setupUrl: string; id: number; code: string } | undefined;
  const repos = new Map<string, Parameters<GithubFake["repo"]>[1]>();
  // The App's key pair: the app signs JWTs with the private key, the fake checks them.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const APP_ID = "4242";
  const validJwt = (header: string | undefined) => {
    const jwt = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    const [head, payload, signature] = jwt?.split(".") ?? [];
    if (!head || !payload || !signature) {
      return false;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; exp?: number };
    const signed = createVerify("RSA-SHA256").update(`${head}.${payload}`).verify(publicKey, signature, "base64url");
    return signed && claims.iss === APP_ID && (claims.exp ?? 0) * 1000 > Date.now();
  };
  let base = "";

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const send = (status: number, body: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(req.url ?? "/", "http://fake");
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const { code } = JSON.parse(raw || "{}") as { code?: string };
        return code && users.has(code) ? send(200, { access_token: `token-${code}` }) : send(200, { error: "bad_verification_code" });
      }
      if (req.method === "GET" && url.pathname === "/user/installations") {
        const code = /^Bearer token-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const installations = code ? users.get(code) : undefined;
        if (!installations) {
          return send(401, { message: "Bad credentials" });
        }
        // Paged like GitHub, with a Link header to the next page.
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = installations.slice((page - 1) * perPage, page * perPage);
        const next = page * perPage < installations.length ? `${base}/user/installations?per_page=${perPage}&page=${page + 1}` : null;
        res.writeHead(200, { "content-type": "application/json", ...(next && { link: `<${next}>; rel="next"` }) });
        res.end(JSON.stringify({ installations: slice.map((i) => ({ id: i.id, account: { login: i.account } })) }));
        return;
      }
      const redirect = (to: URL) => res.writeHead(302, { location: to.href }).end();
      const installationToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (req.method === "POST" && installationToken) {
        return validJwt(req.headers.authorization)
          ? send(201, { token: `installation-${installationToken[1]}` })
          : send(401, { message: "A JSON web token could not be decoded" });
      }
      const repoPath = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && repoPath) {
        if (!/^Bearer installation-\d+$/.test(req.headers.authorization ?? "")) {
          return send(401, { message: "Bad credentials" });
        }
        const data = repos.get(repoPath[1]!);
        const rest = decodeURIComponent(repoPath[2]!);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const paged = (items: unknown[], wrap: (slice: unknown[]) => unknown) => {
          const next = page * perPage < items.length;
          const link = new URL(`${base}${url.pathname}`);
          link.search = new URLSearchParams({ per_page: String(perPage), page: String(page + 1) }).toString();
          res.writeHead(200, { "content-type": "application/json", ...(next && { link: `<${link.href}>; rel="next"` }) });
          res.end(JSON.stringify(wrap(items.slice((page - 1) * perPage, page * perPage))));
        };
        if (rest === "releases") {
          return paged(data?.releases ?? [], (slice) => slice);
        }
        if (rest.startsWith("compare/") && data?.compare?.[rest.slice("compare/".length)]) {
          return paged(data.compare[rest.slice("compare/".length)]!, (slice) => ({ commits: slice.map((sha) => ({ sha })) }));
        }
        const pull = /^pulls\/(\d+)$/.exec(rest);
        if (pull && data?.pulls?.[Number(pull[1])]) {
          return send(200, data.pulls[Number(pull[1])]);
        }
        return send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && /^\/apps\/[^/]+\/installations\/new$/.test(url.pathname) && install) {
        const back = new URL(install.setupUrl);
        back.search = new URLSearchParams({ installation_id: String(install.id), setup_action: "install" }).toString();
        return redirect(back);
      }
      if (req.method === "GET" && url.pathname === "/login/oauth/authorize" && install) {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.search = new URLSearchParams({ code: install.code, state: url.searchParams.get("state") ?? "" }).toString();
        return redirect(back);
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = url;

  return {
    url,
    env: {
      GITHUB_APP_SLUG: "tuti-test",
      GITHUB_APP_CLIENT_ID: "test-client-id",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_URL: url,
      GITHUB_API_URL: url,
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    user: (code, installations) => users.set(code, installations),
    repo: (fullName, data) => repos.set(fullName, data),
    nextInstall(setupUrl, { id, account, code }) {
      users.set(code, [{ id, account }]);
      install = { setupUrl, id, code };
    },
    webhook(event, payload) {
      const body = JSON.stringify(payload);
      return {
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
        },
      };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
