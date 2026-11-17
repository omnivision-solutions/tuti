import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import {
  createApiReference,
  deleteApiReference,
  getApiReference,
  listApiReferences,
  replaceApiReference,
  updateApiReference,
} from "./operations/api-references";
import { createArticle, createCollection, createTab, deleteTab, updateArticle, updateCollection, updateTab } from "./operations/docs";
import { call } from "./operations/run";

/**
 * API references in the docs: a spec's text becomes a reference with a page per operation, the
 * team's choices about them survive a new spec, and its name is one of the docs' addresses.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const refused = { status: 400, code: "invalid_input" };

/** An OpenAPI spec: each operation as "GET /posts" with its tag and summary; every response is a Post. */
function spec(operations: Record<string, [tag: string, summary: string]>, version = "1") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, [tag, summary]] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = {
      tags: [tag],
      summary,
      responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Post" } } } } },
    };
  }
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Acme API", version },
    paths,
    components: { schemas: { Post: { type: "object", properties: { title: { type: "string" } } } } },
  });
}

const POSTS = spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "DELETE /posts": ["Admin", "Delete every post"] });
const add = (name = "API reference", text = POSTS, tab?: string) => call(createApiReference, as(), { name, spec: text, tab });
const get = (slug = "api-reference") => call(getApiReference, as(), { slug });
/** Each operation as the team sees it: "key slug", with "off" when it isn't on the help center and "new" when a read added it. */
const operations = async (slug = "api-reference") =>
  (await get(slug)).operations.map((o) => [o.key, o.slug, ...(o.onHelpCenter ? [] : ["off"]), ...(o.new ? ["new"] : [])].join(" "));
const stored = (slug = "api-reference") => prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug } } });

describe("adding and reading", () => {
  test("a spec's text becomes a published reference with its operations, groups and types", async () => {
    expect(await add()).toMatchObject({
      slug: "api-reference",
      name: "API reference",
      tab: null,
      format: "openapi",
      source: "upload",
      treeStyle: "folders",
      baseUrl: null,
      counts: { operations: 3, onHelpCenter: 3, new: 0 },
      published: true,
      syncError: null,
    });
    const reference = await get();
    expect(reference).toMatchObject({ title: "Acme API", version: "1", groupOrder: ["Posts", "Admin"], warnings: [] });
    expect(reference.groups.map((g) => `${g.key} ${g.onHelpCenter}`)).toEqual(["Posts true", "Admin true"]);
    expect(reference.operations[0]).toEqual({
      key: "GET /posts",
      slug: "list-posts",
      title: "List posts",
      kind: "GET",
      path: "/posts",
      group: "Posts",
      alsoIn: [],
      deprecated: false,
      onHelpCenter: true,
      new: false,
    });
    expect(reference.types).toEqual([{ name: "Post", slug: "post", kind: "object", onHelpCenter: true }]);
    expect(reference).not.toHaveProperty("spec");
    expect((await call(getApiReference, as(), { slug: "api-reference", spec: true })).spec).toBe(POSTS);
  });

  test("a GraphQL schema is read too", async () => {
    expect(await add("Graph", "type Query {\n  posts: [String]\n}\n")).toMatchObject({ slug: "graph", format: "graphql", counts: { operations: 1 } });
    expect(await operations("graph")).toEqual(["query posts posts"]);
  });

  test("the list has every reference in order, and never a spec or what it read into", async () => {
    await add("First");
    await add("Second");
    const { apiReferences } = await call(listApiReferences, as(), {});
    expect(apiReferences.map((r) => r.slug)).toEqual(["first", "second"]);
    expect(apiReferences[0]).not.toHaveProperty("spec");
    expect(apiReferences[0]).not.toHaveProperty("doc");
    expect(apiReferences[0]).not.toHaveProperty("state");
    expect(JSON.stringify(apiReferences)).not.toContain("List posts");
  });

  test("a spec that can't be read, or has no operations, adds nothing", async () => {
    await expect(add("Broken", "{ nope")).rejects.toMatchObject(refused);
    await expect(add("Package", JSON.stringify({ name: "package" }))).rejects.toMatchObject({ ...refused, message: expect.stringContaining("isn't an OpenAPI spec") });
    await expect(add("Empty", spec({}))).rejects.toMatchObject({ ...refused, message: "This spec has no operations to show." });
    await expect(add("Null", POSTS.replace("List posts", "List\\u0000posts"))).rejects.toMatchObject({ ...refused, message: expect.stringContaining("null character") });
    await expect(add("Big", "x".repeat(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ ...refused, message: expect.stringContaining("5 MB") });
    expect(await prisma.apiReference.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("another project's reference isn't found", async () => {
    await add();
    const other = as((await createProject(owner)).id);
    expect((await call(listApiReferences, other, {})).apiReferences).toEqual([]);
    const missing = { status: 404, code: "not_found" };
    await expect(call(getApiReference, other, { slug: "api-reference" })).rejects.toMatchObject(missing);
    await expect(call(updateApiReference, other, { slug: "api-reference", name: "Theirs" })).rejects.toMatchObject(missing);
    await expect(call(replaceApiReference, other, { slug: "api-reference", spec: POSTS })).rejects.toMatchObject(missing);
    await expect(call(deleteApiReference, other, { slug: "api-reference" })).rejects.toMatchObject(missing);
    expect(await stored()).toMatchObject({ name: "API reference" });
  });

  test("deleting one frees its address", async () => {
    await add();
    expect(await call(deleteApiReference, as(), { slug: "api-reference" })).toEqual({ deleted: "api-reference" });
    await expect(get()).rejects.toMatchObject({ status: 404 });
    expect(await add()).toMatchObject({ slug: "api-reference" });
  });
});

describe("one name per /docs/<slug>", () => {
  test("a reference never takes a tab's, a collection's, an article's or another reference's", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createCollection, as(), { name: "Billing" });
    await call(createArticle, as(), { title: "Webhooks", body: "Read me" });
    expect((await add("Guides")).slug).toBe("guides-2");
    expect((await add("Billing")).slug).toBe("billing-2");
    expect((await add("Webhooks")).slug).toBe("webhooks-2");
    expect((await add("Webhooks")).slug).toBe("webhooks-3");

    for (const [taken, by] of [
      ["guides", "the tab “Guides”"],
      ["billing", "the collection “Billing”"],
      ["webhooks", "the article “Webhooks”"],
      ["guides-2", "the API reference “Guides”"],
    ]) {
      await expect(call(updateApiReference, as(), { slug: "webhooks-3", newSlug: taken })).rejects.toMatchObject({
        status: 409,
        message: `That address is taken by ${by}`,
      });
    }
    expect((await call(updateApiReference, as(), { slug: "webhooks-3", newSlug: "api" })).slug).toBe("api");
  });

  test("a tab, a collection and an article never take a reference's", async () => {
    await add("Guides");
    expect((await call(createTab, as(), { name: "Guides" })).slug).toBe("guides-2");
    expect((await call(createCollection, as(), { name: "Guides" })).slug).toBe("guides-3");
    expect((await call(createArticle, as(), { title: "Guides", body: "Read me" })).slug).toBe("guides-4");

    await add("Reference");
    expect((await call(updateTab, as(), { slug: "guides-2", name: "Reference" })).slug).toBe("reference-2");
    expect((await call(updateCollection, as(), { slug: "guides-3", name: "Reference" })).slug).toBe("reference-3");
    await expect(call(updateArticle, as(), { slug: "guides-4", newSlug: "reference" })).rejects.toMatchObject({
      status: 409,
      message: "That address is taken by the API reference “Reference”",
    });
  });

  test("renaming a reference keeps its address, and a new one leaves no redirect; a redirect's slug is free to take", async () => {
    await add();
    expect(await call(updateApiReference, as(), { slug: "api-reference", name: "Public API" })).toMatchObject({ slug: "api-reference", name: "Public API" });
    expect(await call(updateApiReference, as(), { slug: "api-reference", newSlug: "public-api" })).toMatchObject({ slug: "public-api" });
    expect(await prisma.docsRedirect.count({ where: { projectId: project.id } })).toBe(0);

    // A renamed collection leaves a redirect at its old address, which a reference takes like any page.
    await call(createCollection, as(), { name: "Endpoints" });
    await call(updateCollection, as(), { slug: "endpoints", name: "Guides" });
    expect(await prisma.docsRedirect.count({ where: { projectId: project.id, slug: "endpoints" } })).toBe(1);
    expect((await add("Endpoints")).slug).toBe("endpoints");
    expect(await prisma.docsRedirect.count({ where: { projectId: project.id } })).toBe(0);
  });
});

describe("the team's choices", () => {
  test("hiding operations and groups, the groups' order, the tree's style, where requests go and publishing", async () => {
    await add();
    expect(await call(updateApiReference, as(), { slug: "api-reference", hide: ["POST /posts"], hideGroups: ["Admin"] })).toMatchObject({
      counts: { operations: 3, onHelpCenter: 1 },
    });
    expect(await operations()).toEqual(["GET /posts list-posts", "POST /posts create-a-post off", "DELETE /posts delete-every-post off"]);
    expect((await get()).groups.map((g) => `${g.key} ${g.onHelpCenter}`)).toEqual(["Posts true", "Admin false"]);
    // Nothing on the help center uses the type through a hidden operation alone.
    await call(updateApiReference, as(), { slug: "api-reference", hide: ["GET /posts"] });
    expect((await get()).types).toEqual([{ name: "Post", slug: "post", kind: "object", onHelpCenter: false }]);
    expect(await call(updateApiReference, as(), { slug: "api-reference", show: ["GET /posts", "POST /posts"], showGroups: ["Admin"] })).toMatchObject({
      counts: { onHelpCenter: 3 },
    });

    const changed = await call(updateApiReference, as(), {
      slug: "api-reference",
      groupOrder: ["Admin"],
      treeStyle: "headings",
      baseUrl: "https://api.example.com/v1",
      published: false,
    });
    expect(changed).toMatchObject({ treeStyle: "headings", baseUrl: "https://api.example.com/v1", published: false });
    expect((await get()).groups.map((g) => g.key)).toEqual(["Admin", "Posts"]);
    expect(await call(updateApiReference, as(), { slug: "api-reference", baseUrl: null, published: true })).toMatchObject({ baseUrl: null, published: true });
  });

  test("a key the reference doesn't have, or an address that isn't one, is refused and changes nothing", async () => {
    await add();
    const before = await stored();
    for (const input of [{ hide: ["GET /nope"] }, { show: ["GET /nope"] }, { hideGroups: ["Nope"] }, { showGroups: ["Nope"] }, { groupOrder: ["Posts", "Nope"] }]) {
      await expect(call(updateApiReference, as(), { slug: "api-reference", ...input })).rejects.toMatchObject(refused);
    }
    await expect(call(updateApiReference, as(), { slug: "api-reference", hide: ["GET /nope"] })).rejects.toMatchObject({
      message: "This reference has no operation “GET /nope”",
    });
    for (const baseUrl of ["api.example.com", "ftp://api.example.com", "javascript:alert(1)"]) {
      await expect(call(updateApiReference, as(), { slug: "api-reference", baseUrl })).rejects.toMatchObject(refused);
    }
    await expect(call(updateApiReference, as(), { slug: "api-reference", tab: "nope" })).rejects.toMatchObject(refused);
    expect(await stored()).toEqual(before);
  });
});

describe("a new spec", () => {
  test("pages keep their addresses, and what it adds is new and on the help center while nothing is hidden", async () => {
    await add();
    const first = await stored();
    // The same spec again: read, and nothing changed.
    await call(replaceApiReference, as(), { slug: "api-reference", spec: POSTS });
    const same = await stored();
    expect(same.changedAt).toEqual(first.changedAt);
    expect(same.syncedAt.getTime()).toBeGreaterThanOrEqual(first.syncedAt.getTime());

    const next = spec({
      // A new one proposing the address "list-posts", before the one that has it; that one reworded.
      "GET /v2/posts": ["Posts", "List posts"],
      "GET /posts": ["Posts", "List all the posts"],
      "DELETE /posts": ["Admin", "Delete every post"],
    }, "2");
    expect(await call(replaceApiReference, as(), { slug: "api-reference", spec: next })).toMatchObject({ counts: { operations: 3, onHelpCenter: 3, new: 1 } });
    expect(await operations()).toEqual(["GET /v2/posts list-posts-2 new", "GET /posts list-posts", "DELETE /posts delete-every-post"]);
    expect(await get()).toMatchObject({ version: "2", types: [{ name: "Post", slug: "post" }] });
    const replaced = await stored();
    expect(replaced.spec).toBe(next);
    expect(replaced.changedAt.getTime()).toBeGreaterThan(first.changedAt.getTime());

    // Looked at: nothing is new. An operation that comes back has its address again.
    expect(await call(updateApiReference, as(), { slug: "api-reference", seen: true })).toMatchObject({ counts: { new: 0 } });
    await call(replaceApiReference, as(), { slug: "api-reference", spec: POSTS });
    expect(await operations()).toEqual(["GET /posts list-posts", "POST /posts create-a-post new", "DELETE /posts delete-every-post"]);
  });

  test("once something is hidden, a renamed tag and a moved path start off the help center", async () => {
    await add();
    await call(updateApiReference, as(), { slug: "api-reference", hideGroups: ["Admin"] });
    const next = spec({
      "GET /posts": ["Posts", "List posts"],
      "POST /posts": ["Posts", "Create a post"],
      "DELETE /internal/posts": ["Internal", "Delete every post"],
      "GET /internal/audit": ["Internal", "Read the audit log"],
    });
    expect(await call(replaceApiReference, as(), { slug: "api-reference", spec: next })).toMatchObject({ counts: { operations: 4, onHelpCenter: 2, new: 2 } });
    expect(await operations()).toEqual([
      "GET /posts list-posts",
      "POST /posts create-a-post",
      "DELETE /internal/posts delete-every-post-2 off new",
      "GET /internal/audit read-the-audit-log off new",
    ]);
    // The team switches one on.
    await call(updateApiReference, as(), { slug: "api-reference", show: ["GET /internal/audit"], seen: true });
    expect(await operations()).toEqual([
      "GET /posts list-posts",
      "POST /posts create-a-post",
      "DELETE /internal/posts delete-every-post-2 off",
      "GET /internal/audit read-the-audit-log",
    ]);
  });

  test("one that can't be read, or has no operations, changes nothing; nor does one for a reference that isn't uploaded", async () => {
    await add();
    const before = await stored();
    await expect(call(replaceApiReference, as(), { slug: "api-reference", spec: "{ nope" })).rejects.toMatchObject(refused);
    await expect(call(replaceApiReference, as(), { slug: "api-reference", spec: spec({}) })).rejects.toMatchObject({
      ...refused,
      message: "This spec has no operations to show.",
    });
    expect(await stored()).toEqual(before);

    await prisma.apiReference.update({ where: { id: before.id }, data: { source: "URL", sourceUrl: "https://example.com/openapi.json" } });
    await expect(call(replaceApiReference, as(), { slug: "api-reference", spec: POSTS })).rejects.toMatchObject({ status: 409, code: "not_uploaded" });
  });
});

describe("tabs", () => {
  const places = async () => (await call(listApiReferences, as(), {})).apiReferences.map((r) => `${r.tab ?? "-"}:${r.slug}${r.published ? "" : " (draft)"}`);

  test("a reference goes in the first tab or the one named, and the first tab takes the ones there are", async () => {
    await add("Before tabs");
    expect(await places()).toEqual(["-:before-tabs"]);
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "Developers" });
    expect(await places()).toEqual(["guides:before-tabs"]);

    await add("REST");
    await add("Graph", POSTS, "developers");
    await expect(add("Nowhere", POSTS, "nope")).rejects.toMatchObject({ ...refused, message: "There's no tab “nope”" });
    expect(await places()).toEqual(["guides:before-tabs", "guides:rest", "developers:graph"]);

    // Moved: last in its new tab.
    expect(await call(updateApiReference, as(), { slug: "before-tabs", tab: "developers" })).toMatchObject({ tab: "developers" });
    expect(await places()).toEqual(["guides:rest", "developers:graph", "developers:before-tabs"]);
  });

  test("deleting a tab moves its references last into the one before it, like its collections", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "Developers" });
    await add("Stays");
    await add("REST", POSTS, "developers");
    await add("Graph", POSTS, "developers");

    expect(await call(deleteTab, as(), { slug: "developers" })).toEqual({ deleted: "developers", movedTo: "guides" });
    expect(await places()).toEqual(["guides:stays", "guides:rest", "guides:graph"]);
    expect(await call(deleteTab, as(), { slug: "guides" })).toEqual({ deleted: "guides", movedTo: null });
    expect(await places()).toEqual(["-:stays", "-:rest", "-:graph"]);
  });

  test("a reference in a tab not everyone can read becomes a draft when the tab is deleted: the move opens nothing", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "Partners", access: "signed_in" });
    await add("Partner API", POSTS, "partners");
    await call(deleteTab, as(), { slug: "partners" });
    expect(await places()).toEqual(["guides:partner-api (draft)"]);
  });
});
