import { prisma } from "@tuti/db";
import { embedPublishedArticles, handlers } from "@tuti/jobs";
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

import { entryTold } from "./changelog-queries";
import { homeOverview } from "./home";
import { mailSubdomain } from "./inbound";
import { createComment, createPost } from "./operations/create";
import { replyToConversation } from "./operations/conversations";
import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle, updateArticle, updateCollection } from "./operations/docs";
import { mergePost, updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { addSampleContent, removeSampleContent, setProjectUses } from "./projects";

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
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  return { owner, project, team: { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id } };
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
  // What the team did to sample content: a vote and a comment on it, a status (it's still sample), and a
  // sample post merged into their own (its votes and comment move over).
  await call(setVote, team, { number: dark!.number, voted: true });
  await call(createComment, team, { number: dark!.number, body: "Noted!" });
  // Completing a sample post emails nobody: its voters aren't real.
  const emailed = mailbox.emails.length;
  await call(updatePost, team, { number: csv!.number, status: "completed" });
  expect(mailbox.emails.length).toBe(emailed);
  await call(mergePost, team, { number: dark!.number, into: own.number });
  // Their post can't go the other way: it would go with the sample content.
  await expect(call(mergePost, team, { number: own.number, into: csv!.number })).rejects.toThrow("Sample posts are removed with the sample content");
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).toMatchObject({ voteCount: 4, commentCount: 2 });

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
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  await handlers.articleChanged({ articleId: articles[0]!.id }, log);
  await embedPublishedArticles(log);
  expect(await prisma.articleChunk.count({ where: { articleId: { in: articles.map((a) => a.id) } } })).toBe(0);
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

test("a changelog update that completes a sample post, or the sample update published again, emails nobody, reaches no webhooks and isn't announced", async () => {
  const { project, team } = await setup();
  await addSampleContent(project.slug);
  const { posts, entries } = await samples(project.id);
  const reader = await signUp("Rita Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await prisma.vote.create({ data: { projectId: project.id, postId: posts[1]!.id, userId: reader.id } });
  const emailed = mailbox.emails.length;
  jobs.enqueue.mockClear();
  jobs.recordEvent.mockClear();

  // The team's update, linked to the sample post: published, it completes the post, with nothing sent about it.
  const own = await call(createChangelogEntry, team, { title: "Exports", body: "CSV exports are here.", posts: [posts[1]!.number] });
  await call(publishChangelogEntry, team, { number: own.number, announce: false });
  expect((await prisma.post.findUniqueOrThrow({ where: { id: posts[1]!.id } })).status).toBe("COMPLETED");
  expect(jobs.recordEvent.mock.calls.map((args) => args[2])).toEqual(["changelog.published"]);
  // It told nobody: no "told" count for an update that completed only sample posts.
  expect(await entryTold((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: own.number } })).id)).toBeNull();
  // The sample update, unpublished and published again (announced, by default): not announced, no webhook.
  jobs.recordEvent.mockClear();
  await call(unpublishChangelogEntry, team, { number: entries[0]!.number });
  await call(publishChangelogEntry, team, { number: entries[0]!.number });
  expect(jobs.recordEvent).not.toHaveBeenCalled();
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entries[0]!.id } })).announced).toBe(false);
  // Nor do the shipped emails go, however the post got completed (the resubmit cron runs the same job).
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
