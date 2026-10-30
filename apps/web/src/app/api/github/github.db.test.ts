import { type Prisma, prisma } from "@tuti/db";
import { listedRepositories, syncRepositories } from "@tuti/jobs";
import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { signValue, verifyValue } from "@/lib/github";
import { actAs, addMember, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";
import { publishChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { disconnectGithub, refreshGithubRepositories, setGithubRepository } from "@/server/github";
import { accountsFromCookie } from "@/server/github-connect";

import GithubIntegrationPage from "@/app/app/[project]/settings/(admin)/integrations/github/page";

import { GET as callback } from "./callback/route";
import { GET as install } from "./install/route";
import { GET as setup } from "./setup/route";
import { GET as pickAccount } from "./use/route";
import { POST as webhook } from "./webhook/route";

let github: GithubFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

const APP = "http://tuti.localhost:3100";
const location = (response: Response) => response.headers.get("location") ?? "";

const stateOf = (response: Response) => new URL(location(response)).searchParams.get("state")!;
/** A cookie the response sets, as `name=value` with its value decoded (as Next reads it). */
const cookieOf = (response: Response, name: string) => {
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0]!)
    .find((header) => header.startsWith(`${name}=`))!;
  return `${name}=${decodeURIComponent(cookie.slice(name.length + 1))}`;
};

/**
 * The connect flow for an account that has the App already, as the browser goes through it:
 * Connect GitHub → GitHub's authorize page → our callback (`code`: whoever authorizes on GitHub)
 * lists their accounts → they pick `installationId` → GitHub's authorize page again → our
 * callback connects it. Returns where it ends.
 */
async function connect(projectSlug: string, installationId: number, code: string) {
  const started = await install(new Request(`${APP}/api/github/install?project=${projectSlug}`));
  if (!location(started).startsWith(`${github.url}/login/oauth/authorize`)) {
    return location(started);
  }
  const listed = await callback(new Request(`${APP}/api/github/callback?code=${code}&state=${encodeURIComponent(stateOf(started))}`));
  if (!location(listed).endsWith("github=choose")) {
    return location(listed);
  }
  const session = request.cookie;
  request.cookie = `${session}; ${cookieOf(listed, "tuti_github_accounts")}`;
  const picked = await pickAccount(new Request(`${APP}/api/github/use?project=${projectSlug}&installation=${installationId}`));
  request.cookie = session;
  if (!location(picked).startsWith(`${github.url}/login/oauth/authorize`)) {
    return location(picked);
  }
  return location(await callback(new Request(`${APP}/api/github/callback?code=${code}&state=${encodeURIComponent(stateOf(picked))}`)));
}

/**
 * A first install: "Install on another account" → GitHub's install page → our Setup URL
 * (`installation_id`) → GitHub's authorize page → our callback.
 */
async function installAndConnect(projectSlug: string, installationId: number, code: string) {
  const started = await install(new Request(`${APP}/api/github/install?project=${projectSlug}&new=1`));
  if (!location(started).startsWith(github.url)) {
    return location(started);
  }
  const session = request.cookie;
  request.cookie = `${session}; ${cookieOf(started, "tuti_github_install")}`;
  const authorize = await setup(new Request(`${APP}/api/github/setup?installation_id=${installationId}&setup_action=install`));
  request.cookie = session;
  if (!location(authorize).startsWith(`${github.url}/login/oauth/authorize`)) {
    return location(authorize);
  }
  return location(await callback(new Request(`${APP}/api/github/callback?code=${code}&state=${encodeURIComponent(stateOf(authorize))}`)));
}

const connected = (projectId: string) => prisma.githubInstallation.findUnique({ where: { projectId } });

describe("connecting", () => {
  test("Connect GitHub offers the accounts the person has the app on; without any, it's on to installing it", async () => {
    github.user("code-0", []);
    const started = await install(new Request(`${APP}/api/github/install?project=${project.slug}`));
    const listed = await callback(new Request(`${APP}/api/github/callback?code=code-0&state=${encodeURIComponent(stateOf(started))}`));
    expect(location(listed)).toBe(`${github.url}/apps/tuti-test/installations/new`);
    // The project is remembered for the Setup URL GitHub comes back to.
    expect(cookieOf(started, "tuti_github_install")).toBeTruthy();

    github.user("code-0", [{ id: 520, account: "acme" }, { id: 521, account: "olive", type: "User" }]);
    const again = await install(new Request(`${APP}/api/github/install?project=${project.slug}`));
    const offered = await callback(new Request(`${APP}/api/github/callback?code=code-0&state=${encodeURIComponent(stateOf(again))}`));
    expect(location(offered)).toBe(`${APP}/app/${project.slug}/settings/integrations?github=choose`);
    expect(accountsFromCookie(cookieOf(offered, "tuti_github_accounts").slice("tuti_github_accounts=".length), project.id)).toEqual([
      { id: 520, account: { login: "acme", type: "Organization" } },
      { id: 521, account: { login: "olive", type: "User" } },
    ]);
    expect(await connected(project.id)).toBeNull();
    // Only an offered account can be picked, and only for this project.
    request.cookie = `${request.cookie}; ${cookieOf(offered, "tuti_github_accounts")}`;
    expect(location(await pickAccount(new Request(`${APP}/api/github/use?project=${project.slug}&installation=999`)))).toMatch(/github=expired$/);
    const other = await createProject(owner);
    expect(location(await pickAccount(new Request(`${APP}/api/github/use?project=${other.slug}&installation=520`)))).toMatch(/github=expired$/);
  });

  test("a first install comes back through the Setup URL and connects", async () => {
    github.user("code-new", [{ id: 530, account: "acme" }]);
    expect(await installAndConnect(project.slug, 530, "code-new")).toMatch(/github=connected$/);
    expect(await connected(project.id)).toMatchObject({ installationId: 530, accountLogin: "acme", accountType: "Organization" });
  });

  test("the person who installs can see the installation: the project is connected", async () => {
    github.user("code-1", [{ id: 501, account: "acme" }]);
    expect(await connect(project.slug, 501, "code-1")).toBe(`${APP}/app/${project.slug}/settings/integrations/github?github=connected`);
    expect(await connected(project.id)).toMatchObject({ installationId: 501, accountLogin: "acme" });
  });

  test("Switch account offers the accounts on the GitHub page, and connects the one picked", async () => {
    github.user("code-sw", [{ id: 540, account: "acme" }, { id: 541, account: "acme-labs" }]);
    await connect(project.slug, 540, "code-sw");
    const started = await install(new Request(`${APP}/api/github/install?project=${project.slug}`));
    const offered = await callback(new Request(`${APP}/api/github/callback?code=code-sw&state=${encodeURIComponent(stateOf(started))}`));
    expect(location(offered)).toBe(`${APP}/app/${project.slug}/settings/integrations/github?github=choose`);
    expect(await connect(project.slug, 541, "code-sw")).toMatch(/github=connected$/);
    expect(await connected(project.id)).toMatchObject({ installationId: 541, accountLogin: "acme-labs" });
  });

  test("the installation may be on any page of the person's installations", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: 10_000 + i, account: `org-${i}` }));
    github.user("code-many", many);
    expect(await installAndConnect(project.slug, 10_249, "code-many")).toMatch(/github=connected$/);
  });

  test("someone else's installation can't be claimed", async () => {
    github.user("code-2", [{ id: 777, account: "mine" }]); // can see 777, not 501
    // GitHub's Setup URL only says which installation, and anyone can type one there.
    expect(await installAndConnect(project.slug, 501, "code-2")).toMatch(/github=unconfirmed$/);
    expect(await installAndConnect(project.slug, 501, "made-up")).toMatch(/github=unconfirmed$/);
    // Nor can it be picked when it wasn't offered.
    expect(await connect(project.slug, 501, "code-2")).toMatch(/github=expired$/);
    expect(await connected(project.id)).toBeNull();
  });

  test("only owners and admins start it, and the state and cookie must be ours and fresh", async () => {
    github.user("code-3", [{ id: 502, account: "acme" }]);
    actAs(await addMember(project.id, "MEMBER"));
    expect(await connect(project.slug, 502, "code-3")).toBe(`${APP}/app?github=expired`);
    actAs(owner);
    // No install cookie (e.g. arriving from GitHub's settings): nothing to connect.
    expect(location(await setup(new Request(`${APP}/api/github/setup?installation_id=502`)))).toBe(`${APP}/app?github=expired`);
    // Forged, expired or other-purpose states.
    for (const state of [
      `${project.id}.502.9999999999.forged`,
      signValue("callback", [project.id, "502"], Date.now() - 60 * 60 * 1000),
      signValue("install", [project.id, "502"]),
    ]) {
      const response = await callback(new Request(`${APP}/api/github/callback?code=code-3&state=${encodeURIComponent(state)}`));
      expect(location(response)).toBe(`${APP}/app?github=expired`);
    }
    expect(await connected(project.id)).toBeNull();
  });

  test("signed values are tamper-proof and single-purpose", () => {
    const value = signValue("install", ["project-1"]);
    expect(verifyValue("install", value)).toEqual(["project-1"]);
    expect(verifyValue("callback", value)).toBeNull();
    expect(verifyValue("install", value.replace("project-1", "project-2"))).toBeNull();
    expect(verifyValue("install", "nonsense")).toBeNull();
    // As many characters as a real signature, but more bytes: refused, not a crash.
    const [fields, expires] = [value.split(".")[0], value.split(".")[1]];
    expect(verifyValue("install", `${fields}.${expires}.${"é".repeat(43)}`)).toBeNull();
  });
});

describe("repositories", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request(`${APP}/api/github/webhook`, { method: "POST", body, headers }))).status;
  const web = { id: 7011, fullName: "acme/web" };
  const mobile = { id: 7012, fullName: "acme/mobile" };
  const included = async (projectId: string) =>
    (await prisma.githubRepository.findMany({ where: { connection: { projectId } }, orderBy: { repoId: "asc" }, select: { fullName: true } })).map(
      (repo) => repo.fullName,
    );
  /** A merged pull request: it goes into the changelog draft of the project that has the repository. */
  const pullRequest = (installation: number, repo: { id: number; fullName: string }, number: number) =>
    github.webhook("pull_request", {
      action: "closed",
      installation: { id: installation },
      repository: { id: repo.id, full_name: repo.fullName },
      pull_request: { number, title: `PR ${number}`, body: "", html_url: `https://github.com/${repo.fullName}/pull/${number}`, merged: true },
    });
  const drafted = async (projectId: string) =>
    (await prisma.changelogEntryPullRequest.findMany({ where: { entry: { projectId } }, orderBy: { createdAt: "asc" }, select: { url: true } })).map(
      (pr) => pr.url,
    );
  const add = (slug: string, repo: { id: number }) => setGithubRepository(slug, repo.id, true);

  test("a project starts with no repositories, and adds the ones that belong to it", async () => {
    github.user("code-r1", [{ id: 701, account: "acme", repositories: [web, mobile] }]);
    expect(await connect(project.slug, 701, "code-r1")).toMatch(/github=connected$/);
    expect(await included(project.id)).toEqual([]);
    expect(await connected(project.id)).toMatchObject({ repositories: [web, mobile] });
    expect(await add(project.slug, web)).toEqual({});
    expect(await included(project.id)).toEqual(["acme/web"]);
  });

  test("an account with thousands of repositories lists them all", async () => {
    const many = Array.from({ length: 2_050 }, (_, i) => ({ id: 900_000 + i, fullName: `acme/repo-${i}` }));
    github.user("code-r9", [{ id: 714, account: "acme", repositories: many }]);
    await connect(project.slug, 714, "code-r9");
    expect(listedRepositories((await connected(project.id))!.repositories)).toHaveLength(2_050);
  });

  test("several projects share an account: each repository feeds the one project that has it", async () => {
    github.user("code-r2", [{ id: 702, account: "acme", repositories: [web, mobile] }]);
    await connect(project.slug, 702, "code-r2");
    const other = await createProject(owner);
    expect(await connect(other.slug, 702, "code-r2")).toMatch(/github=connected$/);
    await add(project.slug, web);
    await add(project.slug, mobile);
    expect(await add(other.slug, mobile)).toEqual({ error: "acme/mobile is in another project" });

    // The first lets mobile go; the other takes it.
    expect(await setGithubRepository(project.slug, mobile.id, false)).toEqual({});
    expect(await add(other.slug, mobile)).toEqual({});
    expect(await included(project.id)).toEqual(["acme/web"]);
    expect(await included(other.id)).toEqual(["acme/mobile"]);

    // Each merged pull request goes to the project that has its repository.
    expect(await deliver(pullRequest(702, web, 5))).toBe(200);
    expect(await deliver(pullRequest(702, mobile, 6))).toBe(200);
    expect(await drafted(project.id)).toEqual(["https://github.com/acme/web/pull/5"]);
    expect(await drafted(other.id)).toEqual(["https://github.com/acme/mobile/pull/6"]);

    // Disconnecting lets its repositories go.
    expect(await disconnectGithub(project.slug)).toEqual({});
    expect(await add(other.slug, web)).toEqual({});
    expect(await included(other.id)).toEqual(["acme/web", "acme/mobile"]);
  });

  test("the list is what the app can see on the account; Refresh list reads it again, without a trip to GitHub", async () => {
    github.user("code-r3", [{ id: 703, account: "acme", repositories: [web] }]);
    await connect(project.slug, 703, "code-r3");
    expect(await add(project.slug, mobile)).toEqual({
      error: "Refresh the list: that repository isn't one this project can include",
    });
    expect(await setGithubRepository(project.slug, Number.NaN, true)).toEqual({ error: "Unknown repository" });
    // The app gets access to another repository on GitHub.
    github.user("code-r3", [{ id: 703, account: "acme", repositories: [web, mobile] }]);
    expect(await refreshGithubRepositories(project.slug)).toEqual({ count: 2 });
    expect(await connected(project.id)).toMatchObject({ repositories: [web, mobile] });
    expect(await add(project.slug, mobile)).toEqual({});
    expect(await included(project.id)).toEqual(["acme/mobile"]);
    // GitHub not answering changes nothing.
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "not a key");
    expect(await refreshGithubRepositories(project.slug)).toEqual({ error: "GitHub didn't answer. Try again in a moment." });
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.env.GITHUB_APP_PRIVATE_KEY!);
    expect(await included(project.id)).toEqual(["acme/mobile"]);
  });

  test("repositories no project has are ignored, even added on GitHub; removed ones leave their project", async () => {
    const api = { id: 7014, fullName: "acme/api" };
    const onGithub = (repositories: { id: number; fullName: string }[]) => github.user("code-r4", [{ id: 704, account: "acme", repositories }]);
    onGithub([web, api]);
    await connect(project.slug, 704, "code-r4");
    await add(project.slug, web);

    // Not added: its pull requests don't reach the project.
    await deliver(pullRequest(704, mobile, 1));
    expect(await drafted(project.id)).toEqual([]);
    expect(
      await deliver(github.webhook("installation_repositories", { action: "added", installation: { id: 704 }, repositories_added: [{ id: mobile.id, full_name: mobile.fullName }] })),
    ).toBe(200);
    expect(await included(project.id)).toEqual(["acme/web"]);

    // Removed on GitHub.
    await add(project.slug, api);
    const removal = github.webhook("installation_repositories", { action: "removed", installation: { id: 704 }, repositories_removed: [{ id: api.id, full_name: api.fullName }] });
    // A removal arriving late, after it was added back: GitHub still has it there, so it stays.
    expect(await deliver(removal)).toBe(200);
    expect(await included(project.id)).toEqual(["acme/web", "acme/api"]);
    // GitHub can't say: not acknowledged, so it can be redelivered.
    onGithub([web]);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "not a key");
    expect(await deliver(removal)).toBe(503);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.env.GITHUB_APP_PRIVATE_KEY!);
    expect(await included(project.id)).toEqual(["acme/web", "acme/api"]);
    expect(await deliver(removal)).toBe(200);
    expect(await included(project.id)).toEqual(["acme/web"]);
    // Nor listed, so it can't be added again until a refresh lists it.
    expect(await connected(project.id)).toMatchObject({ repositories: [web] });
    expect(await add(project.slug, api)).toEqual({ error: "Refresh the list: that repository isn't one this project can include" });
  });

  test("switching to another account clears the list, even if GitHub can't list the new one yet", async () => {
    github.user("code-r12", [{ id: 730, account: "acme", repositories: [web] }]);
    await connect(project.slug, 730, "code-r12");
    github.user("code-r12b", [{ id: 731, account: "elsewhere", repositories: [mobile] }]);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "not a key");
    expect(await connect(project.slug, 731, "code-r12b")).toMatch(/github=connected$/);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.env.GITHUB_APP_PRIVATE_KEY!);
    expect(await connected(project.id)).toMatchObject({ installationId: 731, repositories: [] });
    expect(await add(project.slug, web)).toEqual({ error: "Refresh the list: that repository isn't one this project can include" });
  });

  test("a list GitHub didn't give in full (over 10,000) changes nothing", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => ({ id: 800_000 + i, fullName: `acme/many-${i}` }));
    github.user("code-r13", [{ id: 732, account: "acme", repositories: [web] }]);
    await connect(project.slug, 732, "code-r13");
    await add(project.slug, web);
    github.user("code-r13", [{ id: 732, account: "acme", repositories: [...many, web] }]);
    expect(await refreshGithubRepositories(project.slug)).toEqual({ error: "GitHub didn't answer. Try again in a moment." });
    expect(await included(project.id)).toEqual(["acme/web"]);
    expect(await connected(project.id)).toMatchObject({ repositories: [web] });
  });

  test("a list that changed while GitHub was paging through it changes nothing", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: 810_000 + i, fullName: `acme/paged-${i}` }));
    github.user("code-r15", [{ id: 735, account: "acme", repositories: [web, ...many] }]);
    await connect(project.slug, 735, "code-r15");
    await add(project.slug, web);
    // A repository goes from GitHub between the first and second page: the second says one fewer.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/installation/repositories") || !url.includes("page=2")) {
        return response;
      }
      const page = (await response.json()) as { total_count: number };
      return Response.json({ ...page, total_count: page.total_count - 1 }, { headers: response.headers });
    });
    expect(await refreshGithubRepositories(project.slug)).toEqual({ error: "GitHub didn't answer. Try again in a moment." });
    vi.mocked(globalThis.fetch).mockRestore();
    expect(await included(project.id)).toEqual(["acme/web"]);
  });

  test("a repository missed by one read of the list isn't removed: a second read has to agree", async () => {
    github.user("code-r16", [{ id: 736, account: "acme", repositories: [web, mobile] }]);
    await connect(project.slug, 736, "code-r16");
    await add(project.slug, web);
    // The first read skips acme/web (it moved between pages while others came and went); the second has it.
    const realFetch = globalThis.fetch;
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/installation/repositories") || reads++ > 0) {
        return response;
      }
      const page = (await response.json()) as { total_count: number; repositories: { id: number }[] };
      return Response.json({ ...page, repositories: page.repositories.map((repo) => (repo.id === web.id ? { id: 7099, full_name: "acme/new" } : repo)) });
    });
    expect(await refreshGithubRepositories(project.slug)).toEqual({ error: "GitHub didn't answer. Try again in a moment." });
    vi.mocked(globalThis.fetch).mockRestore();
    expect(await included(project.id)).toEqual(["acme/web"]);
    expect(await connected(project.id)).toMatchObject({ repositories: [web, mobile] });
  });

  test("a repository added while a refresh runs stays", async () => {
    const docs = { id: 7015, fullName: "acme/docs" };
    github.user("code-r17", [{ id: 737, account: "acme", repositories: [web, mobile, docs] }]);
    await connect(project.slug, 737, "code-r17");
    await add(project.slug, web);
    // GitHub drops acme/web and acme/docs; while the refresh confirms acme/web is gone, someone adds acme/docs (still on the page's old list).
    github.user("code-r17", [{ id: 737, account: "acme", repositories: [mobile] }]);
    const realFetch = globalThis.fetch;
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/installation/repositories") && ++reads === 2) {
        expect(await add(project.slug, docs)).toEqual({});
      }
      return realFetch(input, init);
    });
    expect(await refreshGithubRepositories(project.slug)).toEqual({ count: 1 });
    vi.mocked(globalThis.fetch).mockRestore();
    expect(await included(project.id)).toEqual(["acme/docs"]);
  });

  test("a list read for an account the project has since left isn't saved", async () => {
    github.user("code-r14", [{ id: 733, account: "acme", repositories: [web] }]);
    await connect(project.slug, 733, "code-r14");
    const connection = (await connected(project.id))!;
    github.user("code-r14b", [{ id: 734, account: "elsewhere", repositories: [mobile] }]);
    await connect(project.slug, 734, "code-r14b");
    await add(project.slug, mobile);
    // A refresh that read account 733 lands after the switch.
    await expect(syncRepositories(connection.id, 733)).rejects.toThrow();
    expect(await connected(project.id)).toMatchObject({ installationId: 734, repositories: [mobile] });
    expect(await included(project.id)).toEqual(["acme/mobile"]);
  });

  test("a refresh drops repositories GitHub no longer has (a removal it didn't tell us of)", async () => {
    github.user("code-r11", [{ id: 722, account: "acme", repositories: [web, mobile] }]);
    await connect(project.slug, 722, "code-r11");
    await add(project.slug, web);
    await add(project.slug, mobile);
    // Removed on GitHub, and no webhook arrived.
    github.user("code-r11", [{ id: 722, account: "acme", repositories: [web] }]);
    expect(await refreshGithubRepositories(project.slug)).toEqual({ count: 1 });
    expect(await included(project.id)).toEqual(["acme/web"]);
    expect(await connected(project.id)).toMatchObject({ repositories: [web] });
  });

  test("a renamed repository keeps its project; one moved to another account is added there once GitHub says it's there", async () => {
    github.user("code-r6", [{ id: 706, account: "acme", repositories: [web] }]);
    await connect(project.slug, 706, "code-r6");
    await add(project.slug, web);
    await deliver(pullRequest(706, { id: web.id, fullName: "acme/website" }, 1));
    expect(await included(project.id)).toEqual(["acme/website"]);
    const renamed = ["https://github.com/acme/website/pull/1"];
    expect(await drafted(project.id)).toEqual(renamed);

    // Transferred to another organisation, connected to another project: its events don't reach
    // either until that project adds it.
    const moved = { id: web.id, fullName: "elsewhere/website" };
    const other = await createProject(owner);
    github.user("code-r6", [{ id: 706, account: "acme", repositories: [] }]);
    github.user("code-r6b", [{ id: 707, account: "elsewhere", repositories: [moved] }]);
    await connect(other.slug, 707, "code-r6b");
    await deliver(pullRequest(707, moved, 2));
    expect(await drafted(project.id)).toEqual(renamed);
    expect(await drafted(other.id)).toEqual([]);

    // Taking it over fails halfway: it stays where it was, for a retry.
    type Run = (tx: Prisma.TransactionClient) => Promise<unknown>;
    const transaction = prisma.$transaction.bind(prisma) as unknown as (fn: Run) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: Run) =>
      transaction(async (tx) => {
        vi.spyOn(tx.githubRepository, "createMany").mockRejectedValueOnce(new Error("database down"));
        return fn(tx);
      })) as never);
    await expect(add(other.slug, web)).rejects.toThrow("database down");
    expect(await included(project.id)).toEqual(["acme/website"]);
    // GitHub can't say where it is: nothing moves, and the switch says so.
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "not a key");
    expect(await add(other.slug, web)).toEqual({ error: "GitHub couldn't say where elsewhere/website is now. Try again in a moment." });
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.env.GITHUB_APP_PRIVATE_KEY!);
    expect(await add(other.slug, web)).toEqual({});
    expect(await included(project.id)).toEqual([]);
    expect(await included(other.id)).toEqual(["elsewhere/website"]);
    // Events from the old account no longer reach anyone.
    await deliver(pullRequest(706, web, 3));
    expect(await drafted(project.id)).toEqual(renamed);
    expect(await drafted(other.id)).toEqual([]);
  });

  test("a repository GitHub doesn't say is in the account isn't taken from the project that has it", async () => {
    github.user("code-r8", [{ id: 711, account: "acme", repositories: [mobile] }]);
    await connect(project.slug, 711, "code-r8");
    await add(project.slug, mobile);
    // Listed for another account's project (an old list, say), but GitHub has it in the first.
    const other = await createProject(owner);
    github.user("code-r8b", [{ id: 712, account: "elsewhere", repositories: [mobile] }]);
    await connect(other.slug, 712, "code-r8b");
    github.user("code-r8b", [{ id: 712, account: "elsewhere", repositories: [] }]);
    expect(await add(other.slug, mobile)).toEqual({ error: "acme/mobile is in another project" });
    expect(await included(project.id)).toEqual(["acme/mobile"]);
  });
});

describe("webhook", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;

  test("only signed deliveries are read; uninstalling disconnects the project", async () => {
    await prisma.githubInstallation.create({
      data: { projectId: project.id, installationId: 600, accountLogin: "acme", createdById: owner.id },
    });
    const uninstall = github.webhook("installation", { action: "deleted", installation: { id: 600 } });

    expect(await deliver({ ...uninstall, headers: { ...uninstall.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` } })).toBe(401);
    expect(await deliver({ body: uninstall.body, headers: { "x-github-event": "installation" } })).toBe(401);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(1);

    expect(await deliver(github.webhook("ping", { zen: "Keep it simple." }))).toBe(200);
    expect(await deliver(uninstall)).toBe(200);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("GitHub's settings page: only when connected, and still there (to disconnect) once the server's App is gone", async () => {
    const page = () => GithubIntegrationPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never);
    expect(await redirectTarget(page())).toBe(`/app/${project.slug}/settings/integrations`);
    await prisma.githubInstallation.create({ data: { projectId: project.id, installationId: 610, accountLogin: "acme", createdById: owner.id } });
    expect(await page()).toBeTruthy();
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    expect(await page()).toBeTruthy();
  });

  test("without the App fully configured, the endpoints don't exist", async () => {
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", ""); // everything else is set
    expect(await deliver(github.webhook("ping", {}))).toBe(404);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.env.GITHUB_APP_PRIVATE_KEY!);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect(await deliver(github.webhook("ping", {}))).toBe(404);
    for (const route of [install, setup, callback]) {
      expect((await route(new Request(`${APP}/api/github/x`))).status).toBe(404);
    }
  });
});

describe("merged pull requests and releases", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;
  let installationId = 5000;
  let repo: string;
  const pullRequest = (
    action: string,
    number: number,
    title: string,
    { merged = false, labels = [] as string[], installation = installationId, body = "" } = {},
  ) =>
    github.webhook("pull_request", {
      action,
      installation: { id: installation },
      repository: { id: installation, full_name: repo },
      pull_request: {
        number,
        title,
        body,
        html_url: `https://github.com/${repo}/pull/${number}`,
        merged,
        labels: labels.map((name) => ({ name })),
      },
    });
  const merged = (number: number, title: string, labels: string[] = []) => pullRequest("closed", number, title, { merged: true, labels });
  const published = (tag: string, publishedAt: string) =>
    github.webhook("release", {
      action: "published",
      installation: { id: installationId },
      repository: { id: installationId, full_name: repo },
      release: { tag_name: tag, name: `Release ${tag}`, html_url: `https://github.com/${repo}/releases/tag/${tag}`, published_at: publishedAt },
    });
  const drafts = async () =>
    prisma.changelogEntry.findMany({
      where: { projectId: project.id },
      orderBy: { number: "asc" },
      select: { number: true, title: true, body: true, collecting: true, publishedAt: true },
    });

  beforeEach(async () => {
    installationId++;
    repo = `acme/app-${installationId}`;
    await prisma.githubInstallation.create({
      data: {
        projectId: project.id,
        installationId,
        accountLogin: "acme",
        createdById: owner.id,
        included: { create: { repoId: installationId, fullName: repo } },
      },
    });
  });

  test("only merged pull requests reach the project; opened, edited and closed without merging change nothing", async () => {
    for (const action of ["opened", "reopened", "edited", "synchronize"]) {
      expect(await deliver(pullRequest(action, 30, "Dark mode"))).toBe(200);
    }
    expect(await deliver(pullRequest("closed", 30, "Dark mode"))).toBe(200);
    // Another installation's repository with the same name isn't this project's.
    expect(await deliver(pullRequest("closed", 31, "Search", { merged: true, installation: 99_999 }))).toBe(200);
    expect(await drafts()).toEqual([]);
  });

  test("mentioning a post neither links it nor changes its status, opened or merged", async () => {
    const post = await prisma.post.create({
      data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode", body: "", status: "PLANNED" },
    });
    const body = `Fixes tuti#1 and http://${project.slug}.localhost:3100/feedback/feature-requests/dark-mode-1`;
    expect(await deliver(pullRequest("opened", 32, "Dark mode", { body }))).toBe(200);
    expect(await deliver(pullRequest("closed", 32, "Dark mode", { body, merged: true }))).toBe(200);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { status: true, links: true } })).toEqual({ status: "PLANNED", links: [] });
  });

  test("if a merged pull request can't be handled, GitHub isn't told it was (so it can be redelivered)", async () => {
    vi.spyOn(prisma.githubRepository, "findUnique").mockRejectedValueOnce(new Error("database down"));
    expect(await deliver(merged(46, "Dark mode"))).toBe(503);
    expect(await drafts()).toEqual([]);
    expect(await deliver(merged(46, "Dark mode"))).toBe(200); // redelivered
    expect(await drafts()).toEqual([expect.objectContaining({ body: `Dark mode (${repo}#46)` })]);
  });

  describe("the changelog's running draft", () => {
    test("merged pull requests gather in one draft, once each; internal work stays out; a release closes it", async () => {
      await deliver(merged(40, "Dark mode"));
      await deliver(merged(40, "Dark mode")); // redelivered
      await deliver(merged(41, "Bump eslint", ["deps"]));
      await deliver(merged(42, "Faster search"));
      expect(await drafts()).toEqual([
        {
          number: 1,
          title: "Next release",
          body: `Dark mode (${repo}#40)\nFaster search (${repo}#42)`,
          collecting: true,
          publishedAt: null,
        },
      ]);
      const content = (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).content as {
        content: { type: string; content: unknown[] }[];
      };
      expect(content.content).toEqual([expect.objectContaining({ type: "bulletList", content: [expect.anything(), expect.anything()] })]);

      // The release names and closes it; the next merge starts a new one, and a late redelivery of #40 goes nowhere.
      await deliver(published("v2.0", "2026-06-01T00:00:00Z"));
      await deliver(merged(43, "Exports"));
      await deliver(merged(40, "Dark mode"));
      expect((await drafts()).map(({ number, title, collecting, body }) => ({ number, title, collecting, body }))).toEqual([
        { number: 1, title: "Release v2.0", collecting: false, body: `Dark mode (${repo}#40)\nFaster search (${repo}#42)` },
        { number: 2, title: "Next release", collecting: true, body: `Exports (${repo}#43)` },
      ]);
    });

    test("merges arriving at once still make one draft with all of them", async () => {
      await Promise.all([60, 61, 62, 63].map((n) => deliver(merged(n, `PR ${n}`))));
      const all = await drafts();
      expect(all).toHaveLength(1);
      expect(all[0]!.body.split("\n").sort()).toEqual([60, 61, 62, 63].map((n) => `PR ${n} (${repo}#${n})`));
    });

    test("merges and releases arriving together: each PR lands once, at most one draft collects, one release names it", async () => {
      await deliver(merged(70, "First"));
      await Promise.all([
        deliver(published("v5.0", "2026-08-01T00:00:00Z")),
        deliver(published("v5.1", "2026-08-02T00:00:00Z")),
        deliver(merged(71, "Second")),
        deliver(merged(72, "Third")),
      ]);
      const all = await drafts();
      expect(all.filter((d) => d.collecting).length).toBeLessThanOrEqual(1);
      expect(["Release v5.0", "Release v5.1"]).toContain(all[0]!.title);
      const lines = all.flatMap((d) => d.body.split("\n")).filter(Boolean).sort();
      expect(lines).toEqual([`First (${repo}#70)`, `Second (${repo}#71)`, `Third (${repo}#72)`]);
    });

    test("a draft the team renamed keeps its name; one published by hand stops collecting", async () => {
      await deliver(merged(50, "Dark mode"));
      await prisma.changelogEntry.updateMany({ where: { projectId: project.id }, data: { title: "Themes!" } });
      await deliver(published("v3.0", "2026-07-01T00:00:00Z"));
      expect((await drafts())[0]).toMatchObject({ title: "Themes!", collecting: false });

      await deliver(merged(51, "Search"));
      const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
      await call(publishChangelogEntry, team, { number: 2 });
      await deliver(merged(52, "Exports"));
      expect((await drafts()).map(({ number, collecting, publishedAt }) => ({ number, collecting, published: publishedAt !== null }))).toEqual([
        { number: 1, collecting: false, published: false },
        { number: 2, collecting: false, published: true },
        { number: 3, collecting: true, published: false },
      ]);
    });
  });
});
