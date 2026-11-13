import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle, publishChanges, unpublishArticle, updateArticle } from "./operations/docs";
import { call } from "./operations/run";
import { articlesFull } from "./operations/plan";
import { addSampleContent } from "./sample-content";

// How many docs articles a project publishes, by its plan (articleLimit), where plans are sold.

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const setPlan = (plan: "FREE" | "PRO" | "BUSINESS") => prisma.project.update({ where: { id: project.id }, data: { plan } });
const published = () => prisma.article.count({ where: { projectId: project.id, publishedAt: { not: null } } });
const FREE_FULL = { status: 402, code: "article_limit", message: "Your plan publishes up to 50 articles. Unpublish some, or upgrade to Pro." };

/** `count` published articles, written straight to the database. */
const publishedArticles = (count: number) =>
  prisma.article.createMany({
    data: Array.from({ length: count }, (_, n) => ({ projectId: project.id, slug: `old-${n}`, title: `Old ${n}`, publishedAt: new Date() })),
  });

const draft = (title: string) => call(createArticle, team(), { title, body: "Pick Light in Settings." });

test("Free publishes up to 50 articles: the 50th goes live, the 51st is refused saying the way out", async () => {
  await publishedArticles(49);
  await call(publishArticle, team(), { slug: (await draft("Fiftieth")).slug });
  expect(await published()).toBe(50);

  const extra = await draft("One too many");
  await expect(call(publishArticle, team(), { slug: extra.slug })).rejects.toMatchObject(FREE_FULL);
  // Saving it still works; it stays a draft.
  expect(await call(updateArticle, team(), { slug: extra.slug, body: "Pick Dark in Settings." })).toMatchObject({ status: "draft", body: "Pick Dark in Settings." });
  expect(await published()).toBe(50);
});

test("past its limit (a downgrade), a project saves freely but publishes nothing until it unpublishes enough", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.articles = 2; }));
  const [first, second, third] = [await draft("First"), await draft("Second"), await draft("Third")];
  await setPlan("PRO");
  for (const article of [first, second, third]) {
    await call(publishArticle, team(), { slug: article.slug });
  }
  await setPlan("FREE");

  // Saving changes to a published article always works; they wait unpublished.
  const saved = await call(updateArticle, team(), { slug: first.slug, title: "First, edited" });
  expect(saved.changes).toMatchObject({ title: "First, edited" });
  const full = { status: 402, code: "article_limit", message: "Your plan publishes up to 2 articles. Unpublish some, or upgrade to Pro." };
  await expect(call(publishChanges, team(), { slug: first.slug })).rejects.toMatchObject(full);
  await expect(call(updateArticle, team(), { slug: first.slug, title: "First, again", publish: true, revision: saved.revision! })).rejects.toMatchObject(full);
  // Refused whole: nothing of it was saved or went live.
  expect(await prisma.article.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: first.slug } }, select: { title: true, changes: { select: { title: true } } } })).toEqual({
    title: "First",
    changes: { title: "First, edited" },
  });

  // At the limit again, it publishes.
  await call(unpublishArticle, team(), { slug: third.slug });
  expect(await call(publishChanges, team(), { slug: first.slug })).toMatchObject({ title: "First, edited", changes: null });
});

test("two publishes at once can't both take the last place", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.articles = 1; }));
  const [a, b] = [await draft("Alpha"), await draft("Bravo")];
  const results = await Promise.allSettled([call(publishArticle, team(), { slug: a.slug }), call(publishArticle, team(), { slug: b.slug })]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await published()).toBe(1);
});

test("Pro and Business publish without a limit, unless the operator sets one", async () => {
  await publishedArticles(50);
  await setPlan("PRO");
  await call(publishArticle, team(), { slug: (await draft("On Pro")).slug });
  await setPlan("BUSINESS");
  await call(publishArticle, team(), { slug: (await draft("On Business")).slug });
  expect(await published()).toBe(52);

  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.limits.articles = 52; }));
  await expect(call(publishArticle, team(), { slug: (await draft("Over")).slug })).rejects.toMatchObject({
    status: 402,
    message: "Your plan publishes up to 52 articles. Unpublish some.",
  });
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.articles = 10; }));
  await setPlan("PRO");
  await expect(call(publishArticle, team(), { slug: "over" })).rejects.toMatchObject({ message: "Your plan publishes up to 10 articles. Unpublish some, or upgrade to Business." });
});

test("without plans (self-hosted), there's no limit", async () => {
  vi.stubEnv("BILLING_CONFIG", "");
  await call(publishArticle, team(), { slug: (await draft("Mine")).slug });
  expect(await published()).toBe(1);
});

test("sample articles are published only while the plan has room; the rest are drafts", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.articles = 1; }));
  await prisma.project.update({ where: { id: project.id }, data: { uses: ["docs"] } });
  await addSampleContent(project.id, owner.id);
  expect(await prisma.article.findMany({ where: { projectId: project.id, sample: true }, orderBy: { order: "asc" }, select: { publishedAt: true } })).toEqual([
    { publishedAt: expect.any(Date) },
    { publishedAt: null },
  ]);
});

test("the refusal names the first plan above with more room, and none where no plan has more", () => {
  expect(articlesFull("FREE", 50)).toBe("Your plan publishes up to 50 articles. Unpublish some, or upgrade to Pro.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.articles = 50; }));
  expect(articlesFull("FREE", 50)).toBe("Your plan publishes up to 50 articles. Unpublish some, or upgrade to Business.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => { pro.limits.articles = 50; business.limits.articles = 50; }));
  expect(articlesFull("FREE", 50)).toBe("Your plan publishes up to 50 articles. Unpublish some.");
  expect(articlesFull("PRO", 50)).toBe("Your plan publishes up to 50 articles. Unpublish some.");
  expect(articlesFull("BUSINESS", 1)).toBe("Your plan publishes up to 1 article. Unpublish some.");
});
