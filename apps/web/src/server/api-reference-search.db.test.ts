import { prisma, type ReadAccess } from "@tuti/db";
import { apiReferenceChanged, handlers } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { answerSections, searchDocs, searchForReader } from "./docs-search";
import { stillUsable } from "./operations/docs-ask";
import { createApiReference, replaceApiReference, updateApiReference } from "./operations/api-references";
import { createTab } from "./operations/docs";
import { call } from "./operations/run";

/**
 * API references' operations in the docs' search and AI answers (A14): indexed by the apiReferenceChanged job (inline
 * here) when a reference is added, replaced or what's on the help center changes, and found only where the reader may
 * read the reference's tab.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let model: ModelFake;

const SPEC = `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
paths:
  /posts:
    post:
      tags: [Posts]
      summary: Create a post
      description: Adds a feedback post to a board.
      parameters:
        - { name: board_slug, in: query, schema: { type: string } }
      responses: { "201": { description: Created } }
  /admin/purge:
    delete:
      tags: [Admin]
      summary: Purge everything
      responses: { "204": { description: Gone } }
`;

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const setTab = (access: ReadAccess) => prisma.docsTab.update({ where: { projectId_slug: { projectId: project.id, slug: "api" } }, data: { access } });
/** What a search finds for this reader, operations included, as "<method> <path under /docs>". */
const found = async (query: string, reader = SIGNED_OUT) =>
  (await searchDocs(project.id, query, 10, reader, { log: false, operations: true })).map((result) => `${result.method ?? "article"} ${result.slug}`);
const reference = () => prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: "reference" } }, select: { id: true } });

beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => Promise.all([model.embeddings.close(), model.close()]));
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  await call(createTab, as(), { name: "Guides" });
  await call(createTab, as(), { name: "API" });
  await call(createApiReference, as(), { name: "Reference", spec: SPEC, tab: "api" });
  actAs(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
});

describe("search", () => {
  test("finds an operation by its title, method, path, description and parameters, with its method, linking its page", async () => {
    const [result] = await searchDocs(project.id, "create a post", 10, SIGNED_OUT, { log: false, operations: true });
    expect(result).toEqual({ slug: "reference/create-a-post", title: "Create a post", snippet: "Adds a feedback post to a board.", method: "POST" });
    for (const query of ["feedback", "board_slug", "purge", "cre"]) {
      expect((await found(query)).length, query).toBeGreaterThan(0);
    }
    expect(await found("purge")).toEqual(["DELETE reference/purge-everything"]);
    // Not where operations aren't asked for (the widget, the API's docs.search, the inbox).
    expect(await searchDocs(project.id, "create a post", 10, SIGNED_OUT, { log: false })).toEqual([]);
  });

  test("keeps in step: hidden, shown again, replaced, unpublished and deleted", async () => {
    await call(updateApiReference, as(), { slug: "reference", hide: ["POST /posts"] });
    expect(await found("create a post")).toEqual([]);
    await call(updateApiReference, as(), { slug: "reference", show: ["POST /posts"] });
    expect(await found("create a post")).toEqual(["POST reference/create-a-post"]);
    await call(updateApiReference, as(), { slug: "reference", hideGroups: ["Admin"] });
    expect(await found("purge")).toEqual([]);
    // A new spec without it, and with another.
    await call(replaceApiReference, as(), {
      slug: "reference",
      spec: SPEC.replace("summary: Create a post", "summary: Publish a post").replace("/posts:\n    post:", "/drafts:\n    post:"),
    });
    expect(await found("create a post")).toEqual([]);
    // What a re-read adds starts off the help center while anything is hidden (Admin is): shown, it's found.
    await call(updateApiReference, as(), { slug: "reference", show: ["POST /drafts"] });
    expect(await found("publish a post")).toEqual(["POST reference/publish-a-post"]);
    await call(updateApiReference, as(), { slug: "reference", published: false });
    expect(await found("publish a post")).toEqual([]);
    await call(updateApiReference, as(), { slug: "reference", published: true });
    expect(await found("publish a post")).toEqual(["POST reference/publish-a-post"]);
    await prisma.apiReference.delete({ where: { id: (await reference()).id } });
    expect(await prisma.apiOperationEntry.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("what's hidden leaves search at once, even when indexing fails; a new base address reaches each operation's Markdown", async () => {
    const failing = vi.spyOn(handlers, "apiReferenceChanged").mockRejectedValue(new Error("the queue is down"));
    await call(updateApiReference, as(), { slug: "reference", hide: ["POST /posts"] });
    expect(await found("create a post")).toEqual([]);
    expect(failing).toHaveBeenCalled();
    failing.mockRestore();
    await call(updateApiReference, as(), { slug: "reference", show: ["POST /posts"] });
    await call(updateApiReference, as(), { slug: "reference", baseUrl: "https://api.acme.example" });
    const entry = await prisma.apiOperationEntry.findFirstOrThrow({ where: { projectId: project.id, key: "POST /posts" } });
    expect(entry.text).toContain("curl 'https://api.acme.example/posts");
  });

  test("only where the reader may read the reference's tab, as its page", async () => {
    await setTab("SIGNED_IN");
    expect(await found("create a post")).toEqual([]);
    expect(await found("create a post", { signedIn: true, groups: [] })).toEqual(["POST reference/create-a-post"]);
    await setTab("GROUPS");
    expect(await found("create a post", { signedIn: true, groups: [] })).toEqual([]);
    // The team reads everything.
    expect(await found("create a post", null)).toEqual(["POST reference/create-a-post"]);
    // In no tab: under the first one's.
    await prisma.apiReference.updateMany({ where: { projectId: project.id }, data: { tabId: null } });
    await prisma.docsTab.update({ where: { projectId_slug: { projectId: project.id, slug: "guides" } }, data: { access: "SIGNED_IN" } });
    expect(await found("create a post")).toEqual([]);
    expect(await found("create a post", { signedIn: true, groups: [] })).toEqual(["POST reference/create-a-post"]);
  });

  test("the portal's search for whoever's reading", async () => {
    expect((await searchForReader(project.id, project.slug, "create a post", 10, { log: false, operations: true })).map((r) => r.slug)).toEqual([
      "reference/create-a-post",
    ]);
    await setTab("SIGNED_IN");
    expect(await searchForReader(project.id, project.slug, "create a post", 10, { log: false, operations: true })).toEqual([]);
  });
});

describe("the indexing job", () => {
  test("when embedding fails, a new reference's operations are still found by their words", async () => {
    for (const [name, value] of Object.entries(model.env)) {
      vi.stubEnv(name, value);
    }
    model.embeddings.failNext();
    await call(createApiReference, as(), { name: "Webhooks", spec: SPEC.replace("summary: Create a post", "summary: Send a webhook"), tab: "api" });
    expect(await found("send a webhook")).toEqual(["POST webhooks/send-a-webhook"]);
    expect(await prisma.$queryRaw`SELECT count(*)::int AS n FROM api_operation_entry e JOIN api_reference r ON r.id = e."referenceId" WHERE r.slug = 'webhooks' AND e.embedding IS NULL`).toEqual([{ n: 2 }]);
  });

  test("keeps an operation's entry, and its id, across reindexes while its key is there: an answer being written cites it by that id", async () => {
    const entry = () => prisma.apiOperationEntry.findFirst({ where: { projectId: project.id, key: "POST /posts" }, select: { id: true, text: true } });
    const before = (await entry())!;
    const section = { articleId: before.id, slug: "reference/create-a-post", title: "Create a post (POST /posts)", listing: "EVERYWHERE" as const, heading: "", text: before.text, operation: true as const };
    // Its Markdown changes (a new base address), and the spec is read again.
    await call(updateApiReference, as(), { slug: "reference", baseUrl: "https://api.acme.example" });
    await call(replaceApiReference, as(), { slug: "reference", spec: SPEC.replace("Adds a feedback post", "Adds a post") });
    const after = (await entry())!;
    expect(after.id).toBe(before.id);
    expect(after.text).toContain("Adds a post to a board");
    expect(await stillUsable(project.id, [section], SIGNED_OUT)).toHaveLength(1);
  });

  test("a change that hides an operation while a job is writing waits for it, then takes the operation out", async () => {
    const { id } = await reference();
    const entry = await prisma.apiOperationEntry.findFirstOrThrow({ where: { projectId: project.id, key: "POST /posts" }, select: { id: true } });
    // Holds the job mid-write: it has the project and the reference locked and waits on this entry's row to update it.
    // The job starts only once the lock is held, and the lock goes whatever the test's outcome.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holds = new Promise<void>((resolve) => (locked = resolve));
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM api_operation_entry WHERE id = ${entry.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    const queued = vi.spyOn(handlers, "apiReferenceChanged").mockResolvedValue({ skipped: true });
    try {
      await Promise.race([holds, holding]);
      const waiting = (query: string) =>
        // Sessions of this file's own database only (each has one), and not this one: other files' workers share the server.
        prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE ${`%${query}%`}`.then(([row]) => Number(row!.n));
      const log = { info: () => {}, warn: () => {} };
      const job = apiReferenceChanged({ referenceId: id }, log);
      await expect.poll(() => waiting("INSERT INTO api_operation_entry"), { timeout: 10_000 }).toBe(1);
      // The change's own job doesn't run (the spy above): what's checked is the change's delete.
      const hide = call(updateApiReference, as(), { slug: "reference", hide: ["POST /posts"] });
      await expect.poll(() => waiting("FOR UPDATE"), { timeout: 10_000 }).toBeGreaterThan(0);
      release();
      await holding;
      expect(await job).toMatchObject({ skipped: false });
      await hide;
      expect(await found("create a post")).toEqual([]);
    } finally {
      release();
      queued.mockRestore();
      await holding.catch(() => {});
    }
  }, 30_000);

  test("writes nothing when the reference changed while it ran: the change's own job indexes it", async () => {
    for (const [name, value] of Object.entries(model.env)) {
      vi.stubEnv(name, value);
    }
    const log = { info: () => {}, warn: () => {} };
    const { id } = await reference();
    await apiReferenceChanged({ referenceId: id }, log);
    // Every operation's Markdown changes, so the next run embeds them: held there while what's hidden changes.
    await prisma.apiReference.update({ where: { id }, data: { baseUrl: "https://api.acme.example" } });
    const asked = model.embeddings.inputs.length;
    const release = model.embeddings.holdNext();
    const run = apiReferenceChanged({ referenceId: id }, log);
    await expect.poll(() => model.embeddings.inputs.length).toBeGreaterThan(asked);
    await prisma.apiReference.update({ where: { id }, data: { state: { ...((await prisma.apiReference.findUniqueOrThrow({ where: { id } })).state as object), hiddenOperations: ["POST /posts"] } } });
    release();
    expect(await run).toEqual({ skipped: true });
    // As it was before that run.
    const entry = await prisma.apiOperationEntry.findFirstOrThrow({ where: { projectId: project.id, key: "POST /posts" } });
    expect(entry.text).not.toContain("api.acme.example");
  });
});

describe("AI answers", () => {
  const QUESTION = "How do I create a post via the API?";

  test("find an operation's Markdown by meaning, with its method and path; never a hidden one or one the asker can't read", async () => {
    // Indexed without embeddings first (the server had none): words only, no vectors.
    const entry = await prisma.apiOperationEntry.findFirstOrThrow({ where: { projectId: project.id, key: "POST /posts" } });
    expect(entry.text.startsWith("# Create a post\n\n`POST /posts`\n\nAdds a feedback post to a board.")).toBe(true);
    model.embeddings.setVector(QUESTION, [1, 0]);
    model.embeddings.setVector(entry.text, [0.9, Math.sqrt(1 - 0.81)]);
    for (const [name, value] of Object.entries(model.env)) {
      vi.stubEnv(name, value);
    }
    const log = { info: () => {}, warn: () => {} };
    await apiReferenceChanged({ referenceId: (await reference()).id }, log);
    const sections = await answerSections(project.id, QUESTION, 6, SIGNED_OUT, 3000);
    expect(sections).toEqual([
      expect.objectContaining({ slug: "reference/create-a-post", title: "Create a post (POST /posts)", text: entry.text, listing: "EVERYWHERE", operation: true }),
    ]);
    expect(await stillUsable(project.id, sections!, SIGNED_OUT)).toHaveLength(1);
    // An unchanged operation isn't embedded again.
    const embedded = model.embeddings.inputs.length;
    await apiReferenceChanged({ referenceId: (await reference()).id }, log);
    expect(model.embeddings.inputs.length).toBe(embedded);

    await setTab("SIGNED_IN");
    expect(await answerSections(project.id, QUESTION, 6, SIGNED_OUT, 3000)).toEqual([]);
    // Restricted while the model wrote: no longer usable.
    expect(await stillUsable(project.id, sections!, SIGNED_OUT)).toEqual([]);
    await setTab("INHERIT");
    await call(updateApiReference, as(), { slug: "reference", hide: ["POST /posts"] });
    expect(await answerSections(project.id, QUESTION, 6, SIGNED_OUT, 3000)).toEqual([]);
    expect(await stillUsable(project.id, sections!, SIGNED_OUT)).toEqual([]);
  });
});
