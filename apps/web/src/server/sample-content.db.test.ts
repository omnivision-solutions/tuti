import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { afterEach, expect, test, vi } from "vitest";

import { generateMetadata as changelogMetadata } from "@/app/portal/[project]/(site)/changelog/[number]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { generateMetadata as docsMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { generateMetadata as postMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { postPath } from "@/lib/post-urls";
import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { homeOverview } from "./home";
import { mailSubdomain } from "./inbound";
import { createComment, createPost } from "./operations/create";
import { replyToConversation } from "./operations/conversations";
import { createChangelogEntry, publishChangelogEntry } from "./operations/changelog";
import { createArticle, createCollection, publishArticle } from "./operations/docs";
import { mergePost, updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { addSampleContent, removeSampleContent, setProjectUses } from "./projects";

/** Sample content (server/sample-content.ts): what's added for the picks, that nothing goes out, and that removing takes exactly it. */

// Whatever is queued or sent to webhooks, spied on.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(), emitEvent: vi.fn() }));
vi.mock("@tuti/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tuti/jobs")>();
  return {
    ...real,
    enqueue: (...args: Parameters<typeof real.enqueue>) => (jobs.enqueue(...args), real.enqueue(...args)),
    emitEvent: (...args: Parameters<typeof real.emitEvent>) => (jobs.emitEvent(...args), real.emitEvent(...args)),
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
  expect(await prisma.user.count({ where: { email: { endsWith: `-${project.id}@users.tuti.invalid` } } })).toBe(3);

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
  expect(await prisma.user.count({ where: { email: { endsWith: `-${project.id}@users.tuti.invalid` } } })).toBe(0);
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
