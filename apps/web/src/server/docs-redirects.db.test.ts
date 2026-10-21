import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { beforeEach, describe, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle,
  deleteTab,
  publishArticle,
  restoreArticle,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { call } from "./operations/run";

/** Renamed pages redirect: a slug a tab, collection or article had sends readers to its current one. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The project's redirects, as "old slug → the page's current slug". */
async function redirects() {
  const rows = await prisma.docsRedirect.findMany({
    where: { projectId: project.id },
    orderBy: { slug: "asc" },
    select: { slug: true, tab: { select: { slug: true } }, collection: { select: { slug: true } }, article: { select: { slug: true } } },
  });
  return rows.map((row) => {
    const [kind, page] = Object.entries({ tab: row.tab, collection: row.collection, article: row.article }).find(([, to]) => to)!;
    return `${row.slug} → ${kind} ${page!.slug}`;
  });
}

describe("renaming records where the page went", () => {
  test("a draft renamed twice: both old slugs point at the article, not at each other", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(updateArticle, as(), { slug: "beta", title: "Gamma" });
    await call(publishArticle, as(), { slug: "gamma" });
    expect(await redirects()).toEqual(["alpha → article gamma", "beta → article gamma"]);
    // Saving with the same title (or one with the same slug) records nothing.
    await call(createArticle, as(), { title: "Delta" });
    await call(updateArticle, as(), { slug: "delta", title: "DELTA" });
    expect(await redirects()).toHaveLength(2);
  });

  test("tabs and collections too", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });
    await call(createCollection, as(), { name: "Basics" });
    await call(updateCollection, as(), { slug: "basics", name: "Essentials" });
    // A change that keeps the name keeps the slug: no redirect to itself.
    await call(updateCollection, as(), { slug: "essentials", name: "Essentials", description: "Start here" });
    expect(await redirects()).toEqual(["basics → collection essentials", "guides → tab handbook"]);
  });

  test("a deleted article restored under another slug leaves a redirect behind its old one", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    await call(createCollection, as(), { name: "Billing" });
    expect(await call(restoreArticle, as(), { slug: "billing" })).toMatchObject({ slug: "billing-2" });
    expect(await redirects()).toEqual(["billing → article billing-2"]);
  });
});

describe("a page taking an old slug wins", () => {
  test("a new page takes it, and the redirect is gone", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    expect(await redirects()).toEqual(["alpha → article beta"]);
    expect(await call(createTab, as(), { name: "Alpha" })).toMatchObject({ slug: "alpha" });
    expect(await redirects()).toEqual([]);
  });

  test("another page renamed to it takes it", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });
    await call(createCollection, as(), { name: "Basics" });
    expect(await call(updateCollection, as(), { slug: "basics", name: "Guides" })).toMatchObject({ slug: "guides" });
    expect(await redirects()).toEqual(["basics → collection guides"]);
  });

  test("renaming back to an old slug of its own drops that redirect", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(updateArticle, as(), { slug: "beta", title: "Alpha" });
    expect(await redirects()).toEqual(["beta → article alpha"]);
  });

  test("a deleted article restored to its own slug, which a redirect had since, takes it", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    await call(createTab, as(), { name: "Billing" });
    await call(updateTab, as(), { slug: "billing", name: "Payments" });
    expect(await redirects()).toEqual(["billing → tab payments"]);
    expect(await call(restoreArticle, as(), { slug: "billing" })).toMatchObject({ slug: "billing" });
    expect(await redirects()).toEqual([]);
  });
});

describe("deleting a page drops its redirects", () => {
  test("an article, once it's purged; a tab", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });

    await call(deleteArticle, as(), { slug: "beta" });
    // Restorable for 30 days: its redirects stay until it's purged.
    expect(await redirects()).toEqual(["alpha → article beta", "guides → tab handbook"]);
    await prisma.article.updateMany({ where: { projectId: project.id }, data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
    await handlers.purgeArticles({}, { info: () => {}, warn: () => {} });
    expect(await redirects()).toEqual(["guides → tab handbook"]);

    await call(deleteTab, as(), { slug: "handbook" });
    expect(await redirects()).toEqual([]);
  });
});
