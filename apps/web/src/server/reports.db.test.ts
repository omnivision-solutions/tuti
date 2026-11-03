import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import ReportingAiConversationsPage from "@/app/app/[project]/reporting/ai-conversations/page";
import ReportingArticlesPage from "@/app/app/[project]/reporting/articles/page";
import ReportingInboxPage from "@/app/app/[project]/reporting/inbox/page";
import ReportingSearchesPage from "@/app/app/[project]/reporting/searches/page";
import ReportingOverviewPage from "@/app/app/[project]/reporting/page";
import { type RangeKey, reportRange } from "@/lib/report-range";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { getDocsInsights } from "./operations/docs-insights";
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
  vi.unstubAllEnvs();
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
  expect(report.failedSearches).toEqual([{ query: "refunds", count: 2, before: 0, dismissed: false }]);

  // The overview: its numbers, and the most read articles.
  actAs(owner);
  const overview = await page(ReportingOverviewPage);
  expect(overview).toContain("|Article views|||8|");
  expect(overview).toContain("|Found it helpful|||50%|");
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

test("Yesterday counts only yesterday's, today's left out, in every list and count", async () => {
  const teammate = await addMember(project.id, "MEMBER");
  const [yesterday, now] = [yesterdayAt(12), minutesAgo(30)];
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "a", title: "A", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({ data: [{ articleId: article.id, day: daysAgo(1), views: 2 }, { articleId: article.id, day: today(), views: 5 }] });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: article.id, readerId: "y", helpful: false, comment: "Yesterday's", updatedAt: yesterday },
      { articleId: article.id, readerId: "t", helpful: false, comment: "Today's", updatedAt: now },
    ],
  });
  await prisma.docsFailedSearchDay.createMany({
    data: [
      { projectId: project.id, day: daysAgo(1), query: "yesterday's search", count: 1 },
      { projectId: project.id, day: today(), query: "today's search", count: 1 },
    ],
  });
  await prisma.docsQuestion.createMany({
    data: [
      { projectId: project.id, askerId: "x", source: "PORTAL", question: "Yesterday's question?", status: "NO_ANSWER", createdAt: yesterday },
      { projectId: project.id, askerId: "x", source: "PORTAL", question: "Today's question?", status: "NO_ANSWER", createdAt: now },
    ],
  });
  for (const [number, createdAt, origin] of [[1, yesterday, "WIDGET"], [2, now, "EMAIL"]] as const) {
    const { id } = await prisma.conversation.create({ data: { projectId: project.id, number, subject: "Help", origin, createdAt } });
    await prisma.conversationMessage.create({
      data: { projectId: project.id, conversationId: id, author: "TEAM", authorId: teammate.id, channel: "APP", body: "Hi", createdAt: new Date(createdAt.getTime() + 600_000) },
    });
  }

  const range = reportRange("yesterday");
  const docs = await docsReport(project.id, range);
  expect(docs.totals).toMatchObject({ views: 2, notHelpful: 1 });
  expect(docs.articles.map((a) => [a.slug, a.views, a.notHelpful])).toEqual([["a", 2, 1]]);
  expect(docs.comments.map((c) => c.comment)).toEqual(["Yesterday's"]);
  expect(docs.failedSearches.map((f) => f.query)).toEqual(["yesterday's search"]);
  const inbox = await inboxReport(project.id, range);
  expect(inbox.totals).toMatchObject({ conversations: 1, replied: 1, medianFirstReply: 600 });
  expect(inbox.origins).toEqual({ widget: 1, email: 0, escalation: 0, api: 0 });
  expect(inbox.teammates).toEqual([{ id: teammate.id, name: "member user", replies: 1, conversations: 1 }]);
  const { ai } = await call(getReports, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { range: "yesterday" });
  expect(ai.gaps.map((gap) => gap.question)).toEqual(["Yesterday's question?"]);
  expect(ai.totals.conversations).toBe(1);
});

test("Searches lists every search that found nothing, so it adds up to Found nothing: ranked by those since any dismissal, as Home ranks them", async () => {
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: daysAgo(1), searches: 12, failed: 10 } });
  await prisma.docsFailedSearchDay.createMany({
    data: [
      // Searched 3 times, dismissed, then once more: 1 since, as Home counts it.
      { projectId: project.id, day: daysAgo(3), query: "refunds", count: 3 },
      { projectId: project.id, day: daysAgo(1), query: "refunds", count: 1 },
      { projectId: project.id, day: daysAgo(1), query: "crypto", count: 2 },
      // Dismissed, not searched since.
      { projectId: project.id, day: daysAgo(2), query: "spam", count: 4 },
    ],
  });
  await prisma.docsGapDismissal.createMany({
    data: [
      { projectId: project.id, question: "refunds", dismissedAt: yesterdayAt(-24) },
      { projectId: project.id, question: "spam", dismissedAt: new Date() },
    ],
  });
  const { totals, failedSearches } = await docsReport(project.id, past30());
  expect(totals.failedSearches).toBe(10);
  expect(failedSearches).toEqual([
    { query: "crypto", count: 2, before: 0, dismissed: false },
    { query: "refunds", count: 4, before: 3, dismissed: false },
    { query: "spam", count: 4, before: 4, dismissed: true },
  ]);
  actAs(owner);
  const html = await page(ReportingSearchesPage);
  const row = (query: string) => html.slice(html.indexOf(`|${query}|`), html.indexOf("Write an article", html.indexOf(`|${query}|`)));
  expect(row("refunds")).toContain("|4 searches, 3 before you dismissed it|");
  expect(row("refunds")).not.toContain("Dismissed");
  expect(row("spam")).toContain("|Dismissed|");
  expect(row("crypto")).toContain("|2 searches|");
});

test("Searches lists the 50 most searched, and counts the rest, so the card adds up to Found nothing", async () => {
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: daysAgo(1), searches: 60, failed: 55 } });
  // 51 kept with their words (2 each for the first, 1 for the rest); 3 more past the day's kept words.
  await prisma.docsFailedSearchDay.createMany({
    data: Array.from({ length: 51 }, (_, i) => ({ projectId: project.id, day: daysAgo(1), query: `query ${String(i).padStart(2, "0")}`, count: i === 0 ? 2 : 1 })),
  });
  const { failedSearches } = await docsReport(project.id, past30());
  expect([failedSearches.length, failedSearches[0]!.query, failedSearches.at(-1)!.query]).toEqual([50, "query 00", "query 49"]);
  actAs(owner);
  expect(await page(ReportingSearchesPage)).toContain("|And 4 more searches that found nothing.|");
});

test("a range starting before this server kept searches a year says since when they're counted: 29 days before it switched", async () => {
  await prisma.installation.update({ where: { singleton: 1 }, data: { searchesKeptAt: new Date("2027-03-01T10:00:00Z") } });
  // Pruned by the worker (with inline jobs nothing is pruned: no word, below).
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  const range = (since: string, until: string) => {
    const days = Array.from({ length: (Date.parse(until) - Date.parse(since)) / 86_400_000 }, (_, i) => new Date(Date.parse(since) + i * 86_400_000).toISOString().slice(0, 10));
    return { ...reportRange("30d"), since: new Date(since), until: new Date(until), days };
  };
  const since = async (from: string, to: string) => (await docsReport(project.id, range(from, to))).searchesSince;
  // Kept 30 days till it switched: from Jan 31.
  expect(await since("2026-06-01", "2027-06-01")).toBe("2027-01-31");
  expect(await since("2026-01-01", "2026-02-01")).toBe("2027-01-31");
  expect(await since("2027-01-31", "2027-06-01")).toBeNull();
  vi.stubEnv("JOBS_DRIVER", "inline");
  expect(await since("2026-06-01", "2027-06-01")).toBeNull();
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
  expect(html).toContain("|First reply|||1 h|");
  expect(html).toContain("|member user||3||2|");
});

test("each report's tiles compare it with as many days just before: those days' totals, their own turns only, searches not when pruned", async () => {
  // The past 30 days' previous days: 59 to 30 days ago, the last of them (as today is half over) half counted.
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "a", title: "A", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({
    data: [
      { articleId: article.id, day: today(), views: 3 },
      { articleId: article.id, day: daysAgo(30), views: 5 },
      { articleId: article.id, day: daysAgo(59), views: 2 },
      { articleId: article.id, day: daysAgo(60), views: 100 },
    ],
  });
  await prisma.docsSearchDay.create({ data: { projectId: project.id, day: daysAgo(35), searches: 4, failed: 1 } });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: article.id, readerId: "a", helpful: true, updatedAt: daysAgo(40) },
      { articleId: article.id, readerId: "b", helpful: false },
    ],
  });
  const docs = await docsReport(project.id, past30());
  expect(docs.totals).toMatchObject({ views: 3, searches: 0, helpful: 0, notHelpful: 1 });
  expect(docs.before).toEqual({ views: 5, searches: 4, failedSearches: 1, helpful: 1, notHelpful: 0 });
  // Searches kept a year from yesterday (pruned at 30 days before): the previous days' were partly pruned, so not compared. Nor
  // those before Past year, a year further back than any are kept, however long ago it switched.
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  await prisma.installation.update({ where: { singleton: 1 }, data: { searchesKeptAt: daysAgo(1) } });
  expect((await docsReport(project.id, past30())).before).toMatchObject({ views: 5, searches: null, failedSearches: null });
  await prisma.installation.update({ where: { singleton: 1 }, data: { searchesKeptAt: daysAgo(800) } });
  expect((await docsReport(project.id, past30())).before).toMatchObject({ searches: 4, failedSearches: 1 });
  expect((await docsReport(project.id, reportRange("year"))).before).toMatchObject({ views: 0, searches: null, failedSearches: null });

  // A conversation from 31 days ago, passed to the team only by today's follow-up: the previous days' and not escalated; in neither's
  // count today.
  const asked = (data: Record<string, unknown> & { question: string; createdAt: Date }) =>
    prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", status: "ANSWERED", ...data } });
  const old = await asked({ question: "Old", createdAt: daysAgo(31), helpful: true });
  await asked({ question: "Still?", followsId: old.id, status: "NO_ANSWER", escalatedAt: minutesAgo(5), createdAt: minutesAgo(5) });
  await asked({ question: "New", createdAt: yesterdayAt(9), escalatedAt: yesterdayAt(9, 1) });
  const ai = await aiReport(project.id, past30());
  expect(ai.totals).toEqual({ conversations: 1, escalated: 1, answered: 1, helpful: 0, notHelpful: 0 });
  expect(ai.before).toEqual({ conversations: 1, escalated: 0, answered: 1, helpful: 1, notHelpful: 0 });
  expect(ai.conversations.map((c) => c.turns.map((turn) => turn.question))).toEqual([["New"]]);

  let number = 0;
  const conversation = (origin: "WIDGET" | "ESCALATION", createdAt: Date) =>
    prisma.conversation.create({ data: { projectId: project.id, number: ++number, subject: "Help", origin, createdAt } });
  const reply = async (conversationId: string, createdAt: Date) =>
    prisma.conversationMessage.create({ data: { projectId: project.id, conversationId, author: "TEAM", authorId: owner.id, channel: "APP", body: "Hi", createdAt } });
  await reply((await conversation("ESCALATION", daysAgo(40))).id, new Date(daysAgo(40).getTime() + 3_600_000));
  // Replied to only 35 days on: later than today's could have been (the range's 30 days), so as unreplied as they are.
  await reply((await conversation("WIDGET", daysAgo(35))).id, minutesAgo(10));
  await conversation("WIDGET", minutesAgo(30));
  const inbox = await inboxReport(project.id, past30());
  expect(inbox.totals).toMatchObject({ conversations: 1, fromAi: 0, medianFirstReply: null });
  expect(inbox.before).toEqual({ conversations: 2, fromAi: 1, medianFirstReply: 3600 });

  // With plans, conversations and AI questions are deleted after a year: Past year's previous days aren't compared, a quarter's are.
  vi.stubEnv("PLANS", "on");
  expect((await aiReport(project.id, reportRange("year"))).before).toBeNull();
  expect((await inboxReport(project.id, reportRange("year"))).before).toBeNull();
  expect((await inboxReport(project.id, reportRange("quarter"))).before).toMatchObject({ conversations: 0 });
  vi.stubEnv("PLANS", "");

  // The tiles: up or down on the 30 days before, and better or worse.
  actAs(owner);
  vi.stubEnv("JOBS_DRIVER", "inline");
  const overview = await page(ReportingOverviewPage);
  expect(overview).toContain("|Down 40% on the 30 days before|");
  expect(overview).toContain("|Down 100 pts on the 30 days before|");
  // Said once under the numbers too, for those who can't hover a badge.
  expect(overview).toContain("|Changes are on the 30 days before.|");
});

test("while today is under way, the day before counts only as much of it: as steady a day reads the same; a past range compares whole days", async () => {
  // Noon (the frozen clock): 4 views so far today, 8 yesterday.
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "a", title: "A", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.createMany({
    data: [
      { articleId: article.id, day: today(), views: 4 },
      { articleId: article.id, day: daysAgo(1), views: 8 },
      { articleId: article.id, day: daysAgo(2), views: 6 },
    ],
  });
  expect((await docsReport(project.id, reportRange("today"))).before.views).toBe(4);
  expect((await docsReport(project.id, reportRange("yesterday"))).before.views).toBe(6);
  actAs(owner);
  expect(await page(ReportingOverviewPage, { range: "today" })).toContain("|Same as the day before|");
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

test("a range's AI conversations hold only its own turns: yesterday's leaves out today's follow-up", async () => {
  const first = await prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: "x", source: "WIDGET", question: "How do I invite?", status: "ANSWERED", createdAt: yesterdayAt(23) },
  });
  await prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: "x", source: "WIDGET", question: "And by email?", followsId: first.id, status: "NO_ANSWER", escalatedAt: minutesAgo(5), createdAt: minutesAgo(5) },
  });
  const yesterday = await aiReport(project.id, reportRange("yesterday"));
  expect(yesterday.totals).toMatchObject({ conversations: 1, answered: 1, escalated: 0 });
  expect(yesterday.conversations[0]!.turns.map((turn) => turn.question)).toEqual(["How do I invite?"]);
  // Over the days of both, both turns.
  expect((await aiReport(project.id, past30())).totals).toMatchObject({ conversations: 1, answered: 0, escalated: 1 });
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

test("reports.get by plan: Free refused, Pro up to a month, Business every range; every range without plans", async () => {
  const report = (range: RangeKey) => call(getReports, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { range });
  const plan = (to: "FREE" | "PRO" | "BUSINESS") => prisma.project.update({ where: { id: project.id }, data: { plan: to } });
  expect((await report("year")).docs.days).toHaveLength(365);

  vi.stubEnv("PLANS", "on");
  await expect(report("7d")).rejects.toMatchObject({ status: 402, message: "Reporting needs the Pro plan. See Settings → Billing." });
  // Nor its numbers through docs.insights (the past 30 days).
  const insights = () => call(getDocsInsights, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  await expect(insights()).rejects.toMatchObject({ status: 402 });
  await plan("PRO");
  for (const range of ["today", "month", "last-month", "30d"] as const) {
    await expect(report(range)).resolves.toHaveProperty("docs");
  }
  await expect(insights()).resolves.toHaveProperty("gaps");
  for (const range of ["quarter", "year"] as const) {
    await expect(report(range)).rejects.toMatchObject({ status: 402, message: "Ranges longer than a month need the Business plan. See Settings → Billing." });
  }
  await plan("BUSINESS");
  expect((await report("year")).docs.days).toHaveLength(365);
});

test("on Free, Reporting's pages are made-up numbers, blurred under a card saying which plan has them; a Pro range past a month shows the default", async () => {
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "secret", title: "Our secret article", body: "", publishedAt: new Date() } });
  await prisma.articleViewDay.create({ data: { articleId: article.id, day: today(), views: 7777 } });
  actAs(owner);
  expect(await page(ReportingOverviewPage)).toContain("7,777");

  vi.stubEnv("PLANS", "on");
  const free = await page(ReportingOverviewPage);
  expect(free).toContain("Reporting needs the Pro plan.");
  expect(free).toContain("See plans");
  expect(free).toContain("Getting started");
  expect(free).not.toContain("7,777");
  expect(free).not.toContain("Our secret article");
  actAs(await addMember(project.id, "MEMBER"));
  const member = await page(ReportingArticlesPage);
  expect(member).toContain("An owner or admin can upgrade.");
  expect(member).not.toContain("See plans");
  expect(member).not.toContain("Our secret article");

  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const pro = await page(ReportingOverviewPage, { range: "year" });
  expect(pro).not.toContain("Reporting needs");
  expect(pro).toContain("7,777");
  expect(pro).toContain("|Past 30 days|");
  expect(pro).not.toContain("Past year");
});
