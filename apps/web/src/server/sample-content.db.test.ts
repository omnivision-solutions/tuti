import { Prisma, prisma } from "@tuti/db";
import { embedPosts, embedPublishedArticles, handlers } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, startOpenAIFake } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { generateMetadata as changelogMetadata } from "@/app/portal/[project]/(site)/changelog/[number]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { generateMetadata as docsMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { generateMetadata as postMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import { GET as rss } from "@/app/portal/[project]/(site)/changelog/rss.xml/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { postPath } from "@/lib/post-urls";
import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { entryTold, publishedEntries } from "./changelog-queries";
import { homeOverview } from "./home";
import { emailedOnCompletion } from "./operations/code-changes";
import { docsInsights } from "./operations/docs-insights";
import { votersToEmail } from "./post-lists";
import { mailSubdomain } from "./inbound";
import { createComment, createPost } from "./operations/create";
import { replyToConversation } from "./operations/conversations";
import { findPostsToComplete } from "./changelog";
import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle, updateArticle, updateCollection } from "./operations/docs";
import { mergePost, updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { addSampleContent, removeSampleContent, setProjectUses } from "./projects";
import { lockSampleContent } from "./sample-content";

/** Sample content (server/sample-content.ts): what's added for the picks, that nothing goes out, and that removing takes exactly it. */

// Whatever is queued or sent to webhooks, spied on.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(), emitEvent: vi.fn(), recordEvent: vi.fn() }));
vi.mock("@tuti/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tuti/jobs")>();
  return {
    ...real,
    enqueue: (...args: Parameters<typeof real.enqueue>) => (jobs.enqueue(...args), real.enqueue(...args)),
    emitEvent: (...args: Parameters<typeof real.emitEvent>) => (jobs.emitEvent(...args), real.emitEvent(...args)),
    recordEvent: (...args: Parameters<typeof real.recordEvent>) => (jobs.recordEvent(...args), real.recordEvent(...args)),
  };
});
// Adding or removing sample content can be made to fail, to check the actions say so instead of throwing.
const failing = vi.hoisted(() => ({ sample: false }));
vi.mock("./sample-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sample-content")>();
  const fails = <A extends unknown[]>(run: (...args: A) => Promise<void>) => (...args: A) => (failing.sample ? Promise.reject(new Error("database down")) : run(...args));
  return { ...real, addSampleContent: fails(real.addSampleContent), removeSampleContent: fails(real.removeSampleContent) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  failing.sample = false;
});

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  return { owner, project, team: { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id } };
}

/**
 * A sample post merged into a real one some other way than mergePosts (which refuses it): its votes and comments moved
 * over, as a merge moves them, for what removal does with such rows.
 */
async function mergedAnyway(fromId: string, toId: string) {
  await prisma.$executeRaw`
    INSERT INTO vote ("postId", "userId", "projectId", "createdAt")
    SELECT ${toId}, "userId", "projectId", "createdAt" FROM vote WHERE "postId" = ${fromId} ON CONFLICT DO NOTHING`;
  await prisma.$executeRaw`DELETE FROM vote WHERE "postId" = ${fromId}`;
  await prisma.$executeRaw`UPDATE comment SET "postId" = ${toId} WHERE "postId" = ${fromId}`;
  await prisma.post.update({ where: { id: fromId }, data: { duplicateOfId: toId, voteCount: 0, commentCount: 0 } });
  await prisma.$executeRaw`
    UPDATE post SET "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = ${toId}), "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = ${toId})
    WHERE id = ${toId}`;
}

/** The project's sample rows, kind by kind. */
async function samples(projectId: string) {
  const sample = { projectId, sample: true };
  const [posts, collections, articles, entries, conversations] = await Promise.all([
    prisma.post.findMany({ where: sample, orderBy: { number: "asc" }, include: { votes: true, comments: true, events: true } }),
    prisma.collection.findMany({ where: sample }),
    prisma.article.findMany({ where: sample, orderBy: { order: "asc" } }),
    prisma.changelogEntry.findMany({ where: sample }),
    prisma.conversation.findMany({ where: sample, include: { messages: true } }),
  ]);
  return { posts, collections, articles, entries, conversations };
}

test("adds the sample content for what the team picked, marked, emailing, queueing and counting nothing; added again, nothing doubles", async () => {
  const { project, owner } = await setup();
  await setProjectUses(project.slug, ["feedback", "docs"]);
  const emailed = mailbox.emails.length;
  jobs.enqueue.mockClear();
  jobs.emitEvent.mockClear();

  expect(await addSampleContent(project.slug)).toEqual({});
  let found = await samples(project.id);
  // Feedback: three posts on the board with votes, the first with a comment and a status (and its event).
  expect(found.posts.map((post) => [post.title, post.status, post.voteCount, post.votes.length, post.commentCount, post.comments.length])).toEqual([
    ["Dark mode", "PLANNED", 3, 3, 1, 1],
    ["Export reports to CSV", "OPEN", 2, 2, 0, 0],
    ["Slack notifications", "OPEN", 1, 1, 0, 0],
  ]);
  expect(found.posts[0]!.events.map((event) => [event.from, event.to])).toEqual([["OPEN", "PLANNED"]]);
  // By placeholder people nobody can email: never the team.
  const people = await prisma.user.findMany({ where: { id: { in: found.posts.flatMap((post) => post.votes.map((vote) => vote.userId)) } } });
  expect(people).toHaveLength(3);
  expect(people.every((person) => person.email.endsWith(".invalid") && !person.emailVerified && person.id !== owner.id)).toBe(true);
  // Docs: a collection of two published articles.
  expect(found.collections.map((c) => c.name)).toEqual(["Getting started"]);
  expect(found.articles.map((a) => [a.title, a.collectionId, a.publishedAt !== null])).toEqual([
    ["Create your account", found.collections[0]!.id, true],
    ["Invite your team", found.collections[0]!.id, true],
  ]);
  // Not picked: no changelog, no conversation.
  expect(found.entries).toEqual([]);
  expect(found.conversations).toEqual([]);

  // Picking the rest and adding again adds only what's missing.
  await setProjectUses(project.slug, ["feedback", "docs", "changelog", "support"]);
  jobs.enqueue.mockClear();
  jobs.emitEvent.mockClear();
  await addSampleContent(project.slug);
  await addSampleContent(project.slug);
  found = await samples(project.id);
  expect([found.posts.length, found.collections.length, found.articles.length]).toEqual([3, 1, 2]);
  expect(found.entries.map((e) => [e.title, e.publishedAt !== null, e.announced])).toEqual([["Welcome to our changelog", true, false]]);
  expect(found.conversations.map((c) => [c.subject, c.status, c.messages.length])).toEqual([["Can I export my data?", "OPEN", 1]]);
  expect(await prisma.user.count({ where: { sampleProjectId: project.id } })).toBe(3);

  // Nothing emailed, queued or sent to webhooks.
  expect(mailbox.emails.length).toBe(emailed);
  expect(jobs.enqueue).not.toHaveBeenCalled();
  expect(jobs.emitEvent).not.toHaveBeenCalled();
  // Home counts none of it: no numbers, nothing waiting, nothing trending, no step done by it.
  const home = await homeOverview(project.id, project.slug, { emailVerified: false });
  expect(home.numbers).toEqual({ newPosts: 0, needReply: 0, updatesWaiting: 0, searchesFailed: 0 });
  expect(home.attention).toEqual([]);
  expect(home.moreAttention).toBe(0);
  expect(home.trending).toEqual([]);
  expect(home.setup!.filter((step) => step.key === "article" || step.key === "changelog").map((step) => step.done)).toEqual([false, false]);
});

test("removing takes exactly the sample content, edited or not, with what only it had; the team's own content stays", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const before = await samples(project.id);
  const [dark, csv] = before.posts;

  // The team's own: a post, an article in the sample collection and a collection inside it.
  const own = await call(createPost, team, { board: "feature-requests", title: "Single sign-on" });
  const ownArticle = await call(createArticle, team, { title: "Billing", body: "How we bill.", collection: before.collections[0]!.slug });
  await call(createCollection, team, { name: "Advanced", parent: before.collections[0]!.slug });
  // What the team did to sample content: a vote and a comment on it, and a status (it's still sample).
  await call(setVote, team, { number: dark!.number, voted: true });
  await call(createComment, team, { number: dark!.number, body: "Noted!" });
  // Completing a sample post emails nobody: its voters aren't real.
  const emailed = mailbox.emails.length;
  await call(updatePost, team, { number: csv!.number, status: "completed" });
  expect(mailbox.emails.length).toBe(emailed);
  // Sample and real posts don't merge either way: the sample people's votes would count on a real post, or a real
  // post's votes go with the sample content.
  await expect(call(mergePost, team, { number: dark!.number, into: own.number })).rejects.toThrow("Sample posts can only be merged into other sample posts");
  await expect(call(mergePost, team, { number: own.number, into: csv!.number })).rejects.toThrow("Sample posts are removed with the sample content");
  // Merged anyway (some other way): removal counts the team's post again without the sample people's rows.
  const ownId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).id;
  await mergedAnyway(dark!.id, ownId);
  expect(await prisma.post.findUniqueOrThrow({ where: { id: ownId } })).toMatchObject({ voteCount: 4, commentCount: 2 });

  expect(await removeSampleContent(project.slug)).toEqual({});

  const after = await samples(project.id);
  expect(after).toEqual({ posts: [], collections: [], articles: [], entries: [], conversations: [] });
  expect(await prisma.user.count({ where: { sampleProjectId: project.id } })).toBe(0);
  // Their comment and vote on the sample post went with it; the votes and comment it brought to their post went too.
  const ownPost = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number }, include: { votes: true, comments: true } });
  expect([ownPost.voteCount, ownPost.votes.length, ownPost.commentCount, ownPost.comments.length]).toEqual([1, 1, 1, 1]);
  expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(1);
  // The sample collection they put their own article and collection in stays, theirs now (its sample articles go).
  const kept = await prisma.collection.findUniqueOrThrow({ where: { id: before.collections[0]!.id }, include: { articles: true, children: true } });
  expect([kept.sample, kept.articles.map((a) => a.slug), kept.children.map((c) => c.name)]).toEqual([false, [ownArticle.slug], ["Advanced"]]);

  // Added again after removing: all of it, fresh.
  await addSampleContent(project.slug);
  expect((await samples(project.id)).posts).toHaveLength(3);
});

test("a reply in the sample conversation is never emailed: its person isn't real", async () => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  const { project, team } = await setup();
  await mailSubdomain(project.id);
  await addSampleContent(project.slug);
  const [conversation] = (await samples(project.id)).conversations;
  await call(replyToConversation, team, { number: conversation!.number, body: "Yes: Settings → Export." });
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
  const emailed = mailbox.emails.length;

  await handlers.sendConversationReplies({}, { info: () => {}, warn: () => {} });
  expect(mailbox.emails.length).toBe(emailed);
});

test("sample content is kept from search engines and AI tools: out of the sitemap and llms.txt, and noindex on its pages", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const { posts, collections, articles, entries } = await samples(project.id);
  // The team's own, published alongside: still listed and indexed.
  const own = await call(createPost, team, { board: "feature-requests", title: "Single sign-on" });
  const ownArticle = await call(createArticle, team, { title: "Billing", body: "How we bill." });
  await call(publishArticle, team, { slug: ownArticle.slug });
  const ownEntry = await call(createChangelogEntry, team, { title: "Faster search", body: "Search is quicker." });
  await call(publishChangelogEntry, team, { number: ownEntry.number, announce: false });
  actAs(null);
  const params = (more: object = {}) => ({ params: Promise.resolve({ project: project.slug, ...more }) }) as never;
  const request = new Request("http://x");

  const xml = await (await sitemap(request, params())).text();
  expect(xml).toContain(`${postPath({ ...own, board: { slug: "feature-requests" } })}<`);
  expect(xml).toContain(`/docs/${ownArticle.slug}<`);
  expect(xml).toContain(`/changelog/${ownEntry.number}<`);
  for (const post of posts) {
    expect(xml).not.toContain(`-${post.number}<`);
  }
  for (const page of [...articles, ...collections]) {
    expect(xml).not.toContain(`/docs/${page.slug}<`);
  }
  expect(xml).not.toContain(`/changelog/${entries[0]!.number}<`);

  const text = await (await llms(request, params())).text();
  expect(text).toContain(`/docs/${ownArticle.slug}.md`);
  for (const page of [...articles, ...collections]) {
    expect(text).not.toContain(`/docs/${page.slug}`);
  }

  // Each sample page says noindex (and the Markdown copy, x-robots-tag); the team's own don't.
  for (const page of [...articles, ...collections]) {
    expect((await docsMetadata(params({ slug: page.slug }))).robots).toEqual({ index: false });
  }
  expect((await docsMetadata(params({ slug: ownArticle.slug }))).robots).toBeUndefined();
  expect((await markdown(request, params({ slug: articles[0]!.slug }))).headers.get("x-robots-tag")).toBe("noindex");
  expect((await markdown(request, params({ slug: ownArticle.slug }))).headers.get("x-robots-tag")).toBeNull();
  const postParam = (post: { number: number; title: string }) => params({ board: "feature-requests", post: postPath({ ...post, board: { slug: "feature-requests" } }).split("/").at(-1) });
  expect((await postMetadata(postParam(posts[0]!))).robots).toEqual({ index: false });
  expect((await postMetadata(postParam(own))).robots).toBeUndefined();
  expect((await changelogMetadata(params({ number: String(entries[0]!.number) }))).robots).toEqual({ index: false });
  expect((await changelogMetadata(params({ number: String(ownEntry.number) }))).robots).toBeUndefined();
});

const log = { info: () => {}, warn: () => {} };

test("later on, sample content still reaches nobody: no notice to the team, no webhook or email from its posts, not in the RSS feed, never embedded", async () => {
  const { project, team, owner } = await setup();
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await addSampleContent(project.slug);
  const { posts, entries, articles } = await samples(project.id);
  // A real, verified reader voted on a sample post.
  const reader = await signUp("Rita Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await prisma.vote.create({ data: { projectId: project.id, postId: posts[1]!.id, userId: reader.id } });
  const emailed = mailbox.emails.length;
  jobs.enqueue.mockClear();
  jobs.emitEvent.mockClear();

  // The cron that tells the team about messages they didn't hear of skips the sample conversation.
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '3 minutes' WHERE "projectId" = ${project.id}`;
  await handlers.resubmitConversationNotices({}, log);
  // Completing a sample post, or replying to its voters, sends nothing: no webhook, no email.
  await call(updatePost, team, { number: posts[1]!.number, status: "completed" });
  await call(createComment, team, { number: posts[1]!.number, body: "Shipped!", emailVoters: true });
  expect(jobs.enqueue).not.toHaveBeenCalled();
  expect(jobs.emitEvent).not.toHaveBeenCalled();
  expect(mailbox.emails.length).toBe(emailed);
  expect(await prisma.comment.count({ where: { postId: posts[1]!.id, votersEmailDueAt: { not: null } } })).toBe(0);

  // The RSS feed has the team's own entry, not the sample one.
  const ownEntry = await call(createChangelogEntry, team, { title: "Faster search", body: "Search is quicker." });
  await call(publishChangelogEntry, team, { number: ownEntry.number, announce: false });
  const feed = await (await rss(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) } as never)).text();
  expect(feed).toContain(`/changelog/${ownEntry.number}<`);
  expect(feed).not.toContain(`/changelog/${entries[0]!.number}<`);

  // Embedding (an edit's job, or the backfill) leaves sample articles alone: no AI usage.
  const openai = await startOpenAIFake();
  try {
    vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
    vi.stubEnv("OPENAI_BASE_URL", openai.url);
    await handlers.articleChanged({ articleId: articles[0]!.id }, log);
    await embedPublishedArticles(log);
    expect(await prisma.articleChunk.count({ where: { articleId: { in: articles.map((a) => a.id) } } })).toBe(0);
  } finally {
    await openai.close();
  }
});

test("adding sample docs takes no slug a redirect of the team's has, so removing them leaves the redirect working", async () => {
  const { project, team } = await setup();
  await call(createCollection, team, { name: "Getting started" });
  await call(updateCollection, team, { slug: "getting-started", name: "Onboarding" });
  await addSampleContent(project.slug);
  const [collection] = (await samples(project.id)).collections;
  expect(collection!.slug).not.toBe("getting-started");
  await removeSampleContent(project.slug);
  expect(await prisma.docsRedirect.findFirst({ where: { projectId: project.id, slug: "getting-started" }, select: { collection: { select: { slug: true } } } })).toEqual({
    collection: { slug: "onboarding" },
  });
});

test("the sample people are the project's own accounts: an account at a look-alike address is never used or removed", async () => {
  const { project } = await setup();
  // Someone signed up at the address the sample people once had.
  const lookalike = await signUp("Mallory", `sample-0-${project.id}@users.tuti.invalid`);
  await addSampleContent(project.slug);
  const { posts, conversations } = await samples(project.id);
  const involved = [...posts.flatMap((p) => [p.authorId, ...p.votes.map((v) => v.userId), ...p.comments.map((c) => c.authorId)]), ...conversations.map((c) => c.userId)];
  expect(involved).not.toContain(lookalike.id);
  await removeSampleContent(project.slug);
  expect(await prisma.user.count({ where: { id: lookalike.id } })).toBe(1);
});

test("the team's update never takes a sample post (refused at save; linked anyway, publishing neither completes nor lists it), and the sample update published again emails nobody and isn't announced", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const { posts, entries } = await samples(project.id);
  const reader = await signUp("Rita Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await prisma.vote.create({ data: { projectId: project.id, postId: posts[1]!.id, userId: reader.id } });
  const emailed = mailbox.emails.length;
  jobs.enqueue.mockClear();
  jobs.recordEvent.mockClear();

  // The team's update can't take the sample post: refused at save, new or changed.
  const refused = "Sample posts can only be completed by the sample update";
  await expect(call(createChangelogEntry, team, { title: "Exports", body: "CSV exports are here.", posts: [posts[1]!.number] })).rejects.toThrow(refused);
  const own = await call(createChangelogEntry, team, { title: "Exports", body: "CSV exports are here." });
  await expect(call(updateChangelogEntry, team, { number: own.number, posts: [posts[1]!.number] })).rejects.toThrow(refused);
  // Linked anyway (some other way): publishing neither completes it nor lists it, in the webhook or on the portal.
  const ownId = (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).id;
  await prisma.changelogEntryPost.create({ data: { entryId: ownId, postId: posts[1]!.id } });
  await call(publishChangelogEntry, team, { number: own.number, announce: false });
  expect((await prisma.post.findUniqueOrThrow({ where: { id: posts[1]!.id } })).status).toBe("OPEN");
  expect(jobs.recordEvent.mock.calls.map((args) => [args[2], (args[3] as { posts: unknown[] }).posts])).toEqual([["changelog.published", []]]);
  expect((await publishedEntries(project.slug, { number: own.number, take: 1 }))[0]!.posts).toEqual([]);
  expect(await entryTold(ownId)).toBeNull();
  // The sample update, unpublished and published again (announced, by default): not announced, no webhook.
  jobs.recordEvent.mockClear();
  await call(unpublishChangelogEntry, team, { number: entries[0]!.number });
  await call(publishChangelogEntry, team, { number: entries[0]!.number });
  expect(jobs.recordEvent).not.toHaveBeenCalled();
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entries[0]!.id } })).announced).toBe(false);
  // Nor do a sample post's shipped emails go, however it got completed (the resubmit cron runs the same job).
  await prisma.post.update({ where: { id: posts[1]!.id }, data: { status: "COMPLETED" } });
  await handlers.postShipped({ postId: posts[1]!.id }, log);
  expect(jobs.enqueue).not.toHaveBeenCalledWith("postShipped", expect.anything());
  expect(mailbox.emails.length).toBe(emailed);
});

test("a sample collection the team has an unpublished move into is kept, so publishing that move later still lands there", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const [collection] = (await samples(project.id)).collections;
  const billing = await call(createArticle, team, { title: "Billing", body: "How we bill." });
  await call(publishArticle, team, { slug: billing.slug });
  await call(updateArticle, team, { slug: billing.slug, collection: collection!.slug });
  await removeSampleContent(project.slug);
  expect(await prisma.collection.findUniqueOrThrow({ where: { id: collection!.id }, select: { sample: true } })).toEqual({ sample: false });
  expect((await prisma.articleChanges.findFirstOrThrow({ where: { article: { slug: billing.slug, projectId: project.id } } })).collectionId).toBe(collection!.id);
});

test("the RSS feed fills its 50 with real updates when the sample one is among the newest", async () => {
  const { project } = await setup();
  // Fifty of the team's own, all older than the sample update added after them.
  await prisma.changelogEntry.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({ projectId: project.id, number: 100 + i, title: `Update ${i}`, publishedAt: new Date(Date.UTC(2026, 0, 1 + i)) })),
  });
  await setProjectUses(project.slug, ["changelog"]);
  await addSampleContent(project.slug);
  const feed = await (await rss(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) } as never)).text();
  expect(feed.match(/<item>/g)).toHaveLength(50);
  expect(feed).toContain(`/changelog/100<`);
  expect(feed).not.toContain("Welcome to our changelog");
});

test("Docs insights leave sample articles out: their views, their place in the top articles and their feedback", async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["docs"]);
  await addSampleContent(project.slug);
  const [sampleArticle] = (await samples(project.id)).articles;
  const own = await call(createArticle, team, { title: "Billing", body: "How we bill." });
  await call(publishArticle, team, { slug: own.slug });
  const ownId = (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: own.slug } })).id;
  const today = new Date(new Date().toISOString().slice(0, 10));
  await prisma.articleViewDay.createMany({ data: [{ articleId: sampleArticle!.id, day: today, views: 7 }, { articleId: ownId, day: today, views: 2 }] });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: sampleArticle!.id, readerId: "reader-1", helpful: false, comment: "Missing a step" },
      { articleId: ownId, readerId: "reader-1", helpful: false, comment: "Which plan?" },
    ],
  });

  const insights = await docsInsights(project.id);
  expect(insights.views).toBe(2);
  expect(insights.articles.map((article) => article.slug)).toEqual([own.slug]);
  expect(insights.comments.map((c) => c.comment)).toEqual(["Which plan?"]);
});

test("what the team's screens count as emailed leaves sample posts out: Completed's count and Email voters' are 0 on one", async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [, csv] = (await samples(project.id)).posts;
  const own = await call(createPost, team, { board: "feature-requests", title: "Single sign-on" });
  const ownId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).id;
  // A verified reader voted on both.
  const reader = await signUp("Rita Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await prisma.vote.createMany({ data: [csv!.id, ownId].map((postId) => ({ projectId: project.id, postId, userId: reader.id })) });

  const completing = await emailedOnCompletion(project.id, [csv!.id, ownId]);
  expect([completing.get(csv!.id) ?? 0, completing.get(ownId)]).toEqual([0, 1]);
  expect([await votersToEmail(project.id, csv!.id), await votersToEmail(project.id, ownId)]).toEqual([0, 1]);
});

test("a sample update completes sample posts only: saving a real post on it is refused, and Link post offers only sample ones", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const { posts, entries } = await samples(project.id);
  const own = await call(createPost, team, { board: "feature-requests", title: "Single sign-on" });
  await call(updatePost, team, { number: own.number, status: "planned" });
  const sampleEntry = entries[0]!.number;
  // A draft again, so its posts can change.
  await call(unpublishChangelogEntry, team, { number: sampleEntry });

  await expect(call(updateChangelogEntry, team, { number: sampleEntry, posts: [posts[0]!.number, own.number] })).rejects.toThrow(
    "Sample updates can only complete sample posts",
  );
  await call(updateChangelogEntry, team, { number: sampleEntry, posts: [posts[0]!.number] });
  expect(await prisma.changelogEntryPost.count({ where: { entryId: entries[0]!.id } })).toBe(1);

  // Publishing it never completes a real post, however one got linked.
  const ownId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).id;
  await prisma.changelogEntryPost.create({ data: { entryId: entries[0]!.id, postId: ownId } });
  await call(publishChangelogEntry, team, { number: sampleEntry });
  expect((await prisma.post.findUniqueOrThrow({ where: { id: ownId } })).status).toBe("PLANNED");
  expect((await prisma.post.findUniqueOrThrow({ where: { id: posts[0]!.id } })).status).toBe("COMPLETED");

  // Link post…: on the sample update, the planned sample post only; on the team's own, only theirs.
  const offered = async (sample: boolean) => ((await findPostsToComplete(project.slug, "", sample)).posts ?? []).map((post) => post.title).sort();
  expect(await offered(true)).toEqual(["Dark mode"]);
  expect(await offered(false)).toEqual(["Single sign-on"]);
});

test("removing sample content while a vote on a sample post is being saved: both finish (no deadlock)", async () => {
  const { project } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [dark] = (await samples(project.id)).posts;
  const reader = await signUp("Rita Reader");

  // A vote being saved, as setVote does: the post locked first, then the vote inserted (its foreign key on the project).
  let postLocked!: () => void;
  let insert!: () => void;
  const locked = new Promise<void>((resolve) => (postLocked = resolve));
  const goOn = new Promise<void>((resolve) => (insert = resolve));
  const vote = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM post WHERE id = ${dark!.id} FOR NO KEY UPDATE`;
      postLocked();
      await goOn;
      await tx.vote.create({ data: { projectId: project.id, postId: dark!.id, userId: reader.id } });
    },
    { timeout: 20_000 },
  );
  await locked;
  const removal = removeSampleContent(project.slug);
  // Once removal waits on the post's lock, the vote goes on to its insert.
  await untilWaitingOnLock();
  insert();
  expect((await Promise.allSettled([vote, removal])).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect((await samples(project.id)).posts).toEqual([]);
});

test("embedding posts (the post-created job, the backfill) leaves sample posts out: no AI usage, never a duplicate", async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [dark] = (await samples(project.id)).posts;
  const own = await call(createPost, team, { board: "feature-requests", title: "Dark theme" });
  const ownPost = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number } });
  const openai = await startOpenAIFake();
  try {
    vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
    vi.stubEnv("OPENAI_BASE_URL", openai.url);
    const text = (post: { id: string; title: string; body: string }) => ({ id: post.id, projectId: project.id, title: post.title, body: post.body });
    expect(await embedPosts([text(dark!), text(ownPost)])).toBe(1);
    expect((await prisma.postEmbedding.findMany({ where: { projectId: project.id }, select: { postId: true } })).map((e) => e.postId)).toEqual([ownPost.id]);
  } finally {
    await openai.close();
  }
});

/** Waits until some query in this database waits on a lock (another transaction holds what it needs). */
async function untilWaitingOnLock() {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Nothing waited on a lock");
}

test("removing sample content while the team merges two of its own posts: both posts' counts end as their rows", async () => {
  const { project, team, owner } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [dark] = (await samples(project.id)).posts;
  const postId = async (title: string) => {
    const { number } = await call(createPost, team, { board: "feature-requests", title });
    return (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  };
  const a = await postId("Dark theme");
  const b = await postId("Night mode");
  // The sample post merged into A (some other way): A has the sample people's votes and comment.
  await mergedAnyway(dark!.id, a);

  // A merge of A into B, held after it locked both posts (as mergePosts does), then moving A's votes and comment to B.
  let postsLocked!: () => void;
  let move!: () => void;
  const locked = new Promise<void>((resolve) => (postsLocked = resolve));
  const goOn = new Promise<void>((resolve) => (move = resolve));
  const merge = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM post WHERE id IN (${a}, ${b}) ORDER BY id FOR NO KEY UPDATE`;
      postsLocked();
      await goOn;
      await tx.$executeRaw`UPDATE vote SET "postId" = ${b} WHERE "postId" = ${a} AND "userId" <> ${owner.id}`;
      await tx.$executeRaw`DELETE FROM vote WHERE "postId" = ${a}`;
      await tx.$executeRaw`UPDATE comment SET "postId" = ${b} WHERE "postId" = ${a}`;
      await tx.post.update({ where: { id: a }, data: { duplicateOfId: b, voteCount: 0, commentCount: 0 } });
      await tx.$executeRaw`
        UPDATE post SET "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = ${b}), "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = ${b})
        WHERE id = ${b}`;
    },
    { timeout: 20_000 },
  );
  await locked;
  // Removal finds A and waits on its lock; the merge then moves everything to B and commits.
  const removal = removeSampleContent(project.slug);
  await untilWaitingOnLock();
  move();
  expect((await Promise.allSettled([merge, removal])).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

  for (const id of [a, b]) {
    const post = await prisma.post.findUniqueOrThrow({ where: { id }, select: { voteCount: true, commentCount: true, _count: { select: { votes: true, comments: true } } } });
    expect([post.voteCount, post.commentCount]).toEqual([post._count.votes, post._count.comments]);
  }
});

test("removal waits past Prisma's 5 seconds for a merge holding a post it counts again, then finishes", { timeout: 30_000 }, async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [dark] = (await samples(project.id)).posts;
  const { number } = await call(createPost, team, { board: "feature-requests", title: "Dark theme" });
  const a = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  await mergedAnyway(dark!.id, a);

  // A slow merge (thousands of votes) holding A.
  let postLocked!: () => void;
  let finish!: () => void;
  const locked = new Promise<void>((resolve) => (postLocked = resolve));
  const done = new Promise<void>((resolve) => (finish = resolve));
  const merge = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM post WHERE id = ${a} FOR NO KEY UPDATE`;
      postLocked();
      await done;
    },
    { timeout: 30_000 },
  );
  await locked;
  const removal = removeSampleContent(project.slug);
  await untilWaitingOnLock();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  finish();
  await merge;
  expect(await removal).toEqual({});
  expect((await samples(project.id)).posts).toEqual([]);
});

test("adding or removing sample content that fails says so (a toast) instead of throwing", async () => {
  const { project } = await setup();
  failing.sample = true;
  expect(await addSampleContent(project.slug)).toEqual({ error: "Couldn't add the sample content. Try again." });
  expect(await removeSampleContent(project.slug)).toEqual({ error: "Couldn't remove the sample content. Try again." });
});

test("an article saved into the sample collection while removal checks it waits, instead of being left in no collection", { timeout: 30_000 }, async () => {
  const { project } = await setup();
  await addSampleContent(project.slug);
  const { collections, conversations } = await samples(project.id);
  // Removal held after its check of the collections: on the sample conversation, which it deletes next.
  let held!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const hold = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM conversation WHERE id = ${conversations[0]!.id} FOR UPDATE`;
      held();
      await released;
    },
    { timeout: 30_000 },
  );
  await holding;
  const removal = removeSampleContent(project.slug);
  await untilWaitingOnLock();
  // A writer that doesn't take the project's lock saves an article into the sample collection.
  // (Started now: a Prisma query runs once something awaits it.)
  // Its outcome is caught as it lands, saved or refused, and checked once removal is done.
  const save = prisma.article
    .create({ data: { projectId: project.id, slug: "billing", title: "Billing", collectionId: collections[0]!.id } })
    .then(() => "saved" as const, (error: unknown) => error);
  // It either went through (nothing stopped it) or waits on the collection's lock too.
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= 2 || (await prisma.article.count({ where: { projectId: project.id, slug: "billing" } })) > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  release();
  await hold;
  expect(await removal).toEqual({});
  // The team's save waited on the collection removal had locked, then found it gone: refused (its foreign key), so
  // their article was never quietly left in no collection.
  expect(await save).toMatchObject({ code: "P2003" });
  expect(await prisma.article.count({ where: { projectId: project.id, slug: "billing" } })).toBe(0);
});

test("removal that Postgres aborts for its locks on the first try runs again and finishes", async () => {
  const { project } = await setup();
  await addSampleContent(project.slug);
  // Its first transaction is aborted as a deadlock would be; the next goes through.
  const transaction = vi
    .spyOn(prisma, "$transaction")
    .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("deadlock detected (40P01)", { code: "P2034", clientVersion: "test" }));
  try {
    expect(await removeSampleContent(project.slug)).toEqual({});
    expect(transaction).toHaveBeenCalledTimes(2);
  } finally {
    transaction.mockRestore();
  }
  expect(await samples(project.id)).toEqual({ posts: [], collections: [], articles: [], entries: [], conversations: [] });
});

test("a sample collection one of the team's article versions was saved in is kept, so restoring that version still lands there", async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["docs"]);
  await addSampleContent(project.slug);
  const [collection] = (await samples(project.id)).collections;
  // Written in the sample collection, then moved out: its first version is in the collection.
  const billing = await call(createArticle, team, { title: "Billing", body: "How we bill.", collection: collection!.slug });
  await call(updateArticle, team, { slug: billing.slug, collection: null });
  await removeSampleContent(project.slug);
  expect(await prisma.collection.findUniqueOrThrow({ where: { id: collection!.id }, select: { sample: true } })).toEqual({ sample: false });
  const versions = await prisma.articleRevision.findMany({ where: { article: { projectId: project.id, slug: billing.slug } }, orderBy: { createdAt: "asc" }, select: { collectionId: true } });
  expect(versions.map((v) => v.collectionId)).toEqual([collection!.id, null]);
});

test("llms.txt keeps the team's article in the sample collection, without the collection's own name, text or link", async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["docs"]);
  await addSampleContent(project.slug);
  const [collection] = (await samples(project.id)).collections;
  const billing = await call(createArticle, team, { title: "Billing", body: "How we bill.", collection: collection!.slug });
  await call(publishArticle, team, { slug: billing.slug });
  actAs(null);
  const text = await (await llms(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) } as never)).text();
  expect(text).toContain(`/docs/${billing.slug}.md`);
  expect(text).not.toContain(`/docs/${collection!.slug})`);
  expect(text).not.toContain(collection!.name);
  expect(text).not.toContain(collection!.description);
});

test("a merge of sample posts waits behind removal on the project's row before it locks any post, so the two can't deadlock", { timeout: 30_000 }, async () => {
  const { project, team } = await setup();
  await setProjectUses(project.slug, ["feedback"]);
  await addSampleContent(project.slug);
  const [dark, csv] = (await samples(project.id)).posts;
  // Held as removal holds it, first of all its locks.
  let locked!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const removal = prisma.$transaction(
    async (tx) => {
      await lockSampleContent(tx, project.id);
      locked();
      await released;
    },
    { timeout: 30_000 },
  );
  await holding;
  const merge = call(mergePost, team, { number: dark!.number, into: csv!.number });
  // The merge waits on the project's row, before it locks either post (as removal would lock them next).
  await untilWaitingOnLock();
  release();
  await removal;
  expect(await merge).toMatchObject({ merged: dark!.number, into: csv!.number });
});
