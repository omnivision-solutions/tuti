import { prisma } from "@tuti/db";
import { fetchGithubSpec, GITHUB_NOT_ADDED, SPEC_FETCH_TIMEOUT_MS, SPEC_FILE_TOO_LARGE, syncApiReference as syncReferenceNow, syncApiReferences, SYNC_EVERY_MS } from "@tuti/jobs";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/github/webhook/route";
import TeamDocsLayout from "@/app/app/(workspace)/[project]/docs/layout";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import * as actions from "./api-references";
import { searchDocs } from "./docs-search";
import { countSpecFetch, createApiReference, FETCHES_PER_MEMBER_PER_MINUTE, getApiReference, syncApiReference } from "./operations/api-references";
import { listGithubRepositories } from "./operations/github";
import { call } from "./operations/run";

/**
 * API references read from a file in a repository the project added on GitHub (docs/plan.md, API reference in Docs,
 * A11): added from a repository, a path and a branch, read with the app's installation, and synced when a pull request
 * into the branch that changes the file merges, on Sync now and every 6 hours. GitHub is the local fake.
 */

let github: GithubFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let installationId = 9_000;
/** The project's repository, and a second one it added. */
let repo: { id: number; fullName: string };
let other: { id: number; fullName: string };

beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
  installationId++;
  repo = { id: installationId, fullName: `acme/api-${installationId}` };
  other = { id: installationId + 100_000, fullName: `acme/other-${installationId}` };
  await prisma.githubInstallation.create({
    data: { projectId: project.id, installationId, accountLogin: "acme", createdById: owner.id, included: { create: [repo, other].map(({ id, fullName }) => ({ repoId: id, fullName })) } },
  });
  github.repository(repo.fullName, { commit: `c-${installationId}`, files: { "docs/openapi.json": POSTS } });
  github.repository(other.fullName, { commit: `o-${installationId}`, branch: "trunk", files: { "spec.json": spec({ "GET /other": "Other" }) } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  github.answerTokens(null);
  github.beforeAnswering(null);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** An OpenAPI spec with these operations ("GET /posts": its tag), its server relative. */
function spec(operations: Record<string, string>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, tag] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = { tags: [tag], summary: key, responses: { 200: { description: "OK" } } };
  }
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Acme API", version: "1" }, servers: [{ url: "/v1" }], paths });
}
const POSTS = spec({ "GET /posts": "Posts" });
const MORE = spec({ "GET /posts": "Posts", "POST /posts": "Posts" });

const add = (github: { repoId?: number; path?: string; ref?: string } = {}) =>
  call(createApiReference, as(), { name: "Acme API", github: { repoId: repo.id, path: "docs/openapi.json", ...github } });
const stored = () => prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: "acme-api" } } });
const sync = (github?: { repoId?: number; path?: string; ref?: string }) => call(syncApiReference, as(), { slug: "acme-api", github });
/** The file on the repository's default branch, now. */
const commit = (files: Record<string, string>) => github.repository(repo.fullName, { commit: `c-${installationId}-${Math.random()}`, files });
const fetches = () => prisma.apiReferenceFetch.count({ where: { projectId: project.id } });

describe("added from GitHub", () => {
  test("the file on the branch is read with the installation, and the repository, path and branch are its source", async () => {
    expect(await add({ ref: "main" })).toMatchObject({ slug: "acme-api", source: "github", repoId: repo.id, path: "docs/openapi.json", ref: "main", sourceUrl: null, syncError: null });
    const row = await stored();
    expect(row.spec).toBe(POSTS);
    // A file has no address its relative servers could be on: they stay as written, with their warning, as an upload's.
    const doc = row.doc as { servers: { url: string }[]; warnings: { code: string }[] };
    expect(doc.servers[0]!.url).toBe("/v1");
    expect(doc.warnings.map((warning) => warning.code)).toContain("RELATIVE_SERVER");
    expect(github.reads).toContain(`/repos/${repo.fullName}/contents/docs/openapi.json`);
  });

  test("without a branch, the repository's default one is read and kept", async () => {
    expect(await call(createApiReference, as(), { name: "Other", github: { repoId: other.id, path: "/spec.json" } })).toMatchObject({ ref: "trunk", path: "spec.json" });
  });

  test("a repository the project didn't add is refused, unread and uncounted", async () => {
    const elsewhere = await createProject(await signUp("Someone else"));
    const theirs = { id: installationId + 200_000, fullName: `acme/theirs-${installationId}` };
    await prisma.githubInstallation.create({
      data: { projectId: elsewhere.id, installationId: installationId + 200_000, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: theirs.id, fullName: theirs.fullName } } },
    });
    github.repository(theirs.fullName, { commit: "t", files: { "docs/openapi.json": POSTS } });
    const reads = github.reads.length;
    for (const repoId of [theirs.id, 424_242]) {
      await expect(add({ repoId })).rejects.toMatchObject({ status: 400, message: GITHUB_NOT_ADDED });
    }
    expect(github.reads.length).toBe(reads);
    expect(await fetches()).toBe(0);
  });

  test("a path or a branch that isn't there, or a repository the app can't see, says which", async () => {
    await expect(add({ path: "openapi.yaml" })).rejects.toMatchObject({ status: 400, message: `There's no file at openapi.yaml on main in ${repo.fullName}.` });
    await expect(add({ ref: "release" })).rejects.toMatchObject({ status: 400, message: `${repo.fullName} has no branch “release”.` });
    await prisma.githubRepository.update({ where: { repoId: repo.id }, data: { fullName: "acme/gone" } });
    await expect(add()).rejects.toMatchObject({ status: 400, message: "Tuti's GitHub app can't see acme/gone any more." });
  });

  test("a path that would leave the file's address is refused before anything is read", async () => {
    const reads = github.reads.length;
    for (const path of ["../../user", "docs/../openapi.json", "docs//openapi.json", "./openapi.json"]) {
      await expect(add({ path })).rejects.toMatchObject({ status: 400 });
    }
    for (const ref of ["main branch", "..", "a/../b"]) {
      await expect(add({ ref })).rejects.toMatchObject({ status: 400 });
    }
    expect(github.reads.length).toBe(reads);
  });

  test("a file over 5 MB is refused", async () => {
    commit({ "docs/openapi.json": "x".repeat(OPENAPI_MAX_BYTES + 1) });
    await expect(add()).rejects.toMatchObject({ status: 400, message: SPEC_FILE_TOO_LARGE });
  });

  test("an installation GitHub won't give a token for says so; GitHub's own trouble says try again", async () => {
    const reconnect = "Tuti's GitHub app can't reach this repository any more. Connect GitHub again in Settings › Integrations.";
    const later = "Couldn't read the file from GitHub. Try again later.";
    // Refused (401: the app's key isn't GitHub's), gone (404) or suspended (403): connect again.
    vi.stubEnv("GITHUB_APP_ID", "1");
    await expect(add()).rejects.toMatchObject({ status: 400, message: reconnect });
    vi.stubEnv("GITHUB_APP_ID", github.env.GITHUB_APP_ID!);
    for (const status of [403, 404]) {
      github.answerTokens(status);
      await expect(add()).rejects.toMatchObject({ status: 400, message: reconnect });
    }
    // An outage or a rate limit: connecting again wouldn't help.
    for (const status of [429, 503]) {
      github.answerTokens(status);
      await expect(add()).rejects.toMatchObject({ status: 400, message: later });
    }
    // Nor a secondary rate limit, which GitHub answers with a 403: by its retry-after, its remaining count or its words.
    const limits: { headers?: Record<string, string>; message?: string }[] = [
      { headers: { "retry-after": "60" } },
      { headers: { "x-ratelimit-remaining": "0" } },
      { message: "You have exceeded a secondary rate limit." },
    ];
    for (const answer of limits) {
      github.answerTokens(403, answer);
      await expect(add()).rejects.toMatchObject({ status: 400, message: later });
    }
    // A 403 with none of them, and the remaining count above 0, is a suspended installation.
    github.answerTokens(403, { headers: { "x-ratelimit-remaining": "4999" }, message: "This installation has been suspended" });
    await expect(add()).rejects.toMatchObject({ status: 400, message: reconnect });
    // Nor a file GitHub fails to send.
    github.answerTokens(null);
    github.repository(repo.fullName, { commit: "failing", files: { "docs/openapi.json": POSTS }, failing: ["docs/openapi.json"] });
    await expect(add()).rejects.toMatchObject({ status: 400, message: later });
  });

  // One deadline for all of a read's requests: GitHub's answers move a clock of the test's own on by what each takes,
  // and once it's past the deadline, the deadline ends and GitHub's answer is held (until the test lets it go).
  const SLOW: [string, Partial<Record<"token" | "branch" | "file", number>>][] = [
    ["the token's request", { token: SPEC_FETCH_TIMEOUT_MS + 1000 }],
    ["the default branch's read", { token: 6000, branch: 10_000 }],
    ["the file's read, after the others took most of it", { token: 6000, branch: 6000, file: 6000 }],
  ];
  test.each(SLOW)("a read GitHub doesn't finish by its deadline says so: ending in %s", async (_, takes) => {
    const deadline = new AbortController();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let elapsed = 0;
    github.beforeAnswering(({ method, path }) => {
      const step =
        method === "POST" && path.endsWith("/access_tokens")
          ? "token"
          : path === `/repos/${repo.fullName}`
            ? "branch"
            : path.startsWith(`/repos/${repo.fullName}/contents/`)
              ? "file"
              : null;
      elapsed += step ? (takes[step] ?? 0) : 0;
      if (elapsed >= SPEC_FETCH_TIMEOUT_MS) {
        deadline.abort();
        return released;
      }
    });
    // No branch given: the default one is read first.
    expect(await fetchGithubSpec(project.id, { repoId: repo.id, path: "docs/openapi.json" }, { signal: deadline.signal })).toEqual({
      error: "GitHub didn't answer within 15 seconds.",
    });
    release();
  });

  test("a repository id no repository can have is refused", async () => {
    await expect(add({ repoId: 2_147_483_648 })).rejects.toMatchObject({ status: 400, message: "That isn't a repository's id" });
  });
});

describe("the dialog's GitHub panel", () => {
  test("githubRepositories.list gives the project's repositories by name, with the ids adding one takes", async () => {
    const elsewhere = await createProject(await signUp("Someone else"));
    await prisma.githubInstallation.create({
      data: { projectId: elsewhere.id, installationId: installationId + 300_000, accountLogin: "acme", createdById: owner.id, included: { create: { repoId: installationId + 300_000, fullName: "acme/aaa-theirs" } } },
    });
    expect(await call(listGithubRepositories, as(), {})).toEqual({ repositories: [repo, other] });
    actAs(owner);
    expect(await actions.listApiReferenceRepositories(project.slug)).toEqual({ repositories: [repo, other] });
  });

  test("the docs offer GitHub only on a server with its App, and its Settings link only to an admin", async () => {
    const workspace = async () => {
      const element = (await TeamDocsLayout({ params: Promise.resolve({ project: project.slug }), children: null } as never)) as { props: { admin: boolean; github: boolean } };
      return { admin: element.props.admin, github: element.props.github };
    };
    actAs(owner);
    expect(await workspace()).toEqual({ admin: true, github: true });
    vi.stubEnv("GITHUB_APP_ID", "");
    expect(await workspace()).toEqual({ admin: true, github: false });
    await prisma.teamMember.updateMany({ where: { projectId: project.id }, data: { role: "MEMBER" } });
    expect(await workspace()).toEqual({ admin: false, github: false });
  });

  test("Fetch reads the file as adding would: the name it suggests, the branch it read, and why one can't be read", async () => {
    actAs(owner);
    expect(await actions.previewApiReferenceGithub(project.slug, { repoId: other.id, path: "spec.json" })).toEqual({ suggests: "Acme API", ref: "trunk" });
    expect(await actions.previewApiReferenceGithub(project.slug, { repoId: repo.id, path: "nope.json", ref: "main" })).toEqual({ error: `There's no file at nope.json on main in ${repo.fullName}.` });
    expect(await actions.previewApiReferenceGithub(project.slug, { repoId: repo.id, path: "../x" })).toMatchObject({ error: expect.any(String) });
    // Nothing is stored; the reads the team asked for are counted (not the refused path).
    expect(await prisma.apiReference.count({ where: { projectId: project.id } })).toBe(0);
    expect(await fetches()).toBe(2);
  });
});

describe("synced", () => {
  beforeEach(async () => {
    await add();
  });

  test("Sync now reads the file again, and what's new is New", async () => {
    commit({ "docs/openapi.json": MORE });
    expect(await sync()).toMatchObject({ changes: { added: 1, removed: 0, changed: true }, failure: null, syncError: null });
    expect((await call(getApiReference, as(), { slug: "acme-api" })).operations.filter((operation) => operation.new).map((operation) => operation.key)).toEqual(["POST /posts"]);
  });

  test("a file that's gone keeps the pages and says why, until a sync works", async () => {
    commit({});
    expect(await sync()).toMatchObject({ changes: null, failure: `There's no file at docs/openapi.json on main in ${repo.fullName}.` });
    expect(await stored()).toMatchObject({ spec: POSTS, syncError: `There's no file at docs/openapi.json on main in ${repo.fullName}.` });
    commit({ "docs/openapi.json": POSTS });
    expect(await sync()).toMatchObject({ syncError: null });
  });

  test("a repository the project removed, or a lost installation, fails the sync with why", async () => {
    await prisma.githubInstallation.deleteMany({ where: { projectId: project.id } });
    const before = await fetches();
    expect(await sync()).toMatchObject({ changes: null, failure: GITHUB_NOT_ADDED });
    // Nothing was read: it isn't counted.
    expect(await fetches()).toBe(before);
  });

  test("changing the repository, path or branch reads it first, and keeps it only if it reads", async () => {
    await expect(sync({ path: "nope.json" })).rejects.toMatchObject({ status: 400 });
    expect(await stored()).toMatchObject({ repoId: repo.id, path: "docs/openapi.json", ref: "main", spec: POSTS });
    expect(await sync({ repoId: other.id, path: "spec.json", ref: "trunk" })).toMatchObject({ repoId: other.id, path: "spec.json", ref: "trunk", changes: { added: 1, removed: 1 } });
    // A URL's address isn't a repository's to take, nor the other way round.
    await expect(call(syncApiReference, as(), { slug: "acme-api", url: "https://example.com/openapi.json" })).rejects.toMatchObject({ status: 409 });
  });

  test("a sync overtaken by a change of the file writes nothing; a change overtaken by another is refused", async () => {
    // The sync of the file waits at GitHub while a teammate moves the reference to the other repository.
    let moved: Awaited<ReturnType<typeof sync>> | undefined;
    github.repository(repo.fullName, {
      commit: "held",
      files: { "docs/openapi.json": MORE },
      during: async () => {
        moved = await sync({ repoId: other.id, path: "spec.json", ref: "trunk" });
      },
    });
    expect(await sync()).toMatchObject({ changes: null, failure: null, repoId: other.id });
    expect(moved).toMatchObject({ repoId: other.id, changes: { added: 1 } });
    expect(await stored()).toMatchObject({ repoId: other.id, spec: spec({ "GET /other": "Other" }) });

    // The change back waits at GitHub while a teammate's Sync now lands: the change is refused.
    github.repository(repo.fullName, {
      commit: "held-again",
      files: { "docs/openapi.json": POSTS },
      during: () => sync(),
    });
    await expect(sync({ repoId: repo.id, path: "docs/openapi.json", ref: "main" })).rejects.toMatchObject({ status: 409, message: "The file changed or was synced meanwhile. Reload to see it, and try again." });
    expect(await stored()).toMatchObject({ repoId: other.id });
  });

  test("a sync reads the source it checked: one moved since is left alone, unread", async () => {
    const row = await stored();
    const reads = github.reads.length;
    expect(await syncReferenceNow(row.id, { expected: { ...row, path: "elsewhere.json" } })).toBeNull();
    expect(await syncReferenceNow(row.id, { expected: { ...row, syncTriedAt: new Date(0) } })).toBeNull();
    expect(github.reads.length).toBe(reads);
  });

  test("Sync now and adding count against the fetch limits as a URL's do", async () => {
    expect(await fetches()).toBe(1);
    await sync();
    expect(await fetches()).toBe(2);
    for (let at = 2; at < FETCHES_PER_MEMBER_PER_MINUTE; at++) {
      await countSpecFetch(as());
    }
    await expect(sync()).rejects.toMatchObject({ status: 429 });
    await expect(call(createApiReference, as(), { name: "Another", github: { repoId: repo.id, path: "docs/openapi.json" } })).rejects.toMatchObject({ status: 429 });
  });

  test("the 6-hourly job reads it when it's due, uncounted", async () => {
    commit({ "docs/openapi.json": MORE });
    await prisma.apiReference.updateMany({ data: { syncTriedAt: new Date() } });
    await prisma.apiReference.update({ where: { id: (await stored()).id }, data: { syncTriedAt: new Date(Date.now() - SYNC_EVERY_MS - 1000) } });
    const before = await fetches();
    expect(await syncApiReferences({}, { info: () => {}, warn: () => {}, error: () => {} } as never)).toMatchObject({ synced: 1, failed: 0 });
    expect(await stored()).toMatchObject({ spec: MORE });
    expect(await fetches()).toBe(before);
  });
});

describe("a pull request merging", () => {
  let number = 0;
  beforeEach(async () => {
    await add();
  });
  /** Pull request `number` merging into `base`, changing `files`, delivered to the webhook as GitHub signs it. */
  async function merge(base: string, files: (string | { filename: string; previous_filename: string })[]) {
    number++;
    github.pullRequest(repo.fullName, { number, title: `PR ${number}`, files: files.map((file) => (typeof file === "string" ? { filename: file } : file)) });
    const { body, headers } = github.webhook("pull_request", {
      action: "closed",
      installation: { id: installationId },
      repository: { id: repo.id, full_name: repo.fullName },
      pull_request: { number, title: `PR ${number}`, body: "", html_url: `https://github.com/${repo.fullName}/pull/${number}`, merged: true, base: { ref: base } },
    });
    expect((await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }

  test("into the branch, changing the file, syncs the reference; otherwise nothing is read", async () => {
    commit({ "docs/openapi.json": MORE, "src/app.ts": "" });
    const tried = (await stored()).syncTriedAt;
    await merge("main", ["src/app.ts"]);
    await merge("release", ["docs/openapi.json"]);
    expect(await stored()).toMatchObject({ spec: POSTS, syncTriedAt: tried });
    const before = await fetches();
    await merge("main", ["src/app.ts", "docs/openapi.json"]);
    expect(await stored()).toMatchObject({ spec: MORE, unseenCount: 1 });
    // The merge's read isn't one the team asked for.
    expect(await fetches()).toBe(before);
  });

  test("a file renamed away, or a pull request with GitHub's 3,000 files or more, syncs it", async () => {
    commit({ "docs/api.json": MORE });
    await merge("main", [{ filename: "docs/api.json", previous_filename: "docs/openapi.json" }]);
    expect(await stored()).toMatchObject({ spec: POSTS, syncError: `There's no file at docs/openapi.json on main in ${repo.fullName}.` });
    commit({ "docs/openapi.json": MORE });
    // GitHub lists no more than 3,000: the file may be past them.
    await merge("main", Array.from({ length: 3_000 }, (_, at) => `src/${at}.ts`));
    expect(await stored()).toMatchObject({ spec: MORE, syncError: null });
  });

  test("a merge's sync overtaken by one that read the file before it reads it again", async () => {
    commit({ "docs/openapi.json": MORE });
    // The merge's read waits at GitHub while a teammate's Sync now reads (and writes) the file as it was before the merge.
    github.repository(repo.fullName, {
      commit: "merged",
      files: { "docs/openapi.json": MORE },
      during: async () => {
        commit({ "docs/openapi.json": POSTS });
        expect(await sync()).toMatchObject({ changes: { changed: false } });
        commit({ "docs/openapi.json": MORE });
      },
    });
    await merge("main", ["docs/openapi.json"]);
    expect(await stored()).toMatchObject({ spec: MORE });
  });

  test("a reference whose sync fails on a merge stops none of the others", async () => {
    await call(createApiReference, as(), { name: "Second", github: { repoId: repo.id, path: "docs/openapi.json" } });
    // The first's stored doc can't be read over (as a write that fails would): its sync throws.
    await prisma.apiReference.update({ where: { id: (await stored()).id }, data: { doc: {} } });
    commit({ "docs/openapi.json": MORE });
    await merge("main", ["docs/openapi.json"]);
    expect(await prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: "second" } } })).toMatchObject({ spec: MORE });
  });

  test("a merge that brings a new operation makes it searchable, as adding, Sync now and another file do (A14)", async () => {
    /** What the docs' search finds for a signed-out reader, operations included, as their paths under /docs. */
    const found = async (query: string) => (await searchDocs(project.id, query, 10, SIGNED_OUT, { log: false, operations: true })).map((result) => result.slug);
    // Added: its operations are searchable.
    expect(await found("posts")).toEqual(["acme-api/get-posts"]);
    expect(await found("users")).toEqual([]);
    // A merge changing the file brings GET /users: searchable once it's synced.
    commit({ "docs/openapi.json": spec({ "GET /posts": "Posts", "GET /users": "Users" }) });
    await merge("main", ["docs/openapi.json"]);
    expect(await found("users")).toEqual(["acme-api/get-users"]);
    // Sync now dropping it takes it out.
    commit({ "docs/openapi.json": POSTS });
    expect((await sync()).changes).toMatchObject({ removed: 1, changed: true });
    expect(await found("users")).toEqual([]);
    // Another file (the other repository's): its operations replace these.
    await sync({ repoId: other.id, path: "spec.json", ref: "trunk" });
    expect(await found("other")).toEqual(["acme-api/get-other"]);
    expect(await found("posts")).toEqual([]);
  });

  test("a merge that breaks the file says so on the reference's page", async () => {
    commit({ "docs/openapi.json": "not a spec: [" });
    await merge("main", ["docs/openapi.json"]);
    expect(await stored()).toMatchObject({ spec: POSTS, syncError: expect.any(String) });
  });
});
