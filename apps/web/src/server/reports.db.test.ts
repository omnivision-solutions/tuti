import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import ReportingAiConversationsPage from "@/app/app/[project]/reporting/ai-conversations/page";
import ReportingArticlesPage from "@/app/app/[project]/reporting/articles/page";
import ReportingInboxPage from "@/app/app/[project]/reporting/inbox/page";
import ReportingSearchesPage from "@/app/app/[project]/reporting/searches/page";
import ReportingOverviewPage from "@/app/app/[project]/reporting/page";
import { reportRange } from "@/lib/report-range";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { aiReport, docsReport, getReports, inboxReport } from "./operations/reports";
import { call } from "./operations/run";

/** Reporting: the help center's, the AI's and the inbox's days, by day and in total, for this project only. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

// One instant for every fixture and report: today (UTC) at noon, so a slow runner or midnight passing mid-test moves nothing.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`) });
  owner = await signUp("Owner");
  project = await createProject(owner);
});

afterEach(() => {
  vi.useRealTimers();
});

const today = () => new Date(new Date().toISOString().slice(0, 10));
const daysAgo = (ago: number) => new Date(today().getTime() - ago * 86_400_000);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
/** Yesterday (UTC) at `hour`: in the report's days, apart from today's. */
const yesterdayAt = (hour: number, minute = 0) => new Date(daysAgo(1).getTime() + (hour * 60 + minute) * 60_000);
/** The default range, the past 30 days (as of the frozen clock). */
const past30 = () => reportRange(undefined);
const page = (render: (props: never) => Promise<React.ReactElement>, searchParams = {}) =>
  render({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve(searchParams) } as never).then((element) =>
    renderToStaticMarkup(element).replace(/<[^>]+>/g, "|"),
  );

test("docs: views, searches and answers by day, each article's numbers; older days, sample and other projects' articles left out", async () => {
  const collection = await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics" } });
  const invite = await prisma.article.create({
    data: { projectId: project.id, slug: "invite", title: "Invite your team", body: "", publishedAt: new Date(), collectionId: collection.id },
  });
  const billing = await prisma.article.create({ data: { projectId: project.id, slug: "billing", title: "Billing", body: "", publishedAt: new Date() } });
  const sample = await prisma.article.create({ data: { projectId: project.id, slug: "sample", title: "Sample", body: "", publishedAt: new Date(), sample: true } });
  const other = await createProject(owner);
  const elsewhere = await prisma.article.create({ data: { projectId: other.id, slug: "invite", title: "Invite", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({
    data: [
      { articleId: invite.id, day: today(), views: 3 },
      { articleId: invite.id, day: daysAgo(2), views: 4 },
      // Before the report's 30 days.
      { articleId: invite.id, day: daysAgo(30), views: 100 },
      { articleId: billing.id, day: today(), views: 1 },
      { articleId: sample.id, day: today(), views: 50 },
      { articleId: elsewhere.id, day: today(), views: 50 },
    ],
  });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: invite.id, readerId: "a", helpful: true },
      { articleId: invite.id, readerId: "b", helpful: false, comment: "How do I invite by email?" },
      { articleId: billing.id, readerId: "a", helpful: true, updatedAt: daysAgo(40) },
    ],
  });
  await prisma.docsSearchDay.createMany({
    data: [
      { projectId: project.id, day: today(), searches: 5, failed: 2 },
      { projectId: other.id, day: today(), searches: 9, failed: 9 },
    ],
  });
  await prisma.docsFailedSearchDay.create({ data: { projectId: project.id, day: today(), query: "refunds", count: 2 } });

  const report = await docsReport(project.id, past30());
  expect(report.days).toHaveLength(30);
  expect(report.days.at(-1)).toBe(today().toISOString().slice(0, 10));
  expect(report.daily.views.at(-1)).toBe(4);
  expect(report.daily.views.at(-3)).toBe(4);
  expect(report.daily.searches.at(-1)).toBe(5);
  expect(report.daily.failed.at(-1)).toBe(2);
  expect(report.totals).toEqual({ views: 8, searches: 5, failedSearches: 2, helpful: 1, notHelpful: 1, publishedArticles: 2 });
  expect(report.articles).toEqual([
    { slug: "invite", title: "Invite your team", collection: "Basics", published: true, views: 7, helpful: 1, notHelpful: 1 },
    { slug: "billing", title: "Billing", collection: null, published: true, views: 1, helpful: 0, notHelpful: 0 },
  ]);
  expect(report.comments.map((comment) => comment.comment)).toEqual(["How do I invite by email?"]);
  expect(report.failedSearches).toEqual([{ query: "refunds", count: 2, dismissed: false }]);

  // The overview: its numbers, and the most read articles.
  actAs(owner);
  const overview = await page(ReportingOverviewPage);
  expect(overview).toContain("|Article views||8|");
  expect(overview).toContain("|Found it helpful||50%|");
  expect(overview).toContain("|Invite your team|");
  expect(overview).toContain("|7 views|");
});

test("a range counts only its own days: yesterday leaves today out, the past year reaches back a year", async () => {
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "a", title: "A", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({
    data: [
      { articleId: article.id, day: today(), views: 1 },
      { articleId: article.id, day: daysAgo(1), views: 2 },
      { articleId: article.id, day: daysAgo(200), views: 4 },
    ],
  });
  await prisma.docsSearchDay.createMany({
    data: [
      { projectId: project.id, day: daysAgo(1), searches: 3, failed: 1 },
      { projectId: project.id, day: daysAgo(200), searches: 5, failed: 0 },
    ],
  });
  const views = async (key: string) => (await docsReport(project.id, reportRange(key))).totals.views;
  expect([await views("today"), await views("yesterday"), await views("7d"), await views("year")]).toEqual([1, 2, 3, 7]);
  const year = await docsReport(project.id, reportRange("year"));
  expect([year.days.length, year.totals.searches]).toEqual([365, 8]);
  // reports.get takes the range too (the past 30 days by default).
  const report = (input: Record<string, unknown>) => call(getReports, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, input);
  expect((await report({})).docs.totals.views).toBe(3);
  expect((await report({ range: "yesterday" })).docs.totals.views).toBe(2);
  await expect(report({ range: "forever" })).rejects.toMatchObject({ status: 400 });
});

test("Searches lists every search that found nothing, so it adds up to Found nothing: a dismissed one marked, after the rest", async () => {
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: daysAgo(1), searches: 6, failed: 5 } });
  await prisma.docsFailedSearchDay.createMany({
    data: [
      { projectId: project.id, day: daysAgo(1), query: "refunds", count: 3 },
      { projectId: project.id, day: daysAgo(1), query: "crypto", count: 2 },
    ],
  });
  await prisma.docsGapDismissal.create({ data: { projectId: project.id, question: "refunds", dismissedAt: new Date() } });
  const { totals, failedSearches } = await docsReport(project.id, past30());
  expect(totals.failedSearches).toBe(5);
  expect(failedSearches).toEqual([
    { query: "crypto", count: 2, dismissed: false },
    { query: "refunds", count: 3, dismissed: true },
  ]);
  actAs(owner);
  const html = await page(ReportingSearchesPage);
  const row = (query: string) => html.slice(html.indexOf(`|${query}|`), html.indexOf("Write an article", html.indexOf(`|${query}|`)));
  expect(row("refunds")).toContain("|Dismissed|");
  expect(row("crypto")).not.toContain("Dismissed");
});

test("Articles sort by a column's heading, the most first: Views unless another is picked", async () => {
  const read = await prisma.article.create({ data: { projectId: project.id, slug: "read", title: "Most read", body: "", publishedAt: new Date() } });
  const disliked = await prisma.article.create({ data: { projectId: project.id, slug: "disliked", title: "Least liked", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({ data: [{ articleId: read.id, day: today(), views: 5 }, { articleId: disliked.id, day: today(), views: 1 }] });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: disliked.id, readerId: "a", helpful: false },
      { articleId: disliked.id, readerId: "b", helpful: false },
    ],
  });
  actAs(owner);
  const order = (html: string) => [...html.matchAll(/\|(Most read|Least liked)\|/g)].map((m) => m[1]);
  expect(order(await page(ReportingArticlesPage))).toEqual(["Most read", "Least liked"]);
  const byNotHelpful = await page(ReportingArticlesPage, { sort: "notHelpful" });
  expect(order(byNotHelpful)).toEqual(["Least liked", "Most read"]);
  // The heading in use says so, for screen readers.
  const html = renderToStaticMarkup(await ReportingArticlesPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ sort: "notHelpful" }) } as never));
  expect(html).toMatch(/<th scope="col" aria-sort="descending"[^>]*><a[^>]*>Not helpful<\/a>/);
});

test("AI conversations: a question and its follow-ups are one conversation, answered, passed to the team or not, listed with their turns", async () => {
  const asker = await signUp("Reader");
  const asked = (data: { question: string; followsId?: string; status?: "ANSWERED" | "NO_ANSWER"; createdAt?: Date } & Record<string, unknown>) =>
    prisma.docsQuestion.create({
      data: { projectId: project.id, askerId: asker.id, source: "WIDGET", status: "ANSWERED", answer: "From the Team page.", ...data },
    });
  // Two turns: the follow-up unanswered and passed to the team.
  const first = await asked({ question: "How do I invite?", createdAt: yesterdayAt(10) });
  await asked({ question: "And by email?", followsId: first.id, status: "NO_ANSWER", answer: null, escalatedAt: yesterdayAt(10, 5), createdAt: yesterdayAt(10, 5) });
  // One turn, answered, with a thumbs up.
  await asked({ question: "Is there SSO?", helpful: true, createdAt: yesterdayAt(12) });
  // Before the report's days, and another project's.
  await asked({ question: "Old one", createdAt: daysAgo(31) });
  const other = await createProject(owner);
  await prisma.docsQuestion.create({ data: { projectId: other.id, askerId: "x", source: "API", question: "Elsewhere", status: "ANSWERED" } });

  const report = await aiReport(project.id, past30());
  expect(report.totals).toEqual({ conversations: 2, escalated: 1, answered: 1, helpful: 1, notHelpful: 0 });
  // Both started yesterday: one handled by the AI, one passed to the team.
  expect([report.daily.handled.at(-2), report.daily.escalated.at(-2)]).toEqual([1, 1]);
  expect(report.daily.handled.reduce((a, b) => a + b) + report.daily.escalated.reduce((a, b) => a + b)).toBe(2);
  expect(report.conversations.map((c) => [c.turns.map((turn) => turn.question), c.answered, c.escalated, c.asker, c.source])).toEqual([
    [["Is there SSO?"], 1, false, "Reader", "widget"],
    [["How do I invite?", "And by email?"], 1, true, "Reader", "widget"],
  ]);
  expect((await aiReport(project.id, past30(), "escalated")).conversations.map((c) => c.turns[0]!.question)).toEqual(["How do I invite?"]);
  expect((await aiReport(project.id, past30(), "unanswered")).conversations.map((c) => c.turns[0]!.question)).toEqual(["How do I invite?"]);
  const { ai } = await call(getReports, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  expect(ai.gaps.map((gap) => gap.question)).toEqual(["And by email?"]);

  actAs(owner);
  const html = await page(ReportingAiConversationsPage, { show: "escalated" });
  expect(html).toContain("|How do I invite?|");
  expect(html).toContain("|Partly answered|");
  expect(html).toContain("|Passed to your team|");
  expect(html).not.toContain("|Is there SSO?|");
});

test("inbox: new conversations by day and where they began, the median first reply, open now and replies per teammate; spam and notes left out", async () => {
  const teammate = await addMember(project.id, "MEMBER");
  let number = 0;
  const conversation = (data: { origin: "WIDGET" | "EMAIL" | "ESCALATION" | "API"; createdAt: Date; spam?: boolean; status?: "OPEN" | "WAITING" | "CLOSED" }) =>
    prisma.conversation.create({ data: { projectId: project.id, number: ++number, subject: "Help", ...data } });
  const reply = (conversationId: string, createdAt: Date, note = false) =>
    prisma.conversationMessage.create({ data: { projectId: project.id, conversationId, author: "TEAM", authorId: teammate.id, channel: "APP", body: "Hi", note, createdAt } });

  const widget = await conversation({ origin: "WIDGET", createdAt: minutesAgo(90), status: "WAITING" });
  // A note isn't a reply: the first reply is 30 minutes in.
  await reply(widget.id, minutesAgo(80), true);
  await reply(widget.id, minutesAgo(60));
  await reply(widget.id, minutesAgo(50));
  const email = await conversation({ origin: "EMAIL", createdAt: minutesAgo(200), status: "CLOSED" });
  await reply(email.id, minutesAgo(110));
  await conversation({ origin: "ESCALATION", createdAt: minutesAgo(5), status: "OPEN" });
  // Snoozed: out of the inbox's open ones till it wakes, so not open now either.
  await prisma.conversation.update({
    where: { id: (await conversation({ origin: "API", createdAt: minutesAgo(3), status: "OPEN" })).id },
    data: { snoozedUntil: new Date(Date.now() + 3_600_000), snoozedAt: new Date() },
  });
  const spam = await conversation({ origin: "EMAIL", createdAt: minutesAgo(5), spam: true });
  await reply(spam.id, minutesAgo(4));

  const report = await inboxReport(project.id, past30());
  expect(report.daily.created.reduce((a, b) => a + b, 0)).toBe(4);
  expect(report.origins).toEqual({ widget: 1, email: 1, escalation: 1, api: 1 });
  // 30 and 90 minutes: the median of the two replied to is 60.
  expect(report.totals).toEqual({ conversations: 4, fromAi: 1, replied: 2, medianFirstReply: 3600, openNow: 1 });
  expect(report.teammates).toEqual([{ id: teammate.id, name: "member user", replies: 3, conversations: 2 }]);

  actAs(owner);
  const html = await page(ReportingInboxPage);
  expect(html).toContain("|First reply||1 h|");
  expect(html).toContain("|member user||3||2|");
});

test("reports.get is the team's: all three reports", async () => {
  const result = await call(getReports, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  expect(Object.keys(result)).toEqual(["docs", "ai", "inbox"]);
  expect(result.ai.totals.conversations).toBe(0);
});

test("only the project's team sees Reporting", async () => {
  const outcome = () =>
    page(ReportingInboxPage).then(
      () => "shown",
      (error: { digest?: string }) => error.digest,
    );
  actAs(null);
  expect(await outcome()).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  actAs(await signUp(`Outsider ${randomUUID().slice(0, 4)}`));
  expect(await outcome()).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  actAs(await addMember(project.id, "MEMBER"));
  expect(await outcome()).toBe("shown");
});

test("the AI report reads the same whatever the database's time zone: days and times are UTC, as Prisma keeps them", async () => {
  // Late yesterday (UTC): already today east of UTC, still yesterday at noon west of it.
  const lastAt = yesterdayAt(23, 30);
  await prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "PORTAL", question: "Late?", status: "ANSWERED", createdAt: lastAt } });
  const [{ name }] = await prisma.$queryRaw<[{ name: string }]>`SELECT current_database() AS name`;
  const zone = async (tz: string) => {
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone = '${tz}'`);
    await prisma.$disconnect();
  };
  try {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles"]) {
      await zone(tz);
      const report = await aiReport(project.id, past30());
      expect([report.daily.handled.at(-2), report.daily.handled.at(-1), report.totals.conversations]).toEqual([1, 0, 1]);
      expect(report.conversations[0]!.lastAt).toBe(lastAt.toISOString());
    }
  } finally {
    await zone("UTC");
  }
});
