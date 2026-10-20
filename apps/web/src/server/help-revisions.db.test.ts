import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as exportZip } from "@/app/app/[project]/settings/export/route";
import { GET as markdown } from "@/app/portal/[project]/(site)/help/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { helpCenter, publishedArticle } from "@/server/help-queries";
import { searchHelp } from "@/server/help-search";
import { helpInsights } from "@/server/operations/help-insights";
import {
  ARTICLE_REVISIONS_KEPT,
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  listCollections,
  listRevisions,
  publishArticle,
  publishChanges,
  restoreArticle,
  updateArticle,
} from "@/server/operations/help";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Article revision history, restoring versions, deleting articles (restorable for 30 days) and the "Updated" date. */

let owner: TestUser;
let editor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", ""); // search matches words
  owner = await signUp("Olive Owner");
  editor = await signUp("Eddie Editor");
  project = await createProject(owner);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: editor.id, role: "MEMBER" } });
});
afterEach(() => vi.unstubAllEnvs());

const as = (user: TestUser, projectId = project.id) => ({ actor: { kind: "user" as const, userId: user.id }, projectId });
const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});
const history = async (slug: string, projectId = project.id) =>
  (await call(listRevisions, as(owner, projectId), { slug })).revisions.map((r) => ({ title: r.title, body: r.body, author: r.author?.name }));
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe("revisions", () => {
  test("every save that changes the title, text or collection is a revision, by whoever saved it; saves that change nothing aren't", async () => {
    await call(createArticle, as(owner), { title: "Inviting your team", content: doc("Owners invite.") });
    expect(await history("inviting-your-team")).toEqual([{ title: "Inviting your team", body: "Owners invite.", author: "Olive Owner" }]);

    await call(updateArticle, as(editor), { slug: "inviting-your-team", content: doc("Owners and admins invite.") });
    // The same title, text and collection again (even with the JSON's keys in another order): nothing new.
    await call(updateArticle, as(owner), { slug: "inviting-your-team", title: "Inviting your team", collection: null });
    await call(updateArticle, as(owner), {
      slug: "inviting-your-team",
      content: { content: [{ content: [{ text: "Owners and admins invite.", type: "text" }], type: "paragraph" }], type: "doc" },
    });
    // Nor does the "Updated" date setting.
    await call(updateArticle, as(owner), { slug: "inviting-your-team", showUpdatedDate: false });
    expect(await history("inviting-your-team")).toEqual([
      { title: "Inviting your team", body: "Owners and admins invite.", author: "Eddie Editor" },
      { title: "Inviting your team", body: "Owners invite.", author: "Olive Owner" },
    ]);

    // An API key saves as its creator; moving it to a collection is a change too.
    await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics" } });
    const key = { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: editor.id };
    await call(updateArticle, { actor: key, projectId: project.id }, { slug: "inviting-your-team", collection: "basics" });
    const revisions = (await call(listRevisions, as(owner), { slug: "inviting-your-team" })).revisions;
    expect(revisions.map((r) => [r.author?.name, r.collection?.name ?? null, r.current])).toEqual([
      ["Eddie Editor", "Basics", true],
      ["Eddie Editor", null, false],
      ["Olive Owner", null, false],
    ]);
  });

  test(`only the newest ${ARTICLE_REVISIONS_KEPT} revisions are kept`, async () => {
    await call(createArticle, as(owner), { title: "Shortcuts", body: "Save 0" });
    for (let n = 1; n <= ARTICLE_REVISIONS_KEPT + 1; n++) {
      await call(updateArticle, as(owner), { slug: "shortcuts", body: `Save ${n}` });
    }
    const bodies = (await history("shortcuts")).map((r) => r.body);
    expect(bodies).toHaveLength(ARTICLE_REVISIONS_KEPT);
    expect(bodies[0]).toBe(`Save ${ARTICLE_REVISIONS_KEPT + 1}`);
    expect(bodies.at(-1)).toBe("Save 2");
  });

  test("restoring a version saves it as a new one, keeping the history; a published article shows it once it's published", async () => {
    await call(createArticle, as(owner), { title: "Billing", content: doc("Pay by card.") });
    await call(publishArticle, as(owner), { slug: "billing" });
    await call(updateArticle, as(editor), { slug: "billing", title: "Billing and invoices", content: doc("Pay by card or invoice."), publish: true });
    expect(await publishedArticle(project.slug, "billing")).toMatchObject({ title: "Billing and invoices", body: "Pay by card or invoice." });

    const [, first] = (await call(listRevisions, as(owner), { slug: "billing" })).revisions;
    const restored = await call(restoreArticle, as(owner), { slug: "billing", revision: first!.id });
    // Published: its slug stays, and the restored text waits as unpublished changes, like any save.
    expect(restored).toMatchObject({ slug: "billing", status: "published", title: "Billing and invoices", changes: { title: "Billing", body: "Pay by card." } });
    expect(await publishedArticle(project.slug, "billing")).toMatchObject({ title: "Billing and invoices" });
    // Published, readers see the restored text, and search has it.
    await call(publishChanges, as(owner), { slug: "billing" });
    expect(await publishedArticle(project.slug, "billing")).toMatchObject({ title: "Billing", body: "Pay by card." });
    expect((await searchHelp(project.id, "invoice", 10)).map((r) => r.slug)).toEqual([]);
    expect(await history("billing")).toEqual([
      { title: "Billing", body: "Pay by card.", author: "Olive Owner" },
      { title: "Billing and invoices", body: "Pay by card or invoice.", author: "Eddie Editor" },
      { title: "Billing", body: "Pay by card.", author: "Olive Owner" },
    ]);

    // A draft's slug follows the restored title, as with any save.
    await call(createArticle, as(owner), { title: "Draft one", body: "A" });
    await call(updateArticle, as(owner), { slug: "draft-one", title: "Draft two", body: "B" });
    const [, older] = (await call(listRevisions, as(owner), { slug: "draft-two" })).revisions;
    expect(await call(restoreArticle, as(owner), { slug: "draft-two", revision: older!.id })).toMatchObject({ slug: "draft-one", status: "draft" });

    // A version of another article, or a live article without a version, isn't restored.
    await expect(call(restoreArticle, as(owner), { slug: "billing", revision: older!.id })).rejects.toMatchObject({ status: 404 });
    await expect(call(restoreArticle, as(owner), { slug: "billing" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("deleting", () => {
  test("a deleted article is gone for readers everywhere, and for the team's lists, until it's restored", async () => {
    actAs(owner);
    await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics" } });
    await call(createArticle, as(owner), { title: "Refunds", body: "Ask within 30 days.", collection: "basics" });
    await call(publishArticle, as(owner), { slug: "refunds" });
    await call(createArticle, as(owner), { title: "Kept", body: "Still here." });
    await call(publishArticle, as(owner), { slug: "kept" });
    await prisma.articleViewDay.create({
      data: { article: { connect: { projectId_slug: { projectId: project.id, slug: "refunds" } } }, day: new Date(), views: 3 },
    });

    const request = new Request("http://x");
    const params = Promise.resolve({ project: project.slug });
    const zipped = async () => unzipSync(new Uint8Array(await (await exportZip(request, { params })).arrayBuffer()));
    const portal = async () => ({
      page: (await publishedArticle(project.slug, "refunds"))?.title ?? null,
      md: (await markdown(request, { params: Promise.resolve({ project: project.slug, slug: "refunds" }) })).status,
      helpCenter: JSON.stringify(await helpCenter(project.slug)).includes("refunds"),
      llms: (await (await llms(request, { params })).text()).includes("refunds"),
      sitemap: (await (await sitemap(request, { params })).text()).includes("/help/refunds"),
      search: (await searchHelp(project.id, "refunds", 10)).map((r) => r.slug),
      export: Object.keys(await zipped()).filter((file) => file.includes("refunds")),
      insights: (await helpInsights(project.id)).articles.map((a) => a.slug),
      published: (await call(listArticles, as(owner), {})).articles.map((a) => a.slug),
      collection: (await call(listCollections, as(owner), {})).collections[0]!.articles,
    });
    expect(await portal()).toEqual({
      page: "Refunds",
      md: 200,
      helpCenter: true,
      llms: true,
      sitemap: true,
      search: ["refunds"],
      export: ["help/basics/refunds.md"],
      insights: ["refunds"],
      published: ["kept", "refunds"],
      collection: 1,
    });

    expect(await call(deleteArticle, as(owner), { slug: "refunds" })).toEqual({ deleted: "refunds" });
    expect(await portal()).toEqual({
      page: null,
      md: 404,
      helpCenter: false,
      llms: false,
      sitemap: false,
      search: [],
      export: [],
      insights: [],
      published: ["kept"],
      collection: 0,
    });
    // Its search sections are gone, and the operations don't find it.
    expect(await prisma.articleChunk.count({ where: { article: { slug: "refunds" } } })).toBe(0);
    for (const operation of [getArticle, listRevisions, publishArticle, deleteArticle] as const) {
      await expect(call(operation as typeof getArticle, as(owner), { slug: "refunds" })).rejects.toMatchObject({ status: 404 });
    }
    await expect(call(updateArticle, as(owner), { slug: "refunds", title: "Refunds again" })).rejects.toMatchObject({ status: 404 });
    expect((await call(listArticles, as(owner), { status: "draft" })).articles).toEqual([]);
    // A deleted article can't be published, even by a query that skips the operations.
    await expect(prisma.article.updateMany({ where: { slug: "refunds" }, data: { publishedAt: new Date() } })).rejects.toThrow();

    // The team lists it as deleted; others can't.
    expect((await call(listArticles, as(owner), { status: "deleted" })).articles).toMatchObject([
      { slug: "refunds", status: "draft", deletedAt: expect.any(String) },
    ]);
    await expect(call(listArticles, as(await signUp()), { status: "deleted" })).rejects.toMatchObject({ status: 403 });

    // Restored, it's a draft with its text and collection, and its revisions.
    expect(await call(restoreArticle, as(editor), { slug: "refunds" })).toMatchObject({
      slug: "refunds",
      status: "draft",
      body: "Ask within 30 days.",
      collection: { slug: "basics" },
    });
    expect(await history("refunds")).toHaveLength(1);
    expect((await call(listArticles, as(owner), { status: "deleted" })).articles).toEqual([]);
    await call(publishArticle, as(owner), { slug: "refunds" });
    expect(await publishedArticle(project.slug, "refunds")).toMatchObject({ title: "Refunds" });
  });

  test("a restored article keeps its slug if it's free, otherwise takes the next one; old deletions stay deleted", async () => {
    await call(createArticle, as(owner), { title: "FAQ", body: "First" });
    await call(deleteArticle, as(owner), { slug: "faq" });
    // Its slug is free for a new article at once.
    expect(await call(createArticle, as(owner), { title: "FAQ", body: "Second" })).toMatchObject({ slug: "faq" });
    await expect(call(restoreArticle, as(owner), { slug: "faq" })).rejects.toMatchObject({ status: 400 });
    await call(deleteArticle, as(owner), { slug: "faq" });

    // Without a revision: the one deleted last.
    expect(await call(restoreArticle, as(owner), { slug: "faq" })).toMatchObject({ slug: "faq", body: "Second" });
    // The other, by its newest revision, while "faq" is taken.
    const [first] = await prisma.articleRevision.findMany({ where: { body: "First", article: { projectId: project.id } } });
    expect(await call(restoreArticle, as(owner), { slug: "faq", revision: first!.id })).toMatchObject({ slug: "faq-2", body: "First" });

    // Deleted more than 30 days ago: not restorable (the purge job removes it).
    await call(createArticle, as(owner), { title: "Old", body: "Old" });
    await call(deleteArticle, as(owner), { slug: "old" });
    await prisma.article.updateMany({ where: { projectId: project.id, slug: "old" }, data: { deletedAt: daysAgo(31) } });
    await expect(call(restoreArticle, as(owner), { slug: "old" })).rejects.toMatchObject({ status: 404 });
    expect((await call(listArticles, as(owner), { status: "deleted" })).articles).toEqual([]);
  });

  test("the purge job removes articles deleted more than 30 days ago, with their revisions", async () => {
    for (const title of ["Recent", "Old", "Live"]) {
      await call(createArticle, as(owner), { title, body: title });
    }
    await call(deleteArticle, as(owner), { slug: "recent" });
    await call(deleteArticle, as(owner), { slug: "old" });
    await prisma.article.updateMany({ where: { projectId: project.id, slug: "recent" }, data: { deletedAt: daysAgo(29) } });
    await prisma.article.updateMany({ where: { projectId: project.id, slug: "old" }, data: { deletedAt: daysAgo(31) } });

    // Every project's (earlier tests here left one too).
    const expired = await prisma.article.count({ where: { deletedAt: { lt: daysAgo(30) } } });
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await handlers.purgeArticles({}, { info: () => {}, warn: () => {} })).toEqual({ purged: expired });
    const left = await prisma.article.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" }, select: { slug: true } });
    expect(left.map((a) => a.slug)).toEqual(["live", "recent"]);
    expect(await prisma.articleRevision.count({ where: { body: "Old" } })).toBe(0);
  });
});

test("another project's team sees and restores none of this project's versions or deleted articles", async () => {
  await call(createArticle, as(owner), { title: "Secret", body: "v1" });
  await call(updateArticle, as(owner), { slug: "secret", body: "v2" });
  const [, older] = (await call(listRevisions, as(owner), { slug: "secret" })).revisions;
  const outsider = await signUp("Outsider");
  const other = await createProject(outsider);
  await call(createArticle, as(outsider, other.id), { title: "Secret", body: "theirs" });

  await expect(call(restoreArticle, as(outsider, other.id), { slug: "secret", revision: older!.id })).rejects.toMatchObject({ status: 404 });
  expect(await history("secret", other.id)).toEqual([{ title: "Secret", body: "theirs", author: "Outsider" }]);
  await call(deleteArticle, as(owner), { slug: "secret" });
  await call(deleteArticle, as(outsider, other.id), { slug: "secret" });
  expect((await call(listArticles, as(outsider, other.id), { status: "deleted" })).articles.map((a) => a.body)).toEqual(["theirs"]);
  expect(await call(restoreArticle, as(outsider, other.id), { slug: "secret" })).toMatchObject({ body: "theirs" });
  expect(await prisma.article.count({ where: { projectId: project.id, deletedAt: { not: null } } })).toBe(1);
});

test("readers see “Updated” once changes go live after it was published, unless the team turned it off", async () => {
  await call(createArticle, as(owner), { title: "Exports", body: "Draft text" });
  await call(updateArticle, as(owner), { slug: "exports", body: "Ready" });
  await call(publishArticle, as(owner), { slug: "exports" });
  expect(await publishedArticle(project.slug, "exports")).toMatchObject({ updatedAt: null });

  // Saved, the changes aren't live yet, so neither is the date.
  await call(updateArticle, as(owner), { slug: "exports", body: "Fixed a typo" });
  expect(await publishedArticle(project.slug, "exports")).toMatchObject({ body: "Ready", updatedAt: null });
  await call(publishChanges, as(owner), { slug: "exports" });
  const { updatedAt, publishedAt } = (await publishedArticle(project.slug, "exports"))!;
  expect(updatedAt!.getTime()).toBeGreaterThan(publishedAt!.getTime());

  await call(updateArticle, as(owner), { slug: "exports", showUpdatedDate: false });
  expect(await publishedArticle(project.slug, "exports")).toMatchObject({ updatedAt: null, showUpdatedDate: false });
});

describe("the migration", () => {
  // Its backfill gives each existing article a first revision. Publishing bumps updatedAt, so a
  // published article untouched since mustn't get a later first revision (it would show "Updated").
  test("dates a published article's first revision at its publishing, unless it was edited after", async () => {
    const sql = readFileSync(
      new URL("../../../../packages/db/prisma/migrations/20261020060000_article_revisions/migration.sql", import.meta.url),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf('INSERT INTO "article_revision"'), sql.lastIndexOf(";") + 1);
    for (const title of ["Untouched", "Edited later"]) {
      await call(createArticle, as(owner), { title });
      await call(publishArticle, as(owner), { slug: title.toLowerCase().replace(" ", "-") });
    }
    await prisma.$executeRaw`UPDATE "article" SET "updatedAt" = "publishedAt" + interval '5 milliseconds' WHERE "slug" = 'untouched'`;
    await prisma.$executeRaw`UPDATE "article" SET "updatedAt" = "publishedAt" + interval '1 day' WHERE "slug" = 'edited-later'`;
    await prisma.articleRevision.deleteMany({ where: { article: { projectId: project.id } } });

    await prisma.$executeRawUnsafe(backfill);

    for (const [slug, expected] of [
      ["untouched", "publishedAt"],
      ["edited-later", "updatedAt"],
    ] as const) {
      const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug } });
      const [revision] = await prisma.articleRevision.findMany({ where: { articleId: article.id } });
      expect(revision!.createdAt).toEqual(article[expected]);
    }
  });
});
