import { prisma } from "@tuti/db";
import { embedPosts } from "@tuti/jobs";
import { LINK_MIN_SIMILARITY } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type GithubFake, type OpenAIFake, startGithubFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { signValue, verifyValue } from "@/lib/github";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";
import { acceptLinkSuggestion, addLink, dismissLinkSuggestion, listLinkSuggestions } from "@/server/operations/links";
import { publishChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";

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

  test("commit messages mention posts too; commits pushed later add links without changing statuses", async () => {
    await postsWithStatus("OPEN", "OPEN", "OPEN");
    github.repo("acme/app", { commits: { 47: ["Dark mode (tuti#1)", "wip"] } });
    await deliver(pullRequest("opened", 47, "Themes", "No mentions here"));
    // Pushed later: one commit mentions #2. An edit doesn't read commits (they haven't changed).
    github.repo("acme/app", { commits: { 47: ["Dark mode (tuti#1)", "wip", "Night theme, closes tuti#2"] } });
    await deliver(pullRequest("synchronize", 47, "Themes", "No mentions here"));
    github.repo("acme/app", { commits: { 47: ["Dark mode (tuti#1)", "wip", "Night theme, closes tuti#2", "tuti#3"] } });
    await deliver(pullRequest("edited", 47, "Themes", "Still no mentions"));
    github.repo("acme/app", {});

    const link = { url: "https://github.com/acme/app/pull/47", source: "REFERENCE", title: "Themes" };
    expect(await linksAndStatuses()).toEqual([
      { number: 1, status: "IN_PROGRESS", links: [link] },
      { number: 2, status: "OPEN", links: [link] },
      { number: 3, status: "OPEN", links: [] },
    ]);
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
      github.comment("acme/app", 50, "Nice!");

      await deliver(pullRequest("opened", 50, "Dark mode", "tuti#1"));
      const [first, ...more] = appComments(50);
      expect(more).toEqual([]);
      // People's titles stay text: no mentions, links or references.
      expect(first!.body).toContain(
        `- [Ping @&#8203;team \\[here\\]\\(https://e\\.vil\\) \\#9](http://${project.slug}.localhost:3100/p/ping-team-here-https-e-vil-9-1) · 1 vote`,
      );

      // Someone quotes our comment; an edit links another post: our one comment is updated.
      github.comment("acme/app", 50, `${first!.body}\n\nlooks good`);
      await deliver(pullRequest("edited", 50, "Dark mode", "tuti#1 and tuti#2"));
      expect(appComments(50)).toHaveLength(1);
      expect(appComments(50)[0]!.id).toBe(first!.id);
      const lines = appComments(50)[0]!.body.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toEqual([expect.stringMatching(/^- \[Post 2\]\(.*\/p\/post-2-2\) · 3 votes$/), expect.stringContaining("· 1 vote")]);
      expect(github.comments("acme/app", 50).filter((c) => !c.byApp).map((c) => c.body.split("\n").at(-1))).toEqual([
        "Nice!",
        "looks good",
      ]);

      // Deleted on GitHub: the next change writes a new one.
      github.deleteComments("acme/app", 50);
      await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 1 } }, data: { voteCount: 5 } });
      await deliver(pullRequest("edited", 50, "Dark mode", "tuti#1 and tuti#2"));
      expect(appComments(50)).toEqual([expect.objectContaining({ body: expect.stringContaining("· 5 votes") })]);
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

  describe("suggested links", () => {
    let openai: OpenAIFake;
    beforeAll(async () => {
      openai = await startOpenAIFake();
    });
    afterAll(() => openai.close());
    beforeEach(() => {
      vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
      vi.stubEnv("OPENAI_BASE_URL", openai.url);
    });

    /** Posts with these titles, statuses and (embedded) vectors. */
    async function posts(...specs: { title: string; status?: "OPEN" | "COMPLETED"; vector: number[] }[]) {
      const board = project.boards[0]!;
      const created = [];
      for (const [i, spec] of specs.entries()) {
        openai.setVector(spec.title, spec.vector);
        created.push(
          await prisma.post.create({
            data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: i + 1, title: spec.title, body: "", status: spec.status ?? "OPEN" },
          }),
        );
      }
      await embedPosts(created);
      return created;
    }
    const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
    const pending = async () =>
      (await call(listLinkSuggestions, team(), {})).suggestions.map((s) => ({ post: s.post.number, pr: s.pullRequest.number }));

    test("open posts close to a pull request's text are suggested; done, linked and distant ones aren't", async () => {
      const close = LINK_MIN_SIMILARITY + 0.05;
      await posts(
        { title: "Dark mode", vector: [1, 0, 0] },
        { title: "Export to CSV", vector: [0, 1, 0] }, // only LINK_MIN_SIMILARITY - 0.05 close
        { title: "Darker theme", status: "COMPLETED", vector: [1, 0, 0] },
        { title: "Night colours", vector: [1, 0, 0] }, // the PR mentions it: linked, not suggested
      );
      const far = LINK_MIN_SIMILARITY - 0.05;
      openai.setVector("Theme switcher\n\nAlso fixes tuti#4", [close, far, Math.sqrt(1 - close ** 2 - far ** 2)]);

      await deliver(pullRequest("opened", 60, "Theme switcher", "Also fixes tuti#4"));
      await deliver(pullRequest("edited", 60, "Theme switcher", "Also fixes tuti#4")); // no second suggestion
      expect(await pending()).toEqual([{ post: 1, pr: 60 }]);
    });

    test("the team links a suggestion, or dismisses it for good", async () => {
      await posts({ title: "Dark mode", vector: [1, 0] }, { title: "Night theme", vector: [1, 0] });
      openai.setVector("Theme switcher", [1, 0]);
      await deliver(pullRequest("opened", 61, "Theme switcher", ""));
      // Renamed on GitHub: the waiting suggestions follow.
      await deliver(pullRequest("edited", 61, "Theme picker", ""));
      const [first, second] = (await call(listLinkSuggestions, team(), {})).suggestions;
      expect([first!.pullRequest.title, second!.pullRequest.title]).toEqual(["Theme picker", "Theme picker"]);

      expect(await call(acceptLinkSuggestion, team(), { id: first!.id })).toMatchObject({
        kind: "pull_request",
        url: "https://github.com/acme/app/pull/61",
        title: "Theme picker",
      });
      await call(dismissLinkSuggestion, team(), { id: second!.id });
      // A new post since: suggested next time, next to the dismissed one, which stays dismissed.
      openai.setVector("Dim the UI", [1, 0]);
      const third = await prisma.post.create({
        data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 3, title: "Dim the UI", body: "" },
      });
      await embedPosts([third]);
      await deliver(pullRequest("edited", 61, "Theme switcher", ""));
      expect(await pending()).toEqual([{ post: 3, pr: 61 }]);
      expect(await prisma.postLink.findMany({ where: { projectId: project.id }, select: { source: true, postId: true } })).toEqual([
        { source: "SUGGESTED", postId: expect.any(String) },
      ]);
      await expect(call(acceptLinkSuggestion, team(), { id: second!.id })).rejects.toMatchObject({ status: 404 });
    });

    test("at most three wait at a time; dismissing them makes room for the next", async () => {
      await posts(
        { title: "Dark mode", vector: [1, 0] },
        { title: "Night theme", vector: [1, 0] },
        { title: "Dim the UI", vector: [1, 0] },
        { title: "Black background", vector: [0.9, Math.sqrt(1 - 0.81)] },
      );
      openai.setVector("Theme switcher", [1, 0]);
      await deliver(pullRequest("opened", 64, "Theme switcher", ""));
      await deliver(pullRequest("edited", 64, "Theme switcher", "")); // still 3 waiting, not 4
      const first = (await call(listLinkSuggestions, team(), {})).suggestions;
      expect(first.map((s) => s.post.number).sort()).toEqual([1, 2, 3]);
      for (const suggestion of first) {
        await call(dismissLinkSuggestion, team(), { id: suggestion.id });
      }
      await deliver(pullRequest("edited", 64, "Theme switcher", ""));
      expect(await pending()).toEqual([{ post: 4, pr: 64 }]);
    });

    test("a suggestion goes once its post is linked another way, or done", async () => {
      await posts({ title: "Dark mode", vector: [1, 0] }, { title: "Night theme", vector: [1, 0] }, { title: "Dim the UI", vector: [1, 0] });
      openai.setVector("Theme switcher", [1, 0]);
      await deliver(pullRequest("opened", 65, "Theme switcher", ""));
      const byPost = new Map((await call(listLinkSuggestions, team(), {})).suggestions.map((s) => [s.post.number, s.id]));

      // Linked by hand, and by a mention in an edit.
      await call(addLink, team(), { number: 1, url: "https://github.com/acme/app/pull/65" });
      await deliver(pullRequest("edited", 65, "Theme switcher", "tuti#2"));
      // Done before anyone looked: no longer offered, and can't be accepted.
      await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 3 } }, data: { status: "COMPLETED" } });

      expect(await pending()).toEqual([]);
      await expect(call(acceptLinkSuggestion, team(), { id: byPost.get(3)! })).rejects.toMatchObject({ status: 404 });
      // The linked ones are gone; the done one is only hidden.
      const left = await prisma.linkSuggestion.findMany({ where: { projectId: project.id }, select: { post: { select: { number: true } } } });
      expect(left).toEqual([{ post: { number: 3 } }]);
    });

    test("without embeddings, or when they fail, the pull request is still handled", async () => {
      await posts({ title: "Dark mode", vector: [1, 0] });
      openai.failNext(500);
      expect(await deliver(pullRequest("opened", 62, "Dark mode", "tuti#1"))).toBe(200);
      vi.stubEnv("OPENAI_API_KEY", "");
      expect(await deliver(pullRequest("opened", 63, "Dark mode", ""))).toBe(200);
      expect(await pending()).toEqual([]);
      expect((await linksAndStatuses())[0]).toMatchObject({ status: "IN_PROGRESS" });
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

  describe("the changelog's running draft", () => {
    const merged = (number: number, title: string, labels: string[] = []) =>
      github.webhook("pull_request", {
        action: "closed",
        installation: { id: installationId },
        repository: { full_name: repo },
        pull_request: {
          number,
          title,
          body: "",
          html_url: `https://github.com/${repo}/pull/${number}`,
          merged: true,
          labels: labels.map((name) => ({ name })),
        },
      });
    const drafts = async () =>
      (
        await prisma.changelogEntry.findMany({
          where: { projectId: project.id },
          orderBy: { number: "asc" },
          select: { number: true, title: true, body: true, collecting: true, publishedAt: true, posts: { select: { post: { select: { number: true } } } } },
        })
      ).map((e) => ({ ...e, posts: e.posts.map(({ post }) => post.number) }));

    test("merged pull requests gather in one draft, once each; internal work stays out; a release closes it", async () => {
      await prisma.githubInstallation.update({ where: { installationId }, data: { closeOn: "MERGE" } });
      github.repo(repo, { releases: [], pulls: {} });
      await linkedPosts([{ status: "IN_PROGRESS", pull: 40 }]);

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
          posts: [1],
        },
      ]);
      const content = (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).content as {
        content: { type: string; content: unknown[] }[];
      };
      expect(content.content).toEqual([expect.objectContaining({ type: "bulletList", content: [expect.anything(), expect.anything()] })]);

      // The release names and closes it; the next merge starts a new one.
      await deliver(published("v2.0", "2026-06-01T00:00:00Z"));
      await deliver(merged(43, "Exports"));
      expect((await drafts()).map(({ number, title, collecting }) => ({ number, title, collecting }))).toEqual([
        { number: 1, title: "Release v2.0", collecting: false },
        { number: 2, title: "Next release", collecting: true },
      ]);
    });

    test("merges arriving at once still make one draft with all of them", async () => {
      await prisma.githubInstallation.update({ where: { installationId }, data: { closeOn: "MERGE" } });
      github.repo(repo, { releases: [], pulls: {} });
      await Promise.all([60, 61, 62, 63].map((n) => deliver(merged(n, `PR ${n}`))));
      const all = await drafts();
      expect(all).toHaveLength(1);
      expect(all[0]!.body.split("\n").sort()).toEqual([60, 61, 62, 63].map((n) => `PR ${n} (${repo}#${n})`));
    });

    test("a draft the team renamed keeps its name; one published by hand stops collecting", async () => {
      await prisma.githubInstallation.update({ where: { installationId }, data: { closeOn: "MERGE" } });
      github.repo(repo, { releases: [], pulls: {} });
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
