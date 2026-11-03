import { type Prisma, prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { inboxStats } from "./inbox-stats";

/** The Inbox's numbers beside the list: what needs a reply and since when, and the week's new conversations. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

let project: Awaited<ReturnType<typeof createProject>>;
let number = 0;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
});

const conversation = (data: Partial<Prisma.ConversationUncheckedCreateInput> = {}, projectId = project.id) =>
  prisma.conversation.create({ data: { projectId, number: ++number, subject: "Help", origin: "API", ...data } });

test("needs a reply: open and awake, spam, sample content and other projects left out; the longest wait of either kind", async () => {
  await conversation({ waitingSince: ago(2 * DAY), createdAt: ago(10 * DAY) });
  // Set back to Open by hand: waiting since its latest message, the longest.
  await conversation({ waitingSince: null, lastMessageAt: ago(3 * DAY), createdAt: ago(10 * DAY) });
  // Not counted: waiting on the user, closed, snoozed, spam, sample, another project's.
  await conversation({ status: "WAITING", waitingSince: ago(9 * DAY) });
  await conversation({ status: "CLOSED", waitingSince: ago(9 * DAY) });
  await conversation({ waitingSince: ago(9 * DAY), snoozedUntil: new Date(now.getTime() + DAY) });
  await conversation({ spam: true, waitingSince: ago(9 * DAY) });
  await conversation({ sample: true, waitingSince: ago(9 * DAY) });
  const other = await createProject(await signUp("Other"));
  await conversation({ waitingSince: ago(9 * DAY) }, other.id);

  const stats = await inboxStats(project.id, now);
  expect(stats.waiting).toBe(2);
  expect(stats.oldest).toEqual(ago(3 * DAY));
  // Under five answered: not known yet.
  expect(stats.replyMs).toBeNull();
});

test("the longest wait: since its oldest unanswered message, when that's older than any set back to Open", async () => {
  await conversation({ waitingSince: ago(4 * DAY), createdAt: ago(10 * DAY) });
  await conversation({ waitingSince: null, lastMessageAt: ago(3 * DAY), createdAt: ago(10 * DAY) });
  expect((await inboxStats(project.id, now)).oldest).toEqual(ago(4 * DAY));
});

test("nothing waiting: no longest wait", async () => {
  await conversation({ status: "CLOSED" });
  expect(await inboxStats(project.id, now)).toMatchObject({ waiting: 0, oldest: null });
});

test("new this week: started in the last 7 days, whatever its status; spam, sample content and other projects left out", async () => {
  await conversation({ createdAt: ago(7 * DAY - MINUTE), status: "CLOSED" });
  await conversation({ createdAt: ago(MINUTE), status: "WAITING" });
  // Not counted: just over a week ago, spam, sample, another project's.
  await conversation({ createdAt: ago(7 * DAY + MINUTE) });
  await conversation({ createdAt: ago(MINUTE), spam: true });
  await conversation({ createdAt: ago(MINUTE), sample: true });
  const other = await createProject(await signUp("Other"));
  await conversation({ createdAt: ago(MINUTE) }, other.id);

  expect((await inboxStats(project.id, now)).newThisWeek).toBe(2);
});
