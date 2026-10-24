import { randomUUID } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import DocsInsightsPage from "@/app/app/[project]/docs/insights/page";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { dismissDocsGap } from "./docs";
import { answerArticle, countArticleView, logDocsSearch, searchDocsAsTyped } from "./docs-readers";
import { searchDocs } from "./docs-search";
import { answerArticle as answerOperation, getDocsInsights } from "./operations/docs-insights";
import { call } from "./operations/run";

/** Readers' answers under docs articles, article views, search logging and the team's insights. */

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
const insights = (projectId = project.id) => call(getDocsInsights, { actor: { kind: "user", userId: owner.id }, projectId }, {});

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
  await searchDocs(project.id, "  Send   INVITES ", 10, SIGNED_OUT);
  await searchDocs(project.id, "refunds", 10, SIGNED_OUT);
  await searchDocs(project.id, "   ", 10, SIGNED_OUT);
  // Logging isn't awaited by search, so wait for it.
  await vi.waitFor(async () => expect(await prisma.docsSearch.count({ where: { projectId: project.id } })).toBe(2));
  expect(await prisma.docsSearch.findMany({ where: { projectId: project.id }, orderBy: { query: "asc" }, select: { projectId: true, query: true, results: true } })).toEqual([
    { projectId: project.id, query: "refunds", results: 0 },
    { projectId: project.id, query: "send invites", results: 1 },
  ]);
});

test("the search box: results as readers type, for what they may read, counted once they've searched", async () => {
  anonymous();
  await article("Billing", "Plans are billed monthly.");
  await article("Draft", "Billing drafts.", { published: false });
  expect((await searchDocsAsTyped(project.slug, "bil")).map((r) => r.slug)).toEqual(["billing"]);
  expect((await searchDocsAsTyped(project.slug, "invi")).map((r) => r.title)).toEqual(["Inviting your team"]);
  expect(await searchDocsAsTyped(project.slug, "   ")).toEqual([]);
  // Typing isn't searching: nothing in the insights yet.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await prisma.docsSearch.count({ where: { projectId: project.id } })).toBe(0);
  // Once they've searched; a count from the browser is kept within what the box shows.
  await logDocsSearch(project.slug, "  Billing ", 1);
  await logDocsSearch(project.slug, "refunds", -3);
  await logDocsSearch(project.slug, "anything", 500);
  await expect
    .poll(() => prisma.docsSearch.findMany({ where: { projectId: project.id }, select: { query: true, results: true }, orderBy: { query: "asc" } }))
    .toEqual([
      { query: "anything", results: 8 },
      { query: "billing", results: 1 },
      { query: "refunds", results: 0 },
    ]);
  // A private portal: nothing for people who may not read it, and nothing counted.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await searchDocsAsTyped(project.slug, "bil")).toEqual([]);
  await logDocsSearch(project.slug, "sneaky", 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await prisma.docsSearch.count({ where: { projectId: project.id, query: "sneaky" } })).toBe(0);
  // A project that isn't there: nothing.
  expect(await searchDocsAsTyped("no-such-project", "bil")).toEqual([]);
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
  await prisma.docsSearch.create({ data: { projectId: project.id, query: "ancient", results: 0, createdAt: old } });

  for (const query of ["refunds", "Refunds", "sso", "send invites"]) {
    await searchDocs(project.id, query, 10, SIGNED_OUT);
  }
  await searchDocs(other.id, "other project", 10, SIGNED_OUT);
  await vi.waitFor(async () => expect(await prisma.docsSearch.count({ where: { projectId: { in: [project.id, other.id] } } })).toBe(6));

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
    gaps: [],
  });
  expect((await insights(other.id)).views).toBe(1);
});

describe("gaps", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const asked = (question: string, data: Partial<Prisma.DocsQuestionCreateManyInput> = {}) => ({
    projectId: project.id,
    askerId: randomUUID(),
    question,
    source: "PORTAL" as const,
    status: "NO_ANSWER" as const,
    ...data,
  });
  const gaps = async (projectId = project.id) => (await insights(projectId)).gaps;

  test("unanswered and thumbs-down questions of the last 30 days, grouped by normalized question, with counts, the latest date and the answer that didn't help", async () => {
    const other = await createProject(owner);
    await prisma.docsQuestion.createMany({
      data: [
        asked("Can I pay with crypto?", { createdAt: minutesAgo(30) }),
        asked("  can i PAY   with\tcrypto? ", { createdAt: minutesAgo(20) }),
        asked("Can I pay with crypto?", { status: "ANSWERED", answer: "Yes, with Bitcoin.", helpful: false, createdAt: minutesAgo(15) }),
        asked("Can I pay with crypto?", { status: "ANSWERED", answer: "Only by card.", helpful: false, createdAt: minutesAgo(10) }),
        asked("How do I export?", { status: "ANSWERED", answer: "From the board's menu.", helpful: false, createdAt: minutesAgo(5) }),
        // Not gaps: answered (helpful, or not rated), failed, too old, or another project's.
        asked("Can I pay with crypto?", { status: "ANSWERED", answer: "By card.", helpful: true }),
        asked("How do I invite?", { status: "ANSWERED", answer: "From the Team page." }),
        asked("Is there an API?", { status: "FAILED" }),
        asked("Do you have SSO?", { createdAt: new Date(Date.now() - 40 * 86_400_000) }),
        asked("Is there a dark mode?", { projectId: other.id }),
      ],
    });

    // Most asked first; each shown as last asked, with the latest answer that got a thumbs-down.
    const [crypto, exporting, ...rest] = await gaps();
    expect(crypto).toEqual({ question: "Can I pay with crypto?", noAnswer: 2, notHelpful: 2, escalated: 0, lastAsked: expect.any(String), answer: "Only by card.", cause: null });
    expect(exporting).toEqual({ question: "How do I export?", noAnswer: 0, notHelpful: 1, escalated: 0, lastAsked: expect.any(String), answer: "From the board's menu.", cause: null });
    expect(rest).toEqual([]);
    expect(Date.parse(crypto!.lastAsked)).toBeGreaterThan(minutesAgo(11).getTime());
    expect(Date.parse(crypto!.lastAsked)).toBeLessThan(minutesAgo(9).getTime());
    expect(await gaps(other.id)).toEqual([expect.objectContaining({ question: "Is there a dark mode?", noAnswer: 1, notHelpful: 0, answer: null })]);
  });

  test("each gap says why its latest “I don't know” happened, as a label on the insights page", async () => {
    await prisma.docsQuestion.createMany({
      data: [
        asked("Can I pay with crypto?", { cause: "NO_RELEVANT_SECTION", createdAt: minutesAgo(30) }),
        asked("can I pay with crypto?", { cause: "OFF_LIMITS", createdAt: minutesAgo(20) }),
        // A later thumbs-down on an answer has no cause: the latest "I don't know" still counts.
        asked("Can I pay with crypto?", { status: "ANSWERED", answer: "By card.", helpful: false, createdAt: minutesAgo(10) }),
        asked("How do I export?", { cause: "NO_VALID_CITATION" }),
        asked("Is there SSO?", { cause: "SOURCE_UNPUBLISHED" }),
        asked("Is there an API?", { cause: "NO_RELEVANT_SECTION" }),
        // Asked before causes were recorded (the migration marks those UNKNOWN): no label.
        asked("Is there a dark mode?", { cause: "UNKNOWN" }),
      ],
    });
    expect(Object.fromEntries((await gaps()).map((gap) => [gap.question, gap.cause]))).toEqual({
      "Can I pay with crypto?": "off_limits",
      "How do I export?": "no_valid_citation",
      "Is there SSO?": "source_unpublished",
      "Is there an API?": "no_relevant_section",
      "Is there a dark mode?": "unknown",
    });

    actAs(owner);
    const html = renderToStaticMarkup(await DocsInsightsPage({ params: Promise.resolve({ project: project.slug }) } as never));
    const row = (question: string) => html.slice(html.indexOf(question), html.indexOf("Write an article", html.indexOf(question)));
    expect(row("Can I pay with crypto?")).toContain("Off-limits");
    expect(row("How do I export?")).toContain("AI found no answer");
    expect(row("Is there SSO?")).toContain("Article unpublished");
    expect(row("Is there an API?")).toContain("No matching article");
    expect(row("Is there a dark mode?")).not.toMatch(/Off-limits|AI found no answer|Article unpublished|No matching article/);
  });

  test("dismissing hides a question (whatever its case and spacing) until it's asked again; only the team may, and only in its project", async () => {
    const other = await createProject(owner);
    await prisma.docsQuestion.createMany({
      data: [
        asked("Can I pay with crypto?", { createdAt: minutesAgo(5) }),
        asked("How do I export?", { createdAt: minutesAgo(5) }),
        asked("Can I pay with crypto?", { projectId: other.id, createdAt: minutesAgo(5) }),
      ],
    });

    // Not by someone outside the team.
    actAs(await signUp("Outsider"));
    expect(await dismissDocsGap(project.slug, "Can I pay with crypto?")).toEqual({ error: "Only the project's team can edit the docs" });
    actAs(null);
    expect(await dismissDocsGap(project.slug, "Can I pay with crypto?")).toEqual({ error: "Only the project's team can edit the docs" });
    expect(await prisma.docsGapDismissal.count({ where: { projectId: { in: [project.id, other.id] } } })).toBe(0);

    actAs(await addMember(project.id, "MEMBER"));
    expect(await dismissDocsGap(project.slug, "  CAN I pay with   crypto?")).toEqual({});
    expect((await gaps()).map((gap) => gap.question)).toEqual(["How do I export?"]);
    // Another project's gaps stay.
    expect((await gaps(other.id)).map((gap) => gap.question)).toEqual(["Can I pay with crypto?"]);

    // Asked again after the dismissal: back, counting only the new question.
    await prisma.docsGapDismissal.updateMany({ where: { projectId: project.id }, data: { dismissedAt: minutesAgo(1) } });
    await prisma.docsQuestion.create({ data: asked("can i pay with crypto?") });
    expect((await gaps()).map((gap) => [gap.question, gap.noAnswer])).toEqual([
      ["can i pay with crypto?", 1],
      ["How do I export?", 1],
    ]);
    // Dismissing it again hides it again.
    expect(await dismissDocsGap(project.slug, "Can I pay with crypto?")).toEqual({});
    expect((await gaps()).map((gap) => gap.question)).toEqual(["How do I export?"]);
  });
});

test("only the project's team sees the insights page", async () => {
  const page = () => DocsInsightsPage({ params: Promise.resolve({ project: project.slug }) } as never);
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
