import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { docsContents, publishedArticle } from "@/server/docs-queries";
import {
  createArticle,
  createCollection,
  deleteArticle,
  deleteCollection,
  getArticle,
  listArticles,
  publishArticle,
  unpublishArticle,
  updateArticle,
  updateCollection,
} from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

let owner: TestUser;
let visitor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  visitor = await signUp("Visitor");
  project = await createProject(owner);
});

const as = (user: TestUser, projectId = project.id) => ({ actor: { kind: "user" as const, userId: user.id }, projectId });
const table = {
  type: "table",
  content: [
    {
      type: "tableRow",
      content: ["Plan", "Seats"].map((text) => ({ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })),
    },
  ],
};

describe("articles", () => {
  test("a draft is the team's until it's published; unpublishing hides it again", async () => {
    const article = await call(createArticle, as(owner), { title: "Getting started", body: "Make a board." });
    expect(article).toMatchObject({ slug: "getting-started", status: "draft", body: "Make a board.", collection: null });
    expect(article.url).toMatch(/\/docs\/getting-started$/);

    await expect(call(getArticle, as(visitor), { slug: "getting-started" })).rejects.toMatchObject({ status: 404 });
    await expect(call(listArticles, as(visitor), { status: "draft" })).rejects.toMatchObject({ status: 403 });
    expect((await call(listArticles, as(visitor), {})).articles).toEqual([]);
    expect((await call(listArticles, as(owner), { status: "draft" })).articles).toHaveLength(1);
    expect(await publishedArticle(project.slug, "getting-started")).toBeNull();

    const published = await call(publishArticle, as(owner), { slug: "getting-started" });
    expect(published).toMatchObject({ status: "published", publishedAt: expect.any(String) });
    // A second publish keeps the date.
    expect(await call(publishArticle, as(owner), { slug: "getting-started" })).toMatchObject({ publishedAt: published.publishedAt });
    expect(await call(getArticle, as(visitor), { slug: "getting-started" })).toMatchObject({ title: "Getting started" });
    expect((await call(listArticles, as(visitor), {})).articles.map((a) => a.slug)).toEqual(["getting-started"]);
    expect(await publishedArticle(project.slug, "getting-started")).toMatchObject({ title: "Getting started" });

    await call(unpublishArticle, as(owner), { slug: "getting-started" });
    await expect(call(getArticle, as(visitor), { slug: "getting-started" })).rejects.toMatchObject({ status: 404 });
    expect(await publishedArticle(project.slug, "getting-started")).toBeNull();

    await call(deleteArticle, as(owner), { slug: "getting-started" });
    await expect(call(getArticle, as(owner), { slug: "getting-started" })).rejects.toMatchObject({ status: 404 });
  });

  test("slugs come from the title, unique in the project; a draft's follows its title, a published one's stays", async () => {
    const slugs = [];
    for (const title of ["Getting started", "Getting started", "Getting started!"]) {
      slugs.push((await call(createArticle, as(owner), { title })).slug);
    }
    expect(slugs).toEqual(["getting-started", "getting-started-2", "getting-started-3"]);
    // Another project has its own.
    const other = await createProject(owner);
    expect((await call(createArticle, as(owner, other.id), { title: "Getting started" })).slug).toBe("getting-started");
    // Titles without letters or digits still get one.
    expect((await call(createArticle, as(owner), { title: "???" })).slug).toBe("article");
    // "new" is the team's new-article page, so an article can't have it.
    expect((await call(createArticle, as(owner), { title: "New" })).slug).toBe("new-2");
    // Nor /docs/api, the API reference.
    expect((await call(createArticle, as(owner), { title: "API" })).slug).toBe("api-2");

    expect(await call(updateArticle, as(owner), { slug: "getting-started-2", title: "Inviting your team" })).toMatchObject({
      slug: "inviting-your-team",
    });
    // Saving the same title keeps the slug.
    expect(await call(updateArticle, as(owner), { slug: "getting-started", title: "Getting started" })).toMatchObject({ slug: "getting-started" });
    await call(publishArticle, as(owner), { slug: "getting-started" });
    expect(await call(updateArticle, as(owner), { slug: "getting-started", title: "Start here", publish: true })).toMatchObject({
      slug: "getting-started",
      title: "Start here",
    });
  });

  test("content is checked against the article profile: tables yes, unknown nodes no", async () => {
    const saved = await call(createArticle, as(owner), { title: "Plans", content: { type: "doc", content: [table] } });
    expect(saved.body).toBe("Plan\nSeats");
    await expect(
      call(updateArticle, as(owner), { slug: "plans", content: { type: "doc", content: [{ type: "script", content: [{ type: "text", text: "x" }] }] } }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_content" });
  });
});

describe("collections", () => {
  test("articles go in this project's collections only; deleting one leaves its articles", async () => {
    const basics = await call(createCollection, as(owner), { name: "Basics" });
    expect(basics).toMatchObject({ slug: "basics", order: 0, articles: 0 });
    expect(await call(createCollection, as(owner), { name: "Basics" })).toMatchObject({ slug: "basics-2", order: 1 });
    const other = await createProject(owner);
    await call(createCollection, as(owner, other.id), { name: "Billing" });

    await expect(call(createArticle, as(owner), { title: "Invoices", collection: "billing" })).rejects.toMatchObject({
      status: 400,
      message: "There's no collection “billing”",
    });
    const article = await call(createArticle, as(owner), { title: "Getting started", collection: "basics" });
    expect(article.collection).toEqual({ slug: "basics", name: "Basics" });
    await call(createArticle, as(owner), { title: "Shortcuts" });
    await call(createArticle, as(owner), { title: "Draft in basics", collection: "basics" });
    await call(publishArticle, as(owner), { slug: "getting-started" });
    await call(publishArticle, as(owner), { slug: "shortcuts" });

    // The portal: collections with published articles (not the empty one, not drafts), then the rest.
    expect(await docsContents(project.slug)).toEqual({
      collections: [
        { slug: "basics", name: "Basics", description: "", articles: [{ slug: "getting-started", title: "Getting started" }], collections: [] },
      ],
      uncollected: [{ slug: "shortcuts", title: "Shortcuts" }],
      tabs: [],
      home: null,
    });

    // Renaming moves its slug; articles follow by id.
    expect(await call(updateCollection, as(owner), { slug: "basics", name: "The basics" })).toMatchObject({ slug: "the-basics", articles: 2 });
    await call(deleteCollection, as(owner), { slug: "the-basics" });
    expect(await call(getArticle, as(owner), { slug: "getting-started" })).toMatchObject({ collection: null });
    expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(3);
    // Taking an article out of a collection: null.
    await call(updateArticle, as(owner), { slug: "shortcuts", collection: "basics-2" });
    expect(await call(updateArticle, as(owner), { slug: "shortcuts", collection: null })).toMatchObject({ collection: null });
  });
});
