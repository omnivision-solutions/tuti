import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { articleById, stillAsked } from "./docs-queries";
import { createArticle, deleteArticle, getArticle, listArticles, publishArticle, updateArticle } from "./operations/docs";
import { call } from "./operations/run";

/** Article IDs (docs/plan.md L0): made once, never changed; articles.get and the widget take one or a slug. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

describe("an article's ID", () => {
  test("is made when it's created, in its own shape, and kept through renames and a new slug", async () => {
    const created = await call(createArticle, as(), { title: "Billing" });
    expect(created.id).toMatch(/^a_[a-z0-9]{8}$/);
    await call(publishArticle, as(), { slug: "billing" });
    const renamed = await call(updateArticle, as(), { slug: "billing", newSlug: "payments" });
    expect(renamed).toMatchObject({ id: created.id, slug: "payments" });
    expect((await call(listArticles, as(), {})).articles).toEqual([expect.objectContaining({ id: created.id })]);
  });

  test("articles.get finds an article by its ID, its slug or an old slug, for readers too", async () => {
    const { id } = await call(createArticle, as(), { title: "Billing" });
    await call(publishArticle, as(), { slug: "billing" });
    await call(updateArticle, as(), { slug: "billing", newSlug: "payments" });
    const reader = await signUp("Reader");
    for (const ref of [id, "payments", "billing"]) {
      expect(await call(getArticle, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { slug: ref })).toMatchObject({ id, slug: "payments" });
    }
  });

  test("a deleted article's ID, or another project's, finds nothing", async () => {
    const { id } = await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    await expect(call(getArticle, as(), { slug: id })).rejects.toMatchObject({ status: 404 });

    const other = await createProject(await signUp("Other"));
    const elsewhere = await prisma.article.create({ data: { projectId: other.id, slug: "elsewhere", title: "Elsewhere", publishedAt: new Date() } });
    await expect(call(getArticle, as(), { slug: elsewhere.publicId })).rejects.toMatchObject({ status: 404 });
    expect(await articleById(project.slug, elsewhere.publicId)).toBeNull();
  });

  test("the widget's lookup turns an ID into the article's slug", async () => {
    const { id } = await call(createArticle, as(), { title: "Billing" });
    expect(await articleById(project.slug, id)).toBe("billing");
    expect(await articleById(project.slug, "billing")).toBeNull();
  });
});

test("opened by ID, the article read at its slug must still be that one", () => {
  const asked = { publicId: "a_aaaaaaaa" };
  // Renamed and its slug reused between the two reads: another article, so not found.
  expect(stillAsked("a_aaaaaaaa", true, { publicId: "a_bbbbbbbb" })).toBeNull();
  expect(stillAsked("a_aaaaaaaa", true, asked)).toBe(asked);
  // Opened by slug, whichever article is there.
  expect(stillAsked("billing", false, asked)).toBe(asked);
});
