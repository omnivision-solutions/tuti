import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test, vi } from "vitest";

import HelpInsightsPage from "@/app/app/[project]/help/insights/page";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { answerArticle, countArticleView } from "./help-readers";
import { searchHelp } from "./help-search";
import { answerArticle as answerOperation, getHelpInsights } from "./operations/help-insights";
import { call } from "./operations/run";

/** Readers' answers under help articles, article views, search logging and the team's insights. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.userAgent = "";
  await article("Inviting your team", "Owners and admins send invites from the Team page.");
});

async function article(title: string, body: string, { projectId = project.id, published = true } = {}) {
  const slug = title.toLowerCase().replaceAll(" ", "-");
  await prisma.article.create({ data: { projectId, slug, title, body, publishedAt: published ? new Date() : null } });
  return slug;
}

/** Acts as an anonymous reader whose browser has the reader cookie `id`. */
function anonymous(id = randomUUID()) {
  actAs(null);
  request.cookie = `tuti_reader=${id}`;
  return id;
}

const feedback = () =>
  prisma.articleFeedback.findMany({ where: { article: { projectId: project.id } }, orderBy: { createdAt: "asc" }, select: { readerId: true, helpful: true, comment: true } });
const insights = (projectId = project.id) => call(getHelpInsights, { actor: { kind: "user", userId: owner.id }, projectId }, {});

test("one answer per reader and article: answering again changes it", async () => {
  const reader = anonymous();
  expect(await answerArticle(project.slug, "inviting-your-team", true)).toEqual({});
  expect(await answerArticle(project.slug, "inviting-your-team", false)).toEqual({});
  expect(await feedback()).toEqual([{ readerId: reader, helpful: false, comment: null }]);

  // Another browser is another reader; a signed-in one is known by their account.
  const other = anonymous();
  await answerArticle(project.slug, "inviting-your-team", true);
  const user = await signUp("Reader");
  actAs(user);
  await answerArticle(project.slug, "inviting-your-team", true);
  await answerArticle(project.slug, "inviting-your-team", true);
  expect(await feedback()).toEqual([
    { readerId: reader, helpful: false, comment: null },
    { readerId: other, helpful: true, comment: null },
    { readerId: user.id, helpful: true, comment: null },
  ]);
});

test("a comment only comes with a “No”, and a later “No” keeps it", async () => {
  const reader = anonymous();
  expect(await answerArticle(project.slug, "inviting-your-team", true, "Great")).toEqual({ error: "Only a “No” takes a comment" });
  expect(await feedback()).toEqual([]);

  await answerArticle(project.slug, "inviting-your-team", false);
  await answerArticle(project.slug, "inviting-your-team", false, "  How do I invite by email?  ");
  await answerArticle(project.slug, "inviting-your-team", false);
  expect(await feedback()).toEqual([{ readerId: reader, helpful: false, comment: "How do I invite by email?" }]);

  expect(await answerArticle(project.slug, "inviting-your-team", false, "x".repeat(501))).toEqual({ error: "Up to 500 characters" });
  // Changing to "Yes" drops it.
  await answerArticle(project.slug, "inviting-your-team", true);
  expect(await feedback()).toEqual([{ readerId: reader, helpful: true, comment: null }]);
});

test("only published articles of the project take answers and views", async () => {
  await article("Billing", "Draft", { published: false });
  const other = await createProject(owner);
  await article("Elsewhere", "Another project's", { projectId: other.id });
  anonymous();
  expect(await answerArticle(project.slug, "billing", false)).toEqual({ error: "There's no article “billing”" });
  expect(await answerArticle(project.slug, "elsewhere", false)).toEqual({ error: "There's no article “elsewhere”" });
  expect(await answerArticle("no-such-project", "inviting-your-team", false)).toEqual({ error: "Article not found" });
  await countArticleView(project.slug, "billing");
  await countArticleView(project.slug, "elsewhere");
  expect(await feedback()).toEqual([]);
  expect(await prisma.articleViewDay.count({ where: { article: { projectId: { in: [project.id, other.id] } } } })).toBe(0);
});

test("an API key answers for someone from its app, once per person", async () => {
  const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  await call(answerOperation, key, { slug: "inviting-your-team", helpful: false, author: { id: "app-user-1" } });
  await call(answerOperation, key, { slug: "inviting-your-team", helpful: false, comment: "Too short", author: { id: "app-user-1" } });
  const [answer] = await feedback();
  expect(answer).toMatchObject({ helpful: false, comment: "Too short" });
  expect(await prisma.user.findUnique({ where: { id: answer!.readerId }, select: { name: true } })).not.toBeNull();
});

test("views count per article and day, skipping crawlers", async () => {
  anonymous();
  await countArticleView(project.slug, "inviting-your-team");
  await Promise.all([countArticleView(project.slug, "inviting-your-team"), countArticleView(project.slug, "inviting-your-team")]);
  request.userAgent = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  await countArticleView(project.slug, "inviting-your-team");
  const days = await prisma.articleViewDay.findMany({ where: { article: { projectId: project.id } }, select: { views: true, day: true } });
  expect(days).toEqual([{ views: 3, day: new Date(new Date().toISOString().slice(0, 10)) }]);
});

test("searches are logged, normalized, as hits or misses; empty ones aren't", async () => {
  await searchHelp(project.id, "  Send   INVITES ", 10);
  await searchHelp(project.id, "refunds", 10);
  await searchHelp(project.id, "   ", 10);
  // Logging isn't awaited by search, so wait for it.
  await vi.waitFor(async () => expect(await prisma.helpSearch.count({ where: { projectId: project.id } })).toBe(2));
  expect(await prisma.helpSearch.findMany({ where: { projectId: project.id }, orderBy: { query: "asc" }, select: { projectId: true, query: true, results: true } })).toEqual([
    { projectId: project.id, query: "refunds", results: 0 },
    { projectId: project.id, query: "send invites", results: 1 },
  ]);
});

test("insights: views, helpfulness per article, the latest “No” comments and failed searches, for this project only", async () => {
  await article("Billing", "Plans and invoices.");
  const other = await createProject(owner);
  await article("Elsewhere", "Another project's", { projectId: other.id });

  anonymous();
  for (let i = 0; i < 3; i++) {
    await countArticleView(project.slug, "inviting-your-team");
  }
  await countArticleView(project.slug, "billing");
  await countArticleView(other.slug, "elsewhere");
  await answerArticle(project.slug, "inviting-your-team", true);
  anonymous();
  await answerArticle(project.slug, "inviting-your-team", false, "How do I invite by email?");
  anonymous();
  await answerArticle(project.slug, "inviting-your-team", true);
  await answerArticle(other.slug, "elsewhere", false, "Not this project's");
  // Older than 30 days: left out.
  const old = new Date(Date.now() - 40 * 86_400_000);
  const billing = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } });
  await prisma.articleViewDay.create({ data: { articleId: billing.id, day: old, views: 100 } });
  await prisma.articleFeedback.create({ data: { articleId: billing.id, readerId: "old", helpful: false, comment: "Old", updatedAt: old } });
  await prisma.helpSearch.create({ data: { projectId: project.id, query: "ancient", results: 0, createdAt: old } });

  for (const query of ["refunds", "Refunds", "sso", "send invites"]) {
    await searchHelp(project.id, query, 10);
  }
  await searchHelp(other.id, "other project", 10);
  await vi.waitFor(async () => expect(await prisma.helpSearch.count({ where: { projectId: { in: [project.id, other.id] } } })).toBe(6));

  expect(await insights()).toEqual({
    since: expect.any(String),
    views: 4,
    articles: [
      { slug: "inviting-your-team", title: "Inviting your team", views: 3, helpful: 2, notHelpful: 1 },
      { slug: "billing", title: "Billing", views: 1, helpful: 0, notHelpful: 0 },
    ],
    comments: [{ article: { slug: "inviting-your-team", title: "Inviting your team" }, comment: "How do I invite by email?", at: expect.any(String) }],
    searches: {
      total: 4,
      failed: 3,
      topFailed: [
        { query: "refunds", count: 2 },
        { query: "sso", count: 1 },
      ],
    },
  });
  expect((await insights(other.id)).views).toBe(1);
});

test("only the project's team sees the insights page", async () => {
  const page = () => HelpInsightsPage({ params: Promise.resolve({ project: project.slug }) } as never);
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => "shown",
      (error: { digest?: string }) => error.digest,
    );
  actAs(null);
  expect(await outcome(page())).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  actAs(await signUp("Outsider"));
  expect(await outcome(page())).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  actAs(await addMember(project.id, "MEMBER"));
  expect(await outcome(page())).toBe("shown");
});
