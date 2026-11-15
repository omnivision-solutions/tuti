import { prisma } from "@tuti/db";
import { handlers, resumeToken } from "@tuti/jobs";
import { log as logger } from "@tuti/shared";
import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { setBoardOff } from "@/server/boards";
import { resumeEmailSending } from "@/server/email-pause";
import { createComment, createPost } from "@/server/operations/create";
import { mergePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Someone else's comment on a post, emailed to its author a few minutes on (packages/jobs/src/comment-email.ts). */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
const log = { info: () => {}, warn: () => {} };

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};
const commentEmails = (address: string) => mailbox.emails.filter((e) => e.to.includes(address) && e.subject.startsWith("New comment"));

async function authorsPost() {
  const author = await verified("Ada Author");
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  return { author, post };
}

/** The batch's wait is over: the cron runs a few minutes on. */
async function minutesLater() {
  await prisma.comment.updateMany({ where: { projectId: project.id, authorEmailDueAt: { not: null } }, data: { authorEmailDueAt: new Date(Date.now() - 1000) } });
  return handlers.commentEmailsDue({}, log);
}

test("another reader's comment is emailed to the post's author a few minutes on, once", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Sam Lee");
  await prisma.project.update({ where: { id: project.id }, data: { brandColor: "#7c3aed" } });
  await call(createComment, as(reader.id), { number: post.number, body: "Same here! A separate channel for bugs, please." });

  // Not at once: comments close together go in one email.
  await handlers.commentEmailsDue({}, log);
  expect(commentEmails(author.email)).toEqual([]);

  await minutesLater();
  const [email, ...more] = commentEmails(author.email);
  expect(more).toEqual([]);
  expect(email!.subject).toBe("New comment on “Dark mode”");
  expect(email!.text).toContain("New comment on your idea");
  expect(email!.text).toContain("Sam commented on your idea");
  expect(email!.text).toContain("Sam Lee");
  expect(email!.text).toContain("Same here! A separate channel for bugs, please.");
  expect(email!.text).toContain("Open");
  expect(email!.text).toContain("Reply");
  expect(email!.text).toContain("You get this because you posted this idea.");
  expect(email!.text).toContain(`http://${project.slug}.localhost:3100/feedback/feature-requests/dark-mode-${post.number}`);
  expect(email!.html).toContain("border-top:4px solid #7c3aed");
  expect(email!.headers["list-unsubscribe"]).toMatch(/\?token=[^.>]+\.[\w-]+>$/);
  // Not to the one who commented, and done: never again.
  expect(commentEmails(reader.email)).toEqual([]);
  expect(await prisma.comment.count({ where: { projectId: project.id, authorEmailDueAt: { not: null } } })).toBe(0);
  await minutesLater();
  expect(commentEmails(author.email)).toHaveLength(1);
});

test("comments close together become one email", async () => {
  const { author, post } = await authorsPost();
  const [sam, kim] = [await verified("Sam Lee"), await verified("Kim Park")];
  await call(createComment, as(sam.id), { number: post.number, body: "First thought." });
  await call(createComment, as(kim.id), { number: post.number, body: "Second thought." });
  await minutesLater();
  const [email, ...more] = commentEmails(author.email);
  expect(more).toEqual([]);
  expect(email!.subject).toBe("New comments on “Dark mode”");
  expect(email!.text).toContain("Sam and Kim commented on your idea");
  expect(email!.text).toContain("First thought.");
  expect(email!.text).toContain("Second thought.");
});

test("nothing for the author's own comment, an internal note, or a comment removed before it goes", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  await call(createComment, as(author.id), { number: post.number, body: "Adding detail." });
  await call(createComment, as(owner.id), { number: post.number, body: "Note to self", internal: true });
  const gone = await call(createComment, as(reader.id), { number: post.number, body: "Spam" });
  await prisma.comment.delete({ where: { id: gone.id } });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
});

test("nothing for an author who turned off Posts I wrote, or unsubscribed", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  await prisma.emailPreference.create({ data: { userId: author.id, projectId: project.id, ownPosts: false, followedPosts: true } });
  await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);

  await prisma.emailPreference.deleteMany({ where: { userId: author.id } });
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: author.id } });
  await call(createComment, as(reader.id), { number: post.number, body: "Still nice." });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
  expect(await prisma.comment.count({ where: { projectId: project.id, authorEmailDueAt: { not: null } } })).toBe(0);
});

test("the team's reply emailed to voters isn't emailed to the author again; one to voters the author isn't among is", async () => {
  const { author, post } = await authorsPost();
  await call(createComment, as(owner.id), { number: post.number, body: "Shipping next week.", emailVoters: true });
  expect(mailbox.emails.filter((e) => e.to.includes(author.email) && e.subject === "Re: Dark mode")).toHaveLength(1);
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);

  // Their vote taken back: the reply to voters doesn't reach them, so the comment's email does.
  await call(setVote, as(author.id), { number: post.number, voted: false });
  await call(createComment, as(owner.id), { number: post.number, body: "Now in beta.", emailVoters: true });
  await minutesLater();
  const [email, ...more] = commentEmails(author.email);
  expect(more).toEqual([]);
  expect(email!.text).toContain("Now in beta.");
  expect(email!.text).not.toContain("Shipping next week.");
});

test("past the project's monthly email limit it waits for next month", async () => {
  // Mid-month, so the run can't straddle two months.
  const now = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 12));
  vi.useFakeTimers({ toFake: ["Date"], now });
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 1; }));
  await prisma.projectEmailMonth.create({ data: { projectId: project.id, month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), emails: 1 } });
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  expect(await prisma.replyEmail.count({ where: { commentId: comment.id } })).toBe(0);

  // Next month (as if: due at this month's start, written days before), it goes, though it's past the look-back.
  await prisma.projectEmailMonth.deleteMany({ where: { projectId: project.id } });
  await prisma.comment.update({
    where: { id: comment.id },
    data: { authorEmailDueAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) },
  });
  await handlers.commentEmailsDue({}, log);
  expect(commentEmails(author.email)).toHaveLength(1);
});

test("a send that fails is tried again, emailing the author once", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  mailbox.refuseNext(author.email, { code: 421 });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
  // Still due, its claim released: the next run (or Hatchet's retry) sends it.
  await minutesLater();
  expect(commentEmails(author.email)).toHaveLength(1);
  await minutesLater();
  expect(commentEmails(author.email)).toHaveLength(1);
});

test("a comment past the look-back isn't sent with a newer one, and one on a post merged away isn't sent", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  const old = await call(createComment, as(reader.id), { number: post.number, body: "Old news." });
  await prisma.comment.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
  await call(createComment, as(reader.id), { number: post.number, body: "Fresh." });
  await minutesLater();
  const [email] = commentEmails(author.email);
  expect(email!.text).toContain("Fresh.");
  expect(email!.text).not.toContain("Old news.");
  expect(await prisma.comment.count({ where: { projectId: project.id, authorEmailDueAt: { not: null } } })).toBe(0);

  // Merged into another reader's post: not emailed to that one's author either (it wasn't on their post).
  const otherAuthor = await verified("Olga Other");
  const other = await call(createPost, as(otherAuthor.id), { board: "feature-requests", title: "Night theme" });
  const moved = await call(createComment, as(reader.id), { number: post.number, body: "Before the merge." });
  await call(mergePost, as(owner.id), { number: post.number, into: other.number });
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: moved.id } })).authorEmailDueAt).toBeNull();
  await minutesLater();
  expect(commentEmails(author.email)).toHaveLength(1);
  expect(commentEmails(otherAuthor.email)).toEqual([]);
});

test("turning the board off drops its comments' emails, also once it's on again", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "feature-requests" }, select: { id: true } });
  actAs(owner);
  expect(await setBoardOff(project.slug, board.id, true)).toEqual({});
  expect(await setBoardOff(project.slug, board.id, false)).toEqual({});
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
});

test("a resume drops the comments the pause held, not those the monthly limit holds for next month", async () => {
  const now = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 12));
  vi.useFakeTimers({ toFake: ["Date"], now });
  const { post } = await authorsPost();
  const reader = await verified("Reader");
  const paused = await call(createComment, as(reader.id), { number: post.number, body: "Held by the pause." });
  const held = await call(createComment, as(reader.id), { number: post.number, body: "Held for next month." });
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await prisma.comment.update({ where: { id: held.id }, data: { authorEmailDueAt: nextMonth } });
  const pausedAt = new Date(Date.now() - 60_000);
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: pausedAt, emailPausedReason: "2.0% of emails bounced" } });
  expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
  const due = async (id: string) => (await prisma.comment.findUniqueOrThrow({ where: { id } })).authorEmailDueAt;
  expect(await due(paused.id)).toBeNull();
  expect(await due(held.id)).toEqual(nextMonth);
});
