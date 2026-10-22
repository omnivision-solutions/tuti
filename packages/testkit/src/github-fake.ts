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
   * A repository's data for the App's API (installation tokens required): its
   * history (commit shas, oldest first; tags name commits in it), releases and
   * pull requests. Compare answers like GitHub for a linear history.
   */
  repo(
    fullName: string,
    data: {
      history?: string[];
      tags?: Record<string, string>;
      releases?: { tag_name: string; draft?: boolean; published_at: string }[];
      pulls?: Record<number, { merged_at: string | null; merge_commit_sha: string | null }>;
      /** Each pull request's commit messages, oldest first. */
      commits?: Record<number, string[]>;
      /** The App may only read (writes answer 403, like an App without write permission). */
      readOnly?: boolean;
    },
  ): void;
  /** Comments on a repo's issue or pull request (`byApp`: written by the App, through its installation token). */
  comments(fullName: string, number: number): { id: number; body: string; byApp: boolean }[];
  /** Someone else's comment, as if a person wrote it. */
  comment(fullName: string, number: number, body: string): void;
  /** Deletes a pull request's comments, as someone on GitHub might. */
  deleteComments(fullName: string, number: number): void;
  /** A signed webhook delivery, as GitHub would send it. */
  webhook(event: string, payload: unknown): { body: string; headers: Record<string, string> };
  close(): Promise<void>;
};

export type FakeInstallation = { id: number; account: string; repositories?: { id: number; fullName: string }[] };

/** The App's webhook secret in the fake's `env`, for signing deliveries from other processes (journeys). */
export const FAKE_GITHUB_WEBHOOK_SECRET = "test-github-webhook-secret";
const WEBHOOK_SECRET = FAKE_GITHUB_WEBHOOK_SECRET;

/** A local stand-in for GitHub: OAuth code exchange, a user's installations, signed webhooks. */
export async function startGithubFake(): Promise<GithubFake> {
  const users = new Map<string, FakeInstallation[]>();
  let globalInstall: { setupUrl: string; id: number; code: string } | undefined;
  const installsFor = new Map<string, { setupUrl: string; id: number; code: string }>();
  const repos = new Map<string, Parameters<GithubFake["repo"]>[1]>();
  const issueComments = new Map<string, { id: number; body: string; byApp: boolean }[]>();
  let nextCommentId = 1;
  const commentsOn = (fullName: string, number: number) => {
    const key = `${fullName}#${number}`;
    if (!issueComments.has(key)) {
      issueComments.set(key, []);
    }
    return issueComments.get(key)!;
  };
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
        users.set(next.code, [{ id: next.id, account: next.account, repositories: next.repositories }]);
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
          : installations.map((i) => ({ id: i.id, account: { login: i.account } }));
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
      const repoPath = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
      if (repoPath && req.method !== "GET") {
        if (!/^Bearer installation-\d+$/.test(req.headers.authorization ?? "")) {
          return send(401, { message: "Bad credentials" });
        }
        if (repos.get(repoPath[1]!)?.readOnly) {
          return send(403, { message: "Resource not accessible by integration" });
        }
        const { body } = JSON.parse(raw || "{}") as { body?: string };
        const create = /^issues\/(\d+)\/comments$/.exec(repoPath[2]!);
        if (req.method === "POST" && create && body) {
          const comment = { id: nextCommentId++, body, byApp: true };
          commentsOn(repoPath[1]!, Number(create[1])).push(comment);
          return send(201, { id: comment.id, body });
        }
        const edit = /^issues\/comments\/(\d+)$/.exec(repoPath[2]!);
        const existing = edit && [...issueComments.values()].flat().find((c) => c.id === Number(edit[1]));
        if (req.method === "PATCH" && existing && body) {
          if (!existing.byApp) {
            return send(403, { message: "Resource not accessible by integration" });
          }
          existing.body = body;
          return send(200, { id: existing.id, body });
        }
        return send(404, { message: "Not Found" });
      }
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
        const compare = /^compare\/(.+)\.\.\.(.+)$/.exec(rest);
        if (compare && data?.history) {
          const at = (ref: string) => data.history!.indexOf(data.tags?.[ref] ?? ref);
          const [baseAt, headAt] = [at(compare[1]!), at(compare[2]!)];
          if (baseAt < 0 || headAt < 0) {
            return send(404, { message: "Not Found" });
          }
          const status = headAt === baseAt ? "identical" : headAt > baseAt ? "ahead" : "behind";
          return send(200, { status, ahead_by: Math.max(0, headAt - baseAt), behind_by: Math.max(0, baseAt - headAt) });
        }
        const pullCommits = /^pulls\/(\d+)\/commits$/.exec(rest);
        if (pullCommits) {
          const messages = data?.commits?.[Number(pullCommits[1])] ?? [];
          return paged(
            messages.map((message, i) => ({ sha: `commit-${pullCommits[1]}-${i}`, commit: { message } })),
            (slice) => slice,
          );
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
    comments: (fullName, number) => commentsOn(fullName, number).map((c) => ({ ...c })),
    comment: (fullName, number, body) => void commentsOn(fullName, number).push({ id: nextCommentId++, body, byApp: false }),
    deleteComments: (fullName, number) => void commentsOn(fullName, number).splice(0),
    nextInstall(setupUrl, { id, account, repositories, code }) {
      users.set(code, [{ id, account, repositories }]);
      globalInstall = { setupUrl, id, code };
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
