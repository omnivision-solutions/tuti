import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle,
  publishArticle,
  restoreArticle,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { call } from "./operations/run";

/** One name per page under /docs: a tab, a collection and an article can't share a slug in a project. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });

describe("a new slug is one no tab, collection or article has", () => {
  test("a tab named like an article, a collection named like a tab, an article titled like a collection", async () => {
    await call(createArticle, as(), { title: "Billing" });
    expect(await call(createTab, as(), { name: "Billing" })).toMatchObject({ slug: "billing-2" });
    expect(await call(createCollection, as(), { name: "Billing" })).toMatchObject({ slug: "billing-3" });

    expect(await call(createTab, as(), { name: "Guides" })).toMatchObject({ slug: "guides" });
    expect(await call(createCollection, as(), { name: "Guides" })).toMatchObject({ slug: "guides-2" });
    expect(await call(createArticle, as(), { title: "Guides" })).toMatchObject({ slug: "guides-3" });

    // "new", "insights" and "api" are only kept from articles (the team's article pages, the API reference).
    expect(await call(createTab, as(), { name: "API" })).toMatchObject({ slug: "api" });
    // Another project's names are its own.
    const other = await createProject(owner);
    expect(await call(createTab, as(other.id), { name: "Billing" })).toMatchObject({ slug: "billing" });
  });

  test("renaming into a clash takes the next free one; keeping the name keeps the slug", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(createCollection, as(), { name: "Basics" });
    await call(createTab, as(), { name: "Guides" });

    expect(await call(updateTab, as(), { slug: "guides", name: "Basics" })).toMatchObject({ slug: "basics-2" });
    expect(await call(updateTab, as(), { slug: "basics-2", name: "Basics" })).toMatchObject({ slug: "basics-2" });
    expect(await call(updateCollection, as(), { slug: "basics", name: "Billing" })).toMatchObject({ slug: "billing-2" });
    // A draft's slug follows its title, past the tab's and the collection's.
    await call(createArticle, as(), { title: "Draft" });
    expect(await call(updateArticle, as(), { slug: "draft", title: "Basics" })).toMatchObject({ slug: "basics" });
    expect(await call(updateArticle, as(), { slug: "basics", title: "Billing" })).toMatchObject({ slug: "billing-3" });
    // A published article keeps its slug, whatever its title.
    await call(publishArticle, as(), { slug: "billing" });
    expect(await call(updateArticle, as(), { slug: "billing", title: "Guides", publish: true })).toMatchObject({ slug: "billing" });
  });

  test("a deleted article restored after a collection took its slug comes back under the next free one", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    expect(await call(createCollection, as(), { name: "Billing" })).toMatchObject({ slug: "billing" });
    expect(await call(restoreArticle, as(), { slug: "billing" })).toMatchObject({ slug: "billing-2" });
  });

  test("two at once, under the project's lock, land on different slugs", async () => {
    const made = await Promise.all([
      call(createTab, as(), { name: "Billing" }),
      call(createCollection, as(), { name: "Billing" }),
      call(createArticle, as(), { title: "Billing" }),
    ]);
    expect(made.map((page) => page.slug).sort()).toEqual(["billing", "billing-2", "billing-3"]);
  });
});

describe("the migration", () => {
  test("renames today's clashes: articles keep their slugs, then tabs, and collections are renamed last", async () => {
    const sql = readFileSync(
      new URL("../../../../packages/db/prisma/migrations/20261021090000_docs_one_name/migration.sql", import.meta.url),
      "utf8",
    );
    // As the app let them be made before: each kind only checked against its own.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));
    const tab = (projectId: string, slug: string, minute: number) =>
      prisma.docsTab.create({ data: { projectId, slug, name: slug, createdAt: at(minute) } });
    const collection = (projectId: string, slug: string, minute: number) =>
      prisma.collection.create({ data: { projectId, slug, name: slug, createdAt: at(minute) } });
    await call(createArticle, as(), { title: "Billing" });
    await call(createArticle, as(), { title: "Guides" });
    await call(deleteArticle, as(), { slug: "guides" });
    await tab(project.id, "billing", 2);
    await tab(project.id, "basics", 1);
    await tab(project.id, "guides", 3);
    await collection(project.id, "billing", 0);
    await collection(project.id, "billing-2", 4);
    await collection(project.id, "basics", 5);
    const other = await createProject(owner);
    await tab(other.id, "billing", 0);
    await collection(other.id, "basics", 0);

    await prisma.$executeRawUnsafe(sql);

    const slugs = async (projectId: string) => ({
      articles: (await prisma.article.findMany({ where: { projectId, deletedAt: null }, orderBy: { slug: "asc" } })).map((a) => a.slug),
      tabs: (await prisma.docsTab.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } })).map((t) => `${t.name}→${t.slug}`),
      collections: (await prisma.collection.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } })).map(
        (c) => `${c.name}→${c.slug}`,
      ),
    });
    expect(await slugs(project.id)).toEqual({
      articles: ["billing"],
      // A deleted article's slug is free, so the "guides" tab keeps it; "billing-2" is a collection's.
      tabs: ["basics→basics", "billing→billing-3", "guides→guides"],
      // Collections go after tabs, even an older one.
      collections: ["billing→billing-4", "billing-2→billing-2", "basics→basics-2"],
    });
    // Another project's are its own.
    expect(await slugs(other.id)).toEqual({ articles: [], tabs: ["billing→billing"], collections: ["basics→basics"] });
  });
});
