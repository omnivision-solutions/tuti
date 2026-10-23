import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type GithubFake = {
  /** Use as GITHUB_URL and GITHUB_API_URL. */
  url: string;
  /** Env vars for an App that uses this fake. */
  env: Record<string, string>;
  /** The GitHub user behind an OAuth `code`, the installations they can see, and the repositories of each they can access. */
  user(code: string, installations: FakeInstallation[]): void;
  /**
   * What the next install does, like GitHub: the install page sends the browser to
   * `setupUrl` with this installation; then the authorize page sends it to the
   * given `redirect_uri` with `code` (this user, who can see the installation) and the `state`.
   */
  nextInstall(setupUrl: string, installation: FakeInstallation & { code: string }): void;
  // Also `POST /_fake/next-install {forwardedFor, setupUrl, id, account, repositories, code}`: for one browser, from other processes.
  /**
   * A pull request the App can read with an installation token: the pull request, its commits, its
   * changed files (each file's `patch` is the diff; leave it out for one GitHub finds too big) and
   * their contents at its merge commit (`merge-<number>`). Also `POST /_fake/pull-request {repo, …}`,
   * from other processes.
   */
  pullRequest(repo: string, pr: FakePullRequest): void;
  /** Every path the App read with an installation token, in order. */
  reads: string[];
  /** A signed webhook delivery, as GitHub would send it. */
  webhook(event: string, payload: unknown): { body: string; headers: Record<string, string> };
  close(): Promise<void>;
};

export type FakePullRequest = {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  author?: string;
  mergedAt?: string;
  /** Commit messages, oldest first. */
  commits?: string[];
  files?: { filename: string; status?: string; additions?: number; deletions?: number; patch?: string; content?: string }[];
};

export type FakeInstallation = { id: number; account: string; type?: "Organization" | "User"; repositories?: { id: number; fullName: string }[] };

/** The App's webhook secret in the fake's `env`, for signing deliveries from other processes (journeys). */
export const FAKE_GITHUB_WEBHOOK_SECRET = "test-github-webhook-secret";
const WEBHOOK_SECRET = FAKE_GITHUB_WEBHOOK_SECRET;

/** A local stand-in for GitHub: OAuth code exchange, a user's installations, signed webhooks. */
export async function startGithubFake(): Promise<GithubFake> {
  const users = new Map<string, FakeInstallation[]>();
  const pulls = new Map<string, FakePullRequest>();
  const reads: string[] = [];
  let globalInstall: { setupUrl: string; id: number; code: string } | undefined;
  const installsFor = new Map<string, { setupUrl: string; id: number; code: string }>();
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
      const install = installsFor.get(String(req.headers["x-forwarded-for"] ?? "")) ?? globalInstall;
      // For journeys in other processes: what the next install by one browser (its
      // X-Forwarded-For, which each journey person has to itself) does (see nextInstall).
      if (req.method === "POST" && url.pathname === "/_fake/next-install") {
        const next = JSON.parse(raw || "{}") as FakeInstallation & { forwardedFor: string; setupUrl: string; code: string };
        users.set(next.code, [{ id: next.id, account: next.account, type: next.type, repositories: next.repositories }]);
        installsFor.set(next.forwardedFor, { setupUrl: next.setupUrl, id: next.id, code: next.code });
        return send(200, {});
      }
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const { code } = JSON.parse(raw || "{}") as { code?: string };
        return code && users.has(code) ? send(200, { access_token: `token-${code}` }) : send(200, { error: "bad_verification_code" });
      }
      const installationRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
      if (req.method === "GET" && (url.pathname === "/user/installations" || installationRepos)) {
        const code = /^Bearer token-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const installations = code ? users.get(code) : undefined;
        if (!installations) {
          return send(401, { message: "Bad credentials" });
        }
        const installation = installationRepos && installations.find((i) => i.id === Number(installationRepos[1]));
        if (installationRepos && !installation) {
          return send(404, { message: "Not Found" });
        }
        // Paged like GitHub, with a Link header to the next page.
        const items: unknown[] = installation
          ? (installation.repositories ?? []).map((repo) => ({ id: repo.id, full_name: repo.fullName }))
          : installations.map((i) => ({ id: i.id, account: { login: i.account, type: i.type ?? "Organization" } }));
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = items.slice((page - 1) * perPage, page * perPage);
        const next = page * perPage < items.length ? `${base}${url.pathname}?per_page=${perPage}&page=${page + 1}` : null;
        res.writeHead(200, { "content-type": "application/json", ...(next && { link: `<${next}>; rel="next"` }) });
        res.end(JSON.stringify(installation ? { total_count: items.length, repositories: slice } : { installations: slice }));
        return;
      }
      const redirect = (to: URL) => res.writeHead(302, { location: to.href }).end();
      const installationToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (req.method === "POST" && installationToken) {
        return validJwt(req.headers.authorization)
          ? send(201, { token: `installation-${installationToken[1]}` })
          : send(401, { message: "A JSON web token could not be decoded" });
      }
      const knownRepos = (installation?: number) =>
        [...users.values()]
          .flat()
          .filter((i) => installation === undefined || i.id === installation)
          .flatMap((i) => i.repositories ?? []);
      const tokenInstallation = /^Bearer installation-(\d+)$/.exec(req.headers.authorization ?? "")?.[1];
      // A repository by id: like a public repository on GitHub, any token can read it, whichever installation it's in.
      const repoById = /^\/repositories\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && repoById && tokenInstallation) {
        const repo = knownRepos().find((r) => r.id === Number(repoById[1]));
        return repo ? send(200, { id: repo.id, full_name: repo.fullName }) : send(404, { message: "Not Found" });
      }
      // The installation's own repositories, paged like GitHub.
      if (req.method === "GET" && url.pathname === "/installation/repositories" && tokenInstallation) {
        const items = [...new Map(knownRepos(Number(tokenInstallation)).map((r) => [r.id, { id: r.id, full_name: r.fullName }])).values()];
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const next = page * perPage < items.length ? `${base}${url.pathname}?per_page=${perPage}&page=${page + 1}` : null;
        res.writeHead(200, { "content-type": "application/json", ...(next && { link: `<${next}>; rel="next"` }) });
        res.end(JSON.stringify({ total_count: items.length, repositories: items.slice((page - 1) * perPage, page * perPage) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/_fake/pull-request") {
        const { repo, ...pr } = JSON.parse(raw || "{}") as FakePullRequest & { repo: string };
        pulls.set(`${repo}#${pr.number}`, pr);
        return send(200, {});
      }
      // A pull request, its commits and files (paged like GitHub), and a file's contents at its merge commit.
      const pullPath = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/commits|\/files)?$/.exec(url.pathname);
      const contentsPath = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && (pullPath || contentsPath)) {
        if (!tokenInstallation) {
          return send(401, { message: "Requires authentication" });
        }
        reads.push(url.pathname);
        if (contentsPath) {
          const number = /^merge-(\d+)$/.exec(url.searchParams.get("ref") ?? "")?.[1];
          const path = decodeURIComponent(contentsPath[2]!);
          const file = pulls.get(`${contentsPath[1]}#${number}`)?.files?.find((f) => f.filename === path && f.content !== undefined);
          return file
            ? send(200, { type: "file", encoding: "base64", content: Buffer.from(file.content!).toString("base64").replace(/.{60}/g, "$&\n") })
            : send(404, { message: "Not Found" });
        }
        const pr = pulls.get(`${pullPath![1]}#${pullPath![2]}`);
        if (!pr) {
          return send(404, { message: "Not Found" });
        }
        if (!pullPath![3]) {
          return send(200, {
            number: pr.number,
            title: pr.title,
            body: pr.body ?? null,
            user: { login: pr.author ?? "octocat" },
            merged_at: pr.mergedAt ?? "2026-10-01T12:00:00Z",
            merge_commit_sha: `merge-${pr.number}`,
            labels: (pr.labels ?? []).map((name) => ({ name })),
          });
        }
        const items: unknown[] =
          pullPath![3] === "/commits"
            ? (pr.commits ?? []).map((message, i) => ({ sha: `c${i}`, commit: { message } }))
            : (pr.files ?? []).map(({ filename, status = "modified", additions = 1, deletions = 0, patch }) => ({
                filename,
                status,
                additions,
                deletions,
                ...(patch !== undefined && { patch }),
              }));
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const next = page * perPage < items.length ? `${base}${url.pathname}?per_page=${perPage}&page=${page + 1}` : null;
        res.writeHead(200, { "content-type": "application/json", ...(next && { link: `<${next}>; rel="next"` }) });
        res.end(JSON.stringify(items.slice((page - 1) * perPage, page * perPage)));
        return;
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
    nextInstall(setupUrl, { id, account, type, repositories, code }) {
      users.set(code, [{ id, account, type, repositories }]);
      globalInstall = { setupUrl, id, code };
    },
    pullRequest: (repo, pr) => pulls.set(`${repo}#${pr.number}`, pr),
    reads,
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
