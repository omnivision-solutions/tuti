import { type PostStatus, prisma } from "@tuti/db";
import { beforeEach, expect, test, vi } from "vitest";

import { unreadNumbers } from "@/lib/whats-new";
import { widgetToken } from "@/lib/widget-session";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { markChangelogSeen } from "./changelog-seen";
import { widgetIdeaNews } from "./widget";
import { suggestedArticles, teamFaces, usualReplyMs, whatsNewSeen } from "./widget-home";

/** The widget's Home: suggested articles, when the team usually replies, the news of someone's ideas, and what's new to them. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// One moment for the whole file: what's "lately" doesn't shift while it runs.
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

let number = 0;
/** A conversation started `startedAgo`, the user's first message then; the team replying `replyAfter` later (none: unanswered). */
async function conversation(startedAgo: number, replyAfter: number | null, data: { spam?: boolean; note?: boolean } = {}) {
  const started = ago(startedAgo);
  const message = (author: "USER" | "TEAM", createdAt: Date, note = false) => ({ projectId: project.id, author, channel: "WIDGET" as const, body: "Hi", createdAt, note });
  await prisma.conversation.create({
    data: {
      projectId: project.id,
      number: ++number,
      subject: "Help",
      origin: "WIDGET",
      spam: data.spam ?? false,
      createdAt: started,
      messages: {
        create: [message("USER", started), ...(replyAfter === null ? [] : [message("TEAM", new Date(started.getTime() + replyAfter), data.note)])],
      },
    },
  });
}

test("the usual reply time: the median first reply of the last 30 days' conversations, from five answered", async () => {
  for (const minutes of [10, 20, 30, 40]) {
    await conversation(DAY, minutes * MINUTE);
  }
  // Not counted: unanswered, spam, only a note, too long ago.
  await conversation(DAY, null);
  await conversation(DAY, 1, { spam: true });
  await conversation(DAY, 1, { note: true });
  await conversation(40 * DAY, 1);
  expect(await usualReplyMs(project.id, now)).toBeNull();

  await conversation(DAY, 1000 * MINUTE);
  // Five minutes later: worked out again.
  expect(await usualReplyMs(project.id, new Date(now.getTime() + 5 * MINUTE))).toBe(30 * MINUTE);
});

test("the usual reply time is worked out once every five minutes per project", async () => {
  for (const minutes of [10, 20, 30, 40, 50]) {
    await conversation(DAY, minutes * MINUTE);
  }
  expect(await usualReplyMs(project.id, now)).toBe(30 * MINUTE);
  // Two slow replies since: the same answer until five minutes have passed.
  await conversation(DAY, 1000 * MINUTE);
  await conversation(DAY, 1000 * MINUTE);
  expect(await usualReplyMs(project.id, new Date(now.getTime() + 4 * MINUTE))).toBe(30 * MINUTE);
  expect(await usualReplyMs(project.id, new Date(now.getTime() + 5 * MINUTE))).toBe(40 * MINUTE);
  // Each project its own.
  const other = await createProject(owner);
  expect(await usualReplyMs(other.id, now)).toBeNull();
});

test("Home's opened by many at once: they share one working out of the reply time", async () => {
  for (const minutes of [10, 20, 30, 40, 50]) {
    await conversation(DAY, minutes * MINUTE);
  }
  const queries = vi.spyOn(prisma, "$queryRaw");
  try {
    expect(await Promise.all([usualReplyMs(project.id, now), usualReplyMs(project.id, now), usualReplyMs(project.id, now)])).toEqual([
      30 * MINUTE,
      30 * MINUTE,
      30 * MINUTE,
    ]);
    expect(queries).toHaveBeenCalledTimes(1);
  } finally {
    queries.mockRestore();
  }
});

let postNumber = 0;
async function post(title: string, status: PostStatus, data: { authorId?: string; voterId?: string; projectId?: string; boardId?: string } = {}) {
  const projectId = data.projectId ?? project.id;
  return prisma.post.create({
    data: {
      projectId,
      boardId: data.boardId ?? project.boards[0]!.id,
      authorId: data.authorId ?? owner.id,
      number: ++postNumber,
      title,
      status,
      ...(data.voterId && { votes: { create: { userId: data.voterId, projectId } } }),
    },
  });
}

const moved = (postId: string, from: PostStatus, to: PostStatus, daysAgo = 1) =>
  prisma.postEvent.create({ data: { postId, from, to, createdAt: ago(daysAgo * DAY) } });

test("the news of someone's ideas: posts they posted or voted on that moved to a roadmap status lately, and are still there", async () => {
  const sam = await signUp("Sam");
  const news = () => widgetIdeaNews(project.slug, widgetToken(project.id, sam.id));

  const darkMode = await post("Dark mode", "PLANNED", { voterId: sam.id });
  await moved(darkMode.id, "OPEN", "PLANNED", 2);
  const sso = await post("SSO", "COMPLETED", { authorId: sam.id });
  await moved(sso.id, "PLANNED", "IN_PROGRESS", 5);
  await moved(sso.id, "IN_PROGRESS", "COMPLETED", 1);
  // Not news for Sam: someone else's idea, an old move, one taken back, a status that isn't news, a merged one.
  await moved((await post("Not Sam's", "PLANNED")).id, "OPEN", "PLANNED");
  await moved((await post("Long ago", "PLANNED", { voterId: sam.id })).id, "OPEN", "PLANNED", 40);
  await moved((await post("Taken back", "OPEN", { voterId: sam.id })).id, "OPEN", "PLANNED");
  await moved((await post("Reviewing", "UNDER_REVIEW", { voterId: sam.id })).id, "OPEN", "UNDER_REVIEW");
  const merged = await post("Merged", "PLANNED", { voterId: sam.id });
  await prisma.post.update({ where: { id: merged.id }, data: { duplicateOfId: darkMode.id } });
  await moved(merged.id, "OPEN", "PLANNED");

  expect(await news()).toEqual([
    { title: "SSO", status: "COMPLETED", href: `/feedback/feature-requests/sso-${sso.number}`, at: expect.any(String) },
    { title: "Dark mode", status: "PLANNED", href: `/feedback/feature-requests/dark-mode-${darkMode.number}`, at: expect.any(String) },
  ]);

  // A token for another project, or none that checks out: nothing.
  const other = await createProject(owner);
  expect(await widgetIdeaNews(project.slug, widgetToken(other.id, sam.id))).toEqual([]);
  expect(await widgetIdeaNews(project.slug, "not-a-token")).toEqual([]);

  // Once the portal is private, only for those who may read it.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await news()).toEqual([]);
});

test("three at most, newest first", async () => {
  const sam = await signUp("Sam");
  for (const [i, title] of ["One", "Two", "Three", "Four"].entries()) {
    await moved((await post(title, "IN_PROGRESS", { voterId: sam.id })).id, "PLANNED", "IN_PROGRESS", 4 - i);
  }
  expect((await widgetIdeaNews(project.slug, widgetToken(project.id, sam.id))).map((n) => n.title)).toEqual(["Four", "Three", "Two"]);
});

test("a post moved back and forth many times doesn't crowd out the others", async () => {
  const sam = await signUp("Sam");
  const busy = await post("Busy", "PLANNED", { voterId: sam.id });
  for (let i = 0; i < 25; i++) {
    await moved(busy.id, i % 2 ? "IN_PROGRESS" : "PLANNED", i % 2 ? "PLANNED" : "IN_PROGRESS", 1);
  }
  await moved(busy.id, "IN_PROGRESS", "PLANNED", 0.5);
  await moved((await post("Quiet", "COMPLETED", { voterId: sam.id })).id, "IN_PROGRESS", "COMPLETED", 3);
  expect((await widgetIdeaNews(project.slug, widgetToken(project.id, sam.id))).map((n) => n.title)).toEqual(["Busy", "Quiet"]);
});

test("two moves in the same millisecond: the one to where the post is now is its news", async () => {
  const sam = await signUp("Sam");
  const quick = await post("Quick", "IN_PROGRESS", { voterId: sam.id });
  const at = ago(DAY);
  await prisma.postEvent.create({ data: { postId: quick.id, from: "PLANNED", to: "IN_PROGRESS", createdAt: at } });
  await prisma.postEvent.create({ data: { postId: quick.id, from: "OPEN", to: "PLANNED", createdAt: at } });
  expect(await widgetIdeaNews(project.slug, widgetToken(project.id, sam.id))).toEqual([
    { title: "Quick", status: "IN_PROGRESS", href: `/feedback/feature-requests/quick-${quick.number}`, at: at.toISOString() },
  ]);
});

async function article(title: string, views: number, access?: "SIGNED_IN") {
  const { id } = await prisma.article.create({
    data: { projectId: project.id, slug: title.toLowerCase().replaceAll(" ", "-"), title, body: title, publishedAt: new Date(), access },
  });
  await prisma.articleViewDay.create({ data: { articleId: id, day: new Date(), views } });
}

test("suggested articles: the three most read lately that whoever's here may open", async () => {
  await article("Billing", 5);
  await article("Inviting your team", 12);
  await article("Exporting", 3);
  await article("Webhooks", 1);
  await article("Pro features", 40, "SIGNED_IN");

  actAs(null);
  expect((await suggestedArticles(project.slug)).map((a) => a.title)).toEqual(["Inviting your team", "Billing", "Exporting"]);
  actAs(owner);
  expect((await suggestedArticles(project.slug)).map((a) => a.title)).toEqual(["Pro features", "Inviting your team", "Billing"]);
});

test("the team's faces: three at most, the owners first, then whoever joined first", async () => {
  const member = await addMember(project.id, "MEMBER");
  await addMember(project.id, "ADMIN");
  const secondOwner = await addMember(project.id, "OWNER");
  expect((await teamFaces(project.id)).map((face) => face.id)).toEqual([owner.id, secondOwner.id, member.id]);
});

test("after the owners, whoever joined first, whatever their role", async () => {
  const member = await addMember(project.id, "MEMBER");
  const admin = await addMember(project.id, "ADMIN");
  expect((await teamFaces(project.id)).map((face) => face.id)).toEqual([owner.id, member.id, admin.id]);
});

test("what's new to someone: announcements of the last 30 days published since they last looked, until they've seen them", async () => {
  const ada = await signUp("Ada");
  const entry = (projectId: string, n: number, publishedAgo: number, announced = true) =>
    prisma.changelogEntry.create({ data: { projectId, number: n, title: `Entry ${n}`, announced, publishedAt: ago(publishedAgo) } });
  await entry(project.id, 1, 40 * DAY); // too long ago to be new
  await entry(project.id, 2, 3 * DAY);
  await entry(project.id, 3, 2 * DAY, false); // published quietly
  const latest = await entry(project.id, 4, DAY);
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 5, title: "Draft", announced: true } });
  const unread = async (userId: string | null) => {
    const { fresh, seen } = await whatsNewSeen(project.id, userId, now);
    return unreadNumbers(fresh, seen);
  };
  // Never looked: every fresh announcement, newest first (a visitor nobody knows too, until the widget's script says more).
  expect(await unread(ada.id)).toEqual([4, 2]);
  expect(await unread(null)).toEqual([4, 2]);

  // Seen up to the older one, then all.
  actAs(ada);
  expect(await markChangelogSeen(project.slug, ago(2 * DAY).toISOString())).toEqual({});
  expect(await unread(ada.id)).toEqual([4]);
  expect(await markChangelogSeen(project.slug, latest.publishedAt!.toISOString())).toEqual({});
  expect(await unread(ada.id)).toEqual([]);
  // Someone else hasn't.
  expect(await unread(owner.id)).toEqual([4, 2]);

  // Another project's announcements and what Ada saw there are its own.
  const other = await createProject(await signUp());
  await entry(other.id, 1, DAY);
  expect((await whatsNewSeen(other.id, ada.id, now)).seen).toBeNull();
  expect((await whatsNewSeen(other.id, ada.id, now)).fresh.map((f) => f.number)).toEqual([1]);
  expect((await whatsNewSeen(project.id, ada.id, now)).fresh.map((f) => f.number)).toEqual([4, 2]);
});
