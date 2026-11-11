import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";
import { actAs, createProject, signUp } from "@/test/helpers";
import { publishArticle as publishFromDocs, publishArticleChanges as publishChangesFromDocs } from "./docs";
import { createArticle, publishArticle, updateArticle } from "./operations/docs";
import { inputSchema } from "./operations/openapi";
import { call } from "./operations/run";

afterEach(() => { vi.unstubAllEnvs(); });

async function draft() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const context = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const article = await call(createArticle, context, { title: "Plans", body: "The reviewed words." });
  const newest = () => prisma.articleRevision.findFirstOrThrow({ where: { article: { projectId: project.id, slug: article.slug } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return { owner, project, context, article, newest };
}

test("publishing a draft refuses a save made since its reviewed revision, then accepts the current revision", async () => {
  const { owner, project, context, article, newest } = await draft();
  const reviewed = await newest();
  await call(updateArticle, context, { slug: article.slug, body: "A half-finished save." });
  await expect(call(publishArticle, context, { slug: article.slug, revision: reviewed.id })).rejects.toMatchObject({ status: 409, code: "changed" });
  expect(await prisma.article.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: article.slug } } })).toMatchObject({ publishedAt: null, body: "A half-finished save." });
  actAs(owner);
  expect(await publishFromDocs(project.slug, article.slug, undefined, reviewed.id)).toMatchObject({ code: "changed", error: expect.any(String) });
  const current = await newest();
  expect(await publishFromDocs(project.slug, article.slug, undefined, current.id)).toEqual({});
  expect((await prisma.article.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: article.slug } } })).publishedAt).not.toBeNull();
});

test("the publish revision guard is optional and documented in the API schema", async () => {
  const { context, article } = await draft();
  const schema = inputSchema(publishArticle);
  expect(schema.properties?.revision).toMatchObject({ type: "string", description: expect.stringContaining("409") });
  expect(schema.required).not.toContain("revision");
  await expect(call(publishArticle, context, { slug: article.slug })).resolves.toMatchObject({ status: "published" });
});

test("revision-aware queue publishing reports plan limits for drafts and saved changes, preserving legacy errors", async () => {
  const { owner, project, context, article, newest } = await draft();
  actAs(owner);
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "0");
  const reviewed = await newest();
  expect(await publishFromDocs(project.slug, article.slug, undefined, reviewed.id)).toMatchObject({ code: "article_limit", error: expect.any(String) });
  expect(await publishFromDocs(project.slug, article.slug)).toEqual({ error: expect.any(String) });
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  expect(await publishFromDocs(project.slug, article.slug, undefined, reviewed.id)).toEqual({});
  const saved = await call(updateArticle, context, { slug: article.slug, body: "New saved words." });
  const current = await newest();
  vi.stubEnv("ARTICLE_LIMIT_FREE", "0");
  expect(await publishChangesFromDocs(project.slug, article.slug, saved.changes!.savedAt, current.id)).toMatchObject({ code: "article_limit", error: expect.any(String) });
  expect(await publishChangesFromDocs(project.slug, article.slug, saved.changes!.savedAt)).toEqual({ error: expect.any(String) });
});
