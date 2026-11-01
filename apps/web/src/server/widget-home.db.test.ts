import { type PostStatus, prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { widgetIdeaNews } from "./widget";
import { suggestedArticles, usualReplyMs } from "./widget-home";

/** The widget's Home: suggested articles, when the team usually replies, and the news of someone's ideas. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms);

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
  expect(await usualReplyMs(project.id)).toBeNull();

  await conversation(DAY, 1000 * MINUTE);
  expect(await usualReplyMs(project.id)).toBe(30 * MINUTE);
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
