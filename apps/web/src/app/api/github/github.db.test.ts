import { prisma } from "@tuti/db";
import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { signValue, verifyValue } from "@/lib/github";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { GET as callback } from "./callback/route";
import { GET as install } from "./install/route";
import { GET as setup } from "./setup/route";
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

/**
 * The whole connect flow, as the browser goes through it: Connect GitHub → GitHub's
 * install page → our Setup URL (`installation_id`) → GitHub's authorize page → our
 * callback (`code`, `state`). `code` is whoever authorizes on GitHub.
 */
async function connect(projectSlug: string, installationId: number, code: string) {
  const started = await install(new Request(`${APP}/api/github/install?project=${projectSlug}`));
  if (!location(started).startsWith(github.url)) {
    return location(started);
  }
  const installCookie = started.headers.getSetCookie()[0]!.split(";")[0]!;
  const session = request.cookie;
  request.cookie = `${session}; ${installCookie}`;
  const authorize = await setup(new Request(`${APP}/api/github/setup?installation_id=${installationId}&setup_action=install`));
  request.cookie = session;
  if (!location(authorize).startsWith(`${github.url}/login/oauth/authorize`)) {
    return location(authorize);
  }
  const state = new URL(location(authorize)).searchParams.get("state")!;
  return location(await callback(new Request(`${APP}/api/github/callback?code=${code}&state=${encodeURIComponent(state)}`)));
}

const connected = (projectId: string) => prisma.githubInstallation.findUnique({ where: { projectId } });

describe("connecting", () => {
  test("the person who installs can see the installation: the project is connected", async () => {
    github.user("code-1", [{ id: 501, account: "acme" }]);
    expect(await connect(project.slug, 501, "code-1")).toBe(`${APP}/app/${project.slug}/settings?github=connected`);
    expect(await connected(project.id)).toMatchObject({ installationId: 501, accountLogin: "acme" });
  });

  test("the installation may be on any page of the person's installations", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: 10_000 + i, account: `org-${i}` }));
    github.user("code-many", many);
    expect(await connect(project.slug, 10_249, "code-many")).toMatch(/github=connected$/);
  });

  test("someone else's installation can't be claimed", async () => {
    github.user("code-2", [{ id: 777, account: "mine" }]); // can see 777, not 501
    expect(await connect(project.slug, 501, "code-2")).toMatch(/github=unconfirmed$/);
    expect(await connect(project.slug, 501, "made-up")).toMatch(/github=unconfirmed$/);
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

  test("an installation connected to one project can't be connected to another", async () => {
    github.user("code-4", [{ id: 503, account: "acme" }]);
    await connect(project.slug, 503, "code-4");
    const other = await createProject(owner);
    expect(await connect(other.slug, 503, "code-4")).toMatch(/github=taken$/);
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

describe("pull requests", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;
  let installationId: number;
  const pullRequest = (action: string, number: number, title: string, body: string, installation = installationId) =>
    github.webhook("pull_request", {
      action,
      installation: { id: installation },
      repository: { full_name: "acme/app" },
      pull_request: { number, title, body, html_url: `https://github.com/acme/app/pull/${number}` },
    });

  async function postsWithStatus(...statuses: ("OPEN" | "COMPLETED")[]) {
    const board = project.boards[0]!;
    for (const [i, status] of statuses.entries()) {
      await prisma.post.create({
        data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: i + 1, title: `Post ${i + 1}`, body: "", status },
      });
    }
  }
  const linksAndStatuses = async () =>
    (
      await prisma.post.findMany({
        where: { projectId: project.id },
        orderBy: { number: "asc" },
        select: { number: true, status: true, links: { select: { url: true, source: true, title: true } } },
      })
    ).map((p) => ({ number: p.number, status: p.status, links: p.links }));

  let nextInstallationId = 1000;
  beforeEach(async () => {
    installationId = nextInstallationId++;
    await prisma.githubInstallation.create({
      data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id },
    });
  });

  test("a PR that mentions posts links them and, opened, moves them to In progress", async () => {
    await postsWithStatus("OPEN", "COMPLETED", "OPEN");
    // Tests' portals are http://<project>.localhost:3100 (PORTAL_URL_TEMPLATE).
    const body = `Fixes tuti#1. Also http://${project.slug}.localhost:3100/p/post-2-2 and mytuti#3, not tuti#30.`;
    expect(await deliver(pullRequest("opened", 42, "Dark mode", body))).toBe(200);

    const link = { url: "https://github.com/acme/app/pull/42", source: "REFERENCE", title: "Dark mode" };
    expect(await linksAndStatuses()).toEqual([
      { number: 1, status: "IN_PROGRESS", links: [link] },
      { number: 2, status: "COMPLETED", links: [link] }, // already done: linked, not reopened
      { number: 3, status: "OPEN", links: [] }, // "mytuti#3" isn't a reference
    ]);
  });

  test("a status the team changed meanwhile isn't overwritten, and a redelivery doesn't move it twice", async () => {
    await postsWithStatus("OPEN");
    const opened = pullRequest("opened", 45, "Dark mode", "tuti#1");
    await deliver(opened);
    await deliver(opened); // GitHub redelivers
    expect((await linksAndStatuses())[0]).toMatchObject({ number: 1, status: "IN_PROGRESS" });

    // The job reads the post as Open; the team marks it Completed before the job writes.
    await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "OPEN" } });
    const read = prisma.post.findMany.bind(prisma.post);
    vi.spyOn(prisma.post, "findMany").mockImplementationOnce((async (args: never) => {
      const posts = await read(args);
      await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "COMPLETED" } });
      return posts;
    }) as never);
    await deliver(pullRequest("reopened", 45, "Dark mode", "tuti#1"));
    expect((await linksAndStatuses())[0]).toMatchObject({ status: "COMPLETED" });
  });

  test("if the pull request can't be handled, GitHub isn't told it was (so it can be redelivered)", async () => {
    await postsWithStatus("OPEN");
    vi.spyOn(prisma.githubInstallation, "findUnique").mockRejectedValueOnce(new Error("database down"));
    expect(await deliver(pullRequest("opened", 46, "Dark mode", "tuti#1"))).toBe(503);
    expect(await deliver(pullRequest("opened", 46, "Dark mode", "tuti#1"))).toBe(200); // redelivered
    expect((await linksAndStatuses())[0]).toMatchObject({ status: "IN_PROGRESS" });
  });

  test("edits add new mentions without changing statuses; other installations are ignored", async () => {
    await postsWithStatus("OPEN", "OPEN");
    await deliver(pullRequest("edited", 43, "Export", "Now also tuti#2"));
    await deliver(pullRequest("opened", 44, "Elsewhere", "tuti#1", 1));
    expect(await linksAndStatuses()).toEqual([
      { number: 1, status: "OPEN", links: [] },
      { number: 2, status: "OPEN", links: [{ url: "https://github.com/acme/app/pull/43", source: "REFERENCE", title: "Export" }] },
    ]);
  });

  describe("comments on pull requests", () => {
    const appComments = (number: number) => github.comments("acme/app", number).filter((c) => c.byApp);
    const commentOn = () =>
      prisma.githubInstallation.update({ where: { installationId }, data: { commentOnPullRequests: true } });

    test("one comment lists the feedback a pull request completes, most voted first, kept up to date", async () => {
      await postsWithStatus("OPEN", "OPEN");
      await prisma.post.update({
        where: { projectId_number: { projectId: project.id, number: 1 } },
        data: { title: "Ping @team [here](https://e.vil) #9", voteCount: 1 },
      });
      await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 2 } }, data: { voteCount: 3 } });
      await commentOn();

      await deliver(pullRequest("opened", 50, "Dark mode", "tuti#1"));
      const [first, ...more] = appComments(50);
      expect(more).toEqual([]);
      // People's titles stay text: no mentions, links or references.
      expect(first!.body).toContain(
        `- [Ping @&#8203;team \\[here\\]\\(https://e\\.vil\\) \\#9](http://${project.slug}.localhost:3100/p/ping-team-here-https-e-vil-9-1) · 1 vote`,
      );

      // Someone pastes our marker; an edit links another post: our one comment is updated.
      github.comment("acme/app", 50, `${first!.body}\n\nlooks good`);
      await deliver(pullRequest("edited", 50, "Dark mode", "tuti#1 and tuti#2"));
      expect(appComments(50)).toHaveLength(1);
      const lines = appComments(50)[0]!.body.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toEqual([expect.stringMatching(/^- \[Post 2\]\(.*\/p\/post-2-2\) · 3 votes$/), expect.stringContaining("· 1 vote")]);
      expect(github.comments("acme/app", 50).filter((c) => !c.byApp)[0]!.body).toMatch(/looks good$/);
    });

    test("they're off by default, and without write permission only the comment is lost", async () => {
      await postsWithStatus("OPEN", "OPEN");
      await deliver(pullRequest("opened", 51, "Export", "tuti#1"));
      expect(github.comments("acme/app", 51)).toEqual([]);

      await commentOn();
      github.repo("acme/app", { readOnly: true });
      try {
        expect(await deliver(pullRequest("opened", 52, "Import", "tuti#2"))).toBe(200);
      } finally {
        github.repo("acme/app", {});
      }
      expect(github.comments("acme/app", 52)).toEqual([]);
      expect((await linksAndStatuses())[1]).toMatchObject({ status: "IN_PROGRESS", links: [expect.objectContaining({ title: "Import" })] });
    });
  });

  test("references: own words only, on this project's portal only", async () => {
    const { referencedPosts } = await import("@tuti/jobs");
    expect(referencedPosts("tuti#1, (tuti#2) TUTI#3 x-tuti#4 tuti#5a #tuti#6", "acme").sort()).toEqual([1, 2, 3]);
    expect(
      referencedPosts(
        [
          "http://acme.localhost:3100/p/dark-mode-7",
          "https://acme.localhost:3100/p/9",
          "http://other.localhost:3100/p/x-8", // another project
          "http://acme.localhost:3100/b/x-10", // not a post
          "https://acme.github.io/p/x-11", // look-alike hosts
          "https://acme.localhost:3100.evil.example/p/x-12",
          "https://acme.com/p/x-13",
        ].join(" "),
        "acme",
      ).sort((a, b) => a - b),
    ).toEqual([7, 9]);
  });
});

describe("shipping", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;
  let installationId = 5000;
  let repo: string;

  /** Posts with these statuses, each linked to the pull request with the same index in `pulls`. */
  async function linkedPosts(posts: { status: "OPEN" | "IN_PROGRESS" | "COMPLETED"; pull: number }[]) {
    const board = project.boards[0]!;
    for (const [i, { status, pull }] of posts.entries()) {
      const post = await prisma.post.create({
        data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: i + 1, title: `Post ${i + 1}`, body: "", status },
      });
      await prisma.postLink.create({
        data: {
          projectId: project.id,
          postId: post.id,
          kind: "PULL_REQUEST",
          repo,
          number: pull,
          url: `https://github.com/${repo}/pull/${pull}`,
          source: "REFERENCE",
        },
      });
    }
  }
  const statuses = async () =>
    (await prisma.post.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { status: true } })).map(
      (p) => p.status,
    );
  const published = (tag: string, publishedAt: string) =>
    github.webhook("release", {
      action: "published",
      installation: { id: installationId },
      repository: { full_name: repo },
      release: { tag_name: tag, name: `Release ${tag}`, html_url: `https://github.com/${repo}/releases/tag/${tag}`, published_at: publishedAt },
    });

  beforeEach(async () => {
    installationId++;
    repo = `acme/app-${installationId}`;
    await prisma.githubInstallation.create({
      data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id },
    });
  });

  test("a release completes the posts whose pull requests it ships, and links itself to them", async () => {
    // 300 commits; v1.0 is commit 50, v1.1 is commit 290. Merge commits: #10 at 140 (in v1.1),
    // #12 at 295 (after v1.1), #13 at 20 (already in v1.0); #14 doesn't exist (an issue's number).
    const history = Array.from({ length: 300 }, (_, i) => `sha-${i}`);
    github.repo(repo, {
      history,
      tags: { "v1.0": "sha-50", "v1.1": "sha-290" },
      releases: [
        { tag_name: "v1.1", published_at: "2026-02-01T00:00:00Z" },
        { tag_name: "v1.0", published_at: "2026-01-01T00:00:00Z" },
      ],
      pulls: {
        10: { merged_at: "2026-01-15T00:00:00Z", merge_commit_sha: "sha-140" },
        11: { merged_at: null, merge_commit_sha: null },
        12: { merged_at: "2026-02-10T00:00:00Z", merge_commit_sha: "sha-295" },
        13: { merged_at: "2025-12-20T00:00:00Z", merge_commit_sha: "sha-20" },
      },
    });
    await linkedPosts([
      { status: "IN_PROGRESS", pull: 10 },
      { status: "OPEN", pull: 11 },
      { status: "IN_PROGRESS", pull: 12 },
      { status: "COMPLETED", pull: 10 },
      { status: "IN_PROGRESS", pull: 13 },
      { status: "IN_PROGRESS", pull: 14 },
    ]);

    expect(await deliver(published("v1.1", "2026-02-01T00:00:00Z"))).toBe(200);
    expect(await statuses()).toEqual(["COMPLETED", "OPEN", "IN_PROGRESS", "COMPLETED", "IN_PROGRESS", "IN_PROGRESS"]);
    const releaseLinks = await prisma.postLink.findMany({ where: { projectId: project.id, kind: "RELEASE" }, select: { tag: true, title: true } });
    expect(releaseLinks).toEqual([{ tag: "v1.1", title: "Release v1.1" }]);
  });

  test("a repo's first release ships every pull request in it", async () => {
    github.repo(repo, {
      history: ["a", "b", "c"],
      tags: { "v0.1": "b" },
      releases: [{ tag_name: "v0.1", published_at: "2026-03-01T00:00:00Z" }],
      pulls: {
        20: { merged_at: "2026-02-01T00:00:00Z", merge_commit_sha: "a" },
        21: { merged_at: "2026-04-01T00:00:00Z", merge_commit_sha: "c" },
      },
    });
    await linkedPosts([
      { status: "IN_PROGRESS", pull: 20 },
      { status: "IN_PROGRESS", pull: 21 },
    ]);
    await deliver(published("v0.1", "2026-03-01T00:00:00Z"));
    expect(await statuses()).toEqual(["COMPLETED", "IN_PROGRESS"]);
  });

  test("if the previous release can't be found among very many, nothing is completed rather than guessing", async () => {
    // 2,000 releases published after this one (a delayed job), none before it.
    const later = Array.from({ length: 2000 }, (_, i) => ({ tag_name: `v9.${i}`, published_at: "2026-09-01T00:00:00Z" }));
    github.repo(repo, {
      history: ["a", "b"],
      tags: { "v1.0": "b" },
      releases: [...later, { tag_name: "v1.0", published_at: "2026-03-01T00:00:00Z" }],
      pulls: { 40: { merged_at: "2026-02-01T00:00:00Z", merge_commit_sha: "a" } },
    });
    await linkedPosts([{ status: "IN_PROGRESS", pull: 40 }]);
    await deliver(published("v1.0", "2026-03-01T00:00:00Z"));
    expect(await statuses()).toEqual(["IN_PROGRESS"]);
  });

  test("projects without releases complete posts when the pull request is merged instead", async () => {
    await prisma.githubInstallation.update({ where: { installationId }, data: { closeOn: "MERGE" } });
    github.repo(repo, { releases: [{ tag_name: "v9", published_at: "2026-05-01T00:00:00Z" }], pulls: {} });
    await linkedPosts([
      { status: "IN_PROGRESS", pull: 30 },
      { status: "IN_PROGRESS", pull: 31 },
    ]);
    const closed = (number: number, merged: boolean) =>
      github.webhook("pull_request", {
        action: "closed",
        installation: { id: installationId },
        repository: { full_name: repo },
        pull_request: { number, title: "PR", body: "", html_url: `https://github.com/${repo}/pull/${number}`, merged },
      });
    await deliver(closed(30, true));
    await deliver(closed(31, false)); // closed without merging
    expect(await statuses()).toEqual(["COMPLETED", "IN_PROGRESS"]);
    // Releases don't complete anything for these projects.
    await deliver(published("v9", "2026-05-01T00:00:00Z"));
    expect(await statuses()).toEqual(["COMPLETED", "IN_PROGRESS"]);
  });
});
