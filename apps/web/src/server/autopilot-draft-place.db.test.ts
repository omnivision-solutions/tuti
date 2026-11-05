import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { docsContents } from "@/server/docs-queries";
import { applyCodeChangeAction, getCodeChangeTarget, undoCodeChangeAction } from "@/server/operations/code-changes";
import { createArticle, createCollection, deleteArticle, deleteCollection, publishArticle, updateArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Where a new article's draft goes (docs/plan.md, D5): the place on its update, shown in its review, acted on by Approve. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const CONTENT = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Pick CSV or JSON, then Export." }] }] };

let number = 0;
/** A new article's draft waiting, its payload with `place` (left out: as the previous release wrote it). */
async function draft(place?: object) {
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Exports", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  return prisma.codeChangeAction.create({
    data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title: "Export your data", content: CONTENT, body: "Pick CSV or JSON, then Export.", ...(place && { place }) } },
  });
}

/** Billing, with Invoices, Refunds and Taxes in it (in that order). */
async function billing() {
  const collection = await call(createCollection, team(), { name: "Billing" });
  const { id } = await prisma.collection.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: collection.slug } } });
  for (const title of ["Invoices", "Refunds", "Taxes"]) {
    await call(createArticle, team(), { title, body: `${title}.`, collection: "billing" });
  }
  const article = (title: string) => prisma.article.findFirstOrThrow({ where: { projectId: project.id, title }, select: { id: true, slug: true } });
  return { id, invoices: await article("Invoices"), taxes: await article("Taxes") };
}

const approve = async (id: string, input: { collection?: string | null } = {}) => ((await call(applyCodeChangeAction, team(), { id, ...input })) as { article: string }).article;
/** The titles in collection `id`, in order (null: in no collection). */
const titlesIn = async (collectionId: string | null) =>
  (await prisma.article.findMany({ where: { projectId: project.id, collectionId, deletedAt: null }, orderBy: [{ order: "asc" }, { title: "asc" }], select: { title: true } })).map((a) => a.title);
const placeOf = async (id: string) => (await call(getCodeChangeTarget, team(), { type: "articles", id })).actions[0]!.place;

test("into an existing collection, after the article it follows; the review says where", async () => {
  const { id, invoices } = await billing();
  const action = await draft({ collection: id, after: invoices.id });
  expect(await placeOf(action.id)).toEqual({
    collection: { slug: "billing", name: "Billing", icon: null },
    newCollection: null,
    afterArticle: { slug: invoices.slug, title: "Invoices" },
    first: false,
  });
  await approve(action.id);
  expect(await titlesIn(id)).toEqual(["Invoices", "Export your data", "Refunds", "Taxes"]);
  // One version, in Billing: Undo can take it back.
  await call(undoCodeChangeAction, team(), { id: action.id });
  expect(await titlesIn(id)).toEqual(["Invoices", "Refunds", "Taxes"]);
});

test("first in a collection (after: null)", async () => {
  const { id } = await billing();
  await approve((await draft({ collection: id, after: null })).id);
  expect(await titlesIn(id)).toEqual(["Export your data", "Invoices", "Refunds", "Taxes"]);
});

test("into a new collection, hidden from readers until its first article is published; Undo removes it", async () => {
  const action = await draft({ newCollection: "Exports", icon: "download" });
  expect(await placeOf(action.id)).toEqual({ collection: null, newCollection: { name: "Exports", icon: "download" }, afterArticle: null, first: false });
  await approve(action.id);
  const exports = await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, name: "Exports" }, select: { id: true, icon: true } });
  expect(exports.icon).toBe("download");
  expect(await titlesIn(exports.id)).toEqual(["Export your data"]);
  // Only a draft in it: readers don't see it.
  expect(JSON.stringify(await docsContents(project.slug))).not.toContain("Exports");
  await call(undoCodeChangeAction, team(), { id: action.id });
  expect(await prisma.collection.count({ where: { projectId: project.id, name: "Exports" } })).toBe(0);

  // Approved again (another pull request's), and published: there it is.
  const again = await draft({ newCollection: "Exports", icon: "download" });
  await call(publishArticle, team(), { slug: await approve(again.id) });
  expect(JSON.stringify(await docsContents(project.slug))).toContain("Exports");
});

test("a new collection someone made meanwhile under that name is used; Undo leaves a collection with something else in it", async () => {
  const first = await draft({ newCollection: "Exports", icon: null });
  const second = await draft({ newCollection: "exports", icon: null });
  await approve(first.id);
  await approve(second.id);
  expect(await prisma.collection.count({ where: { projectId: project.id, name: { equals: "exports", mode: "insensitive" } } })).toBe(1);
  // The second one's draft is still in it: the collection stays.
  await call(undoCodeChangeAction, team(), { id: first.id });
  expect(await prisma.collection.count({ where: { projectId: project.id, name: "Exports" } })).toBe(1);
});

test("two approvals at once that both miss the other's new collection end with one: the older stays, the newer goes", async () => {
  const first = await draft({ newCollection: "Exports", icon: null });
  const second = await draft({ newCollection: "Exports", icon: null });
  await approve(first.id);
  // The second's lookup runs before the first's collection exists, as when both approve at once.
  const findFirst = prisma.collection.findFirst.bind(prisma.collection);
  vi.spyOn(prisma.collection, "findFirst").mockImplementationOnce((() => Promise.resolve(null)) as never).mockImplementation(findFirst as never);
  await approve(second.id);
  vi.restoreAllMocks();
  const exports = await prisma.collection.findMany({ where: { projectId: project.id, name: "Exports" }, select: { id: true, _count: { select: { articles: true } } } });
  expect(exports).toEqual([{ id: expect.any(String) as string, _count: { articles: 2 } }]);
});

test("Undo leaves the collection it made while a published article's unpublished changes move it there", async () => {
  const action = await draft({ newCollection: "Exports", icon: null });
  await approve(action.id);
  const { slug } = await call(createArticle, team(), { title: "Old exports", body: "Old." });
  await call(publishArticle, team(), { slug });
  await call(updateArticle, team(), { slug, collection: "exports" });
  expect(await prisma.articleChanges.count({ where: { collection: { name: "Exports" } } })).toBe(1);
  await call(undoCodeChangeAction, team(), { id: action.id });
  expect(await prisma.collection.count({ where: { projectId: project.id, name: "Exports" } })).toBe(1);
});

test("an icon Lucide doesn't have: the collection is made without it", async () => {
  await approve((await draft({ newCollection: "Exports", icon: "no-such-icon" })).id);
  expect(await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, name: "Exports" }, select: { icon: true } })).toEqual({ icon: null });
});

test("deleted since: the collection, then no collection; the article it follows, then last; neither fails the approval", async () => {
  const { id, invoices } = await billing();
  const gone = await draft({ collection: id, after: invoices.id });
  const moved = await draft({ collection: id, after: invoices.id });
  await call(deleteArticle, team(), { slug: invoices.slug });
  expect((await placeOf(moved.id))?.afterArticle).toBeNull();
  await approve(moved.id);
  expect(await titlesIn(id)).toEqual(["Refunds", "Taxes", "Export your data"]);

  await call(deleteCollection, team(), { slug: "billing" });
  expect(await placeOf(gone.id)).toBeNull();
  const slug = await approve(gone.id);
  expect(await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug, deletedAt: null }, select: { collectionId: true } })).toEqual({ collectionId: null });
});

test("the team's pick: another collection (last there), or none; one that isn't there is refused, still waiting", async () => {
  const { id, taxes } = await billing();
  await call(createCollection, team(), { name: "Guides" });
  const guides = await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug: "guides" }, select: { id: true } });
  await call(createArticle, team(), { title: "Start here", body: "Hello.", collection: "guides" });

  const picked = await draft({ collection: id, after: null });
  await approve(picked.id, { collection: "guides" });
  expect(await titlesIn(guides.id)).toEqual(["Start here", "Export your data"]);

  const none = await draft({ newCollection: "Exports", icon: null });
  await approve(none.id, { collection: null });
  expect(await titlesIn(null)).toEqual(["Export your data"]);
  expect(await prisma.collection.count({ where: { projectId: project.id, name: "Exports" } })).toBe(0);

  const refused = await draft({ collection: id, after: taxes.id });
  await expect(call(applyCodeChangeAction, team(), { id: refused.id, collection: "nowhere" })).rejects.toThrow("There's no collection “nowhere”");
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: refused.id } })).status).toBe("PENDING");
});

test("a draft from before places (no place): in no collection, as before", async () => {
  await billing();
  const action = await draft();
  expect(await placeOf(action.id)).toBeNull();
  const slug = await approve(action.id);
  expect(await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { collectionId: true } })).toEqual({ collectionId: null });
});

test("a failure finding its place leaves it waiting, nothing saved", async () => {
  const { id } = await billing();
  const action = await draft({ collection: id, after: null });
  vi.spyOn(prisma.collection, "findFirst").mockRejectedValueOnce(new Error("database blip"));
  await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("database blip");
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
  expect(await prisma.article.count({ where: { projectId: project.id, title: "Export your data" } })).toBe(0);
});
