import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { collectionOptions, docsContents } from "./docs-queries";
import {
  createArticle,
  createCollection,
  deleteCollection,
  getArticle,
  listArticles,
  listCollections,
  listRevisions,
  publishArticle,
  publishChanges,
  reorderArticle,
  reorderCollection,
  updateArticle,
  updateCollection,
} from "./operations/docs";
import { call } from "./operations/run";

/**
 * The docs' structure: collections in collections (2 levels deep at most), articles in
 * order in their collection, moved one at a time under the project's lock, and every reader
 * following that order.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const tree = async () => (await call(listCollections, as(), {})).collections.map((c) => `${c.parent ? `${c.parent}/` : ""}${c.slug}`);
const articlesIn = async (collection: string | null) =>
  (
    await prisma.article.findMany({
      where: { projectId: project.id, deletedAt: null, collection: collection === null ? null : { slug: collection } },
      orderBy: [{ order: "asc" }, { title: "asc" }],
      select: { slug: true, order: true },
    })
  ).map((a) => a.slug);

async function published(title: string, collection: string | null) {
  const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
  await call(publishArticle, as(), { slug });
  return slug;
}

describe("nested collections", () => {
  test("a collection goes in a top-level one, listed after it; 2 levels deep at most, and never in itself", async () => {
    for (const name of ["Basics", "Billing"]) {
      await call(createCollection, as(), { name });
    }
    expect(await call(createCollection, as(), { name: "Invoices", parent: "billing" })).toMatchObject({ parent: "billing", order: 0 });
    await call(createCollection, as(), { name: "Refunds", parent: "billing" });
    expect(await tree()).toEqual(["basics", "billing", "billing/invoices", "billing/refunds"]);
    // The editor's picker names a collection in another with it.
    expect((await collectionOptions(project.id)).map((c) => c.name)).toEqual(["Basics", "Billing", "Billing › Invoices", "Billing › Refunds"]);

    const refused = { status: 400, code: "invalid_input" };
    // A third level: in a collection that's in another.
    await expect(call(createCollection, as(), { name: "Taxes", parent: "invoices" })).rejects.toMatchObject({
      ...refused,
      message: "Collections go 2 levels deep at most, and “Invoices” is inside another",
    });
    await expect(call(reorderCollection, as(), { slug: "basics", parent: "invoices" })).rejects.toMatchObject(refused);
    // A collection with some in it can't go in another (that's 3 levels, and the way to a cycle: Billing in Invoices).
    await expect(call(reorderCollection, as(), { slug: "billing", parent: "basics" })).rejects.toMatchObject({
      ...refused,
      message: "Collections go 2 levels deep at most, and “Billing” has collections in it",
    });
    await expect(call(updateCollection, as(), { slug: "billing", parent: "invoices" })).rejects.toMatchObject(refused);
    await expect(call(reorderCollection, as(), { slug: "basics", parent: "basics" })).rejects.toMatchObject({
      ...refused,
      message: "A collection can't go inside itself",
    });
    // Another project's collection isn't one to go in.
    const other = await createProject(owner);
    await call(createCollection, as(other.id), { name: "Elsewhere" });
    await expect(call(reorderCollection, as(), { slug: "basics", parent: "elsewhere" })).rejects.toMatchObject({
      ...refused,
      message: "There's no collection “elsewhere”",
    });
    await expect(call(reorderCollection, as(other.id), { slug: "basics", parent: null })).rejects.toMatchObject({ status: 404 });
    // Nothing moved.
    expect(await tree()).toEqual(["basics", "billing", "billing/invoices", "billing/refunds"]);

    // collections.update moves one in (last there) and out (last at the top level).
    expect(await call(updateCollection, as(), { slug: "basics", parent: "billing" })).toMatchObject({ parent: "billing" });
    expect(await tree()).toEqual(["billing", "billing/invoices", "billing/refunds", "billing/basics"]);
    await call(updateCollection, as(), { slug: "invoices", parent: null });
    expect(await tree()).toEqual(["billing", "billing/refunds", "billing/basics", "invoices"]);
    // Saving it where it is keeps its place.
    await call(updateCollection, as(), { slug: "refunds", parent: "billing", name: "Refunds" });
    expect(await tree()).toEqual(["billing", "billing/refunds", "billing/basics", "invoices"]);
  });

  test("deleting a collection moves the ones in it up a level, in its place, and keeps its articles", async () => {
    for (const [name, parent] of [["Basics", null], ["Billing", null], ["Invoices", "billing"], ["Refunds", "billing"], ["Account", null]] as const) {
      await call(createCollection, as(), { name, parent });
    }
    const article = await published("Paying by card", "billing");
    await published("Getting a refund", "refunds");

    await call(deleteCollection, as(), { slug: "billing" });
    expect(await tree()).toEqual(["basics", "invoices", "refunds", "account"]);
    expect(await call(getArticle, as(), { slug: article })).toMatchObject({ collection: null });
    expect(await call(getArticle, as(), { slug: "getting-a-refund" })).toMatchObject({ collection: { slug: "refunds" } });
    // Its articles went last among those in no collection, in their order.
    await call(createCollection, as(), { name: "Guides" });
    for (const title of ["Zebra crossings", "Apples"]) {
      await published(title, "guides");
    }
    await published("Mangoes", null);
    await call(deleteCollection, as(), { slug: "guides" });
    expect(await articlesIn(null)).toEqual([article, "mangoes", "zebra-crossings", "apples"]);
    // The order numbers are the new places, so moving one later lands where it says.
    expect((await prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { order: "asc" } })).map((c) => c.order)).toEqual([0, 1, 2, 3]);
  });
});

describe("order", () => {
  test("articles go last in their collection and move to a place, within it or into another", async () => {
    await call(createCollection, as(), { name: "Basics" });
    await call(createCollection, as(), { name: "Billing" });
    // Not by title: in the order they came.
    for (const title of ["Zebra crossings", "Apples", "Mangoes"]) {
      await published(title, "basics");
    }
    expect(await articlesIn("basics")).toEqual(["zebra-crossings", "apples", "mangoes"]);

    await call(reorderArticle, as(), { slug: "mangoes", position: 0 });
    expect(await articlesIn("basics")).toEqual(["mangoes", "zebra-crossings", "apples"]);
    // Past the end, or no position: last.
    await call(reorderArticle, as(), { slug: "mangoes", position: 99 });
    expect(await articlesIn("basics")).toEqual(["zebra-crossings", "apples", "mangoes"]);

    await published("Invoices", "billing");
    expect(await call(reorderArticle, as(), { slug: "apples", collection: "billing", position: 0 })).toMatchObject({
      collection: { slug: "billing" },
      order: 0,
    });
    expect(await articlesIn("billing")).toEqual(["apples", "invoices"]);
    expect(await articlesIn("basics")).toEqual(["zebra-crossings", "mangoes"]);
    await call(reorderArticle, as(), { slug: "invoices", collection: null });
    expect(await articlesIn(null)).toEqual(["invoices"]);
    // Saving an article into another collection puts it last there.
    await call(updateArticle, as(), { slug: "zebra-crossings", collection: "billing", publish: true });
    expect(await articlesIn("billing")).toEqual(["apples", "zebra-crossings"]);

    // Another project's collection, or article, can't be reached.
    const other = await createProject(owner);
    await call(createCollection, as(other.id), { name: "Elsewhere" });
    await expect(call(reorderArticle, as(), { slug: "apples", collection: "elsewhere" })).rejects.toMatchObject({ status: 400 });
    await expect(call(reorderArticle, as(other.id), { slug: "apples", position: 0 })).rejects.toMatchObject({ status: 404 });
    expect(await articlesIn("billing")).toEqual(["apples", "zebra-crossings"]);
  });

  test("moving a published article with unpublished changes goes live, and publishing the changes doesn't move it back", async () => {
    await call(createCollection, as(), { name: "Basics" });
    await call(createCollection, as(), { name: "Billing" });
    const slug = await published("Paying by card", "basics");
    await call(updateArticle, as(), { slug, body: "Cards and wallets." });

    await call(reorderArticle, as(), { slug, collection: "billing" });
    const moved = await call(getArticle, as(), { slug });
    expect(moved.collection).toMatchObject({ slug: "billing" });
    expect(moved.changes).toMatchObject({ body: "Cards and wallets.", collection: { slug: "billing" } });
    // The move is a version, with the text as last saved.
    const [newest] = (await call(listRevisions, as(), { slug })).revisions;
    expect(newest).toMatchObject({ body: "Cards and wallets.", collection: { slug: "billing" } });

    await call(publishChanges, as(), { slug });
    expect(await call(getArticle, as(), { slug })).toMatchObject({ body: "Cards and wallets.", collection: { slug: "billing" }, changes: null });
    // Moving it within its collection is no version.
    const versions = (await call(listRevisions, as(), { slug })).revisions.length;
    await call(reorderArticle, as(), { slug, position: 0 });
    expect((await call(listRevisions, as(), { slug })).revisions).toHaveLength(versions);
  });

  test("moves at the same time land one after the other: every place is taken once", async () => {
    await call(createCollection, as(), { name: "Basics" });
    const slugs = [];
    for (const title of ["One", "Two", "Three", "Four", "Five"]) {
      slugs.push(await published(title, "basics"));
    }
    for (const name of ["A", "B", "C", "D"]) {
      await call(createCollection, as(), { name });
    }
    await Promise.all([
      call(reorderArticle, as(), { slug: "five", position: 0 }),
      call(reorderArticle, as(), { slug: "one", position: 4 }),
      call(reorderArticle, as(), { slug: "three", position: 0 }),
      call(reorderCollection, as(), { slug: "d", position: 0 }),
      call(reorderCollection, as(), { slug: "basics", position: 4 }),
      call(reorderCollection, as(), { slug: "b", parent: "a" }),
    ]);
    const orders = await prisma.article.findMany({ where: { projectId: project.id }, select: { order: true } });
    expect(orders.map((a) => a.order).sort()).toEqual([0, 1, 2, 3, 4]);
    expect((await articlesIn("basics")).sort()).toEqual([...slugs].sort());
    // B left a gap at the top level (when it went in A); no two have the same place.
    const top = await prisma.collection.findMany({ where: { projectId: project.id, parentId: null }, select: { order: true } });
    expect(new Set(top.map((c) => c.order)).size).toBe(4);
    expect(await tree()).toContain("a/b");
  });
});

describe("readers", () => {
  test("/docs, the widget, llms.txt and the API list collections and articles in the team's order, nested", async () => {
    for (const [name, parent] of [["Basics", null], ["Billing", null], ["Invoices", "billing"], ["Empty", "billing"]] as const) {
      await call(createCollection, as(), { name, parent });
    }
    await published("Your first board", "basics");
    await published("Inviting your team", "basics");
    await published("Card payments", "billing");
    await published("Downloading invoices", "invoices");
    await call(createArticle, as(), { title: "A draft", collection: "invoices" });
    await call(reorderCollection, as(), { slug: "billing", position: 0 });
    await call(reorderArticle, as(), { slug: "inviting-your-team", position: 0 });

    const link = (slug: string, title: string) => ({ slug, title });
    expect(await docsContents(project.slug)).toEqual({
      collections: [
        {
          slug: "billing",
          name: "Billing",
          description: "",
          icon: null,
          articles: [link("card-payments", "Card payments")],
          // Collections without published articles are left out.
          collections: [{ slug: "invoices", name: "Invoices", description: "", icon: null, articles: [link("downloading-invoices", "Downloading invoices")], collections: [] }],
        },
        {
          slug: "basics",
          name: "Basics",
          description: "",
          icon: null,
          articles: [link("inviting-your-team", "Inviting your team"), link("your-first-board", "Your first board")],
          collections: [],
        },
      ],
      uncollected: [],
      // No tabs: one page.
      tabs: [],
      home: null,
    });

    const portal = `http://${project.slug}.localhost:3100`;
    const text = await (await llms(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
    expect(text).toContain(
      [
        `## [Billing](${portal}/docs/billing)`,
        `- [Card payments](${portal}/docs/card-payments.md)`,
        `### [Invoices](${portal}/docs/invoices)`,
        `- [Downloading invoices](${portal}/docs/downloading-invoices.md)`,
        `## [Basics](${portal}/docs/basics)`,
        `- [Inviting your team](${portal}/docs/inviting-your-team.md)\n- [Your first board](${portal}/docs/your-first-board.md)`,
        "## Changelog",
      ].join("\n\n"),
    );

    // The API: collections in reading order with their parent, articles with their place.
    expect((await call(listCollections, as(), {})).collections).toMatchObject([
      { slug: "billing", parent: null, order: 0 },
      { slug: "invoices", parent: "billing", order: 0 },
      { slug: "empty", parent: "billing", order: 1 },
      { slug: "basics", parent: null, order: 1 },
    ]);
    const { articles } = await call(listArticles, as(), {});
    expect(articles.find((a) => a.slug === "inviting-your-team")).toMatchObject({ order: 0, collection: { slug: "basics" } });
  });
});
