import { prisma } from "@tuti/db";
import { handlers, resumeToken } from "@tuti/jobs";
import { log as logger } from "@tuti/shared";
import { billingFile } from "@tuti/testkit";
import { startSmtpFake } from "@tuti/testkit/smtp";
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

/** The batch's wait is over, and a run queued before is late: the cron runs a few (well, eleven) minutes on. */
async function minutesLater() {
  await prisma.comment.updateMany({ where: { projectId: project.id, authorEmailDueAt: { not: null } }, data: { authorEmailDueAt: new Date(Date.now() - 1000) } });
  return later();
}
/** The cron, as if a run queued before is late now (its due times as they are). */
async function later() {
  await prisma.comment.updateMany({ where: { projectId: project.id, authorEmailQueuedAt: { not: null } }, data: { authorEmailQueuedAt: new Date(Date.now() - 11 * 60_000) } });
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
  expect(email!.text).toMatch(/Sam commented on your idea/i);
  expect(email!.text).toContain("Sam Lee");
  expect(email!.text).toContain("Same here! A separate channel for bugs, please.");
  expect(email!.text).toContain("Open");
  expect(email!.text).toContain("Reply");
  expect(email!.text).toContain("You get this because you posted this idea.");
  expect(email!.text).toContain(`http://${project.slug}.localhost:3100/feedback/feature-requests/dark-mode-${post.number}`);
  // The project's brand: its accent on the frame's square, and Powered by tuti.
  expect(email!.html).toContain("border-radius:9px;background-color:#7c3aed");
  expect(email!.text).toMatch(/Powered by/);
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
  expect(email!.text).toMatch(/Sam and Kim commented on your idea/i);
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
  await later();
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
  // Due a day ago and never sent (its runs kept failing).
  const old = await call(createComment, as(reader.id), { number: post.number, body: "Old news." });
  await call(createComment, as(reader.id), { number: post.number, body: "Fresh." });
  await prisma.comment.updateMany({ where: { postId: (await prisma.comment.findUniqueOrThrow({ where: { id: old.id } })).postId }, data: { authorEmailDueAt: new Date(Date.now() - 1000) } });
  await prisma.comment.update({ where: { id: old.id }, data: { authorEmailDueAt: new Date(Date.now() - 25 * 3_600_000) } });
  await later();
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

test("what the monthly limit held, whose first run on the 1st fails, is still retried and sent", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Held for a month." });
  // Held till this month's start (heldDueDates), written days before.
  const now = new Date();
  await prisma.comment.update({
    where: { id: comment.id },
    data: { authorEmailDueAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) },
  });
  mailbox.refuseNext(author.email, { code: 421 });
  await later();
  expect(commentEmails(author.email)).toEqual([]);
  // Due from now (no longer the month's first instant), so retried within the look-back, not every run for good.
  const due = (await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt!;
  expect(Date.now() - due.getTime()).toBeLessThan(60_000);
  await later();
  expect(commentEmails(author.email)).toHaveLength(1);
});

test("while the project's email is paused nothing goes and its comments stay due; a resume drops them, as every post email the pause held, and what's written after goes", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "support.example.com");
  vi.stubEnv("APP_PORTAL_OWNER", "e2e-operator@example.com");
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  // Past its first week, so no daily cap.
  const pausedAt = new Date(Date.now() - 60_000);
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 3_600_000), emailPausedAt: pausedAt, emailPausedReason: "2.0% of emails bounced" } });
  const held = await call(createComment, as(reader.id), { number: post.number, body: "During the pause." });
  await minutesLater();
  await minutesLater();
  // A run queued anyway (before the pause, say) waits too.
  expect(await handlers.commentsEmailed({ postId: (await prisma.comment.findUniqueOrThrow({ where: { id: held.id } })).postId }, log)).toEqual({ waiting: "the project's email is paused" });
  expect(commentEmails(author.email)).toEqual([]);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: held.id } })).authorEmailDueAt).not.toBeNull();

  expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
  await call(createComment, as(reader.id), { number: post.number, body: "After the resume." });
  await minutesLater();
  const [email, ...more] = commentEmails(author.email);
  expect(more).toEqual([]);
  expect(email!.text).toContain("After the resume.");
  expect(email!.text).not.toContain("During the pause.");
});

test("a voter's failed reply email doesn't keep the comment due to the author, who got the reply", async () => {
  const { author, post } = await authorsPost();
  const voter = await verified("Voter");
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "Shipping next week.", emailVoters: true });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: reply.id } })).authorEmailDueAt).toBeNull();
});

test("what the monthly limit held goes before the 1st once the project has room again (an upgrade)", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Held for next month." });
  const now = new Date();
  await prisma.comment.update({ where: { id: comment.id }, data: { authorEmailDueAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) } });
  await later();
  expect(commentEmails(author.email)).toHaveLength(1);
});

test("a sample post's comments never email anyone: dropped by the cron and by a run", async () => {
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  const { postId } = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
  await prisma.post.update({ where: { id: postId }, data: { sample: true } });
  // A run already queued (or a retry).
  await prisma.comment.update({ where: { id: comment.id }, data: { authorEmailDueAt: new Date(Date.now() - 1000) } });
  expect(await handlers.commentsEmailed({ postId }, log)).toEqual({ skipped: true });
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt).toBeNull();
  // The cron.
  await prisma.comment.update({ where: { id: comment.id }, data: { authorEmailDueAt: new Date(Date.now() - 1000) } });
  expect(await later()).toEqual({ found: 0, queued: 0 });
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt).toBeNull();
  expect(commentEmails(author.email)).toEqual([]);
});

test("an email about several comments keeps all their claims fresh while it sends, however long, and marks them all sent", async () => {
  const { author, post } = await authorsPost();
  const [sam, kim] = [await verified("Sam Lee"), await verified("Kim Park")];
  const ids = [
    (await call(createComment, as(sam.id), { number: post.number, body: "First." })).id,
    (await call(createComment, as(kim.id), { number: post.number, body: "Second." })).id,
  ];
  const claims = () => prisma.replyEmail.findMany({ where: { commentId: { in: ids }, userId: author.id }, select: { claimedAt: true, sentAt: true } });
  const fake = await startSmtpFake({
    onEmail: async () => {
      const before = (await claims()).map((claim) => claim.claimedAt.getTime());
      vi.advanceTimersByTime(60_000); // a minute into the send
      await vi.waitUntil(async () => (await claims()).every((claim, i) => claim.claimedAt.getTime() > before[i]!), { timeout: 5000 });
    },
  });
  const port = process.env.SMTP_PORT;
  process.env.SMTP_PORT = String(fake.port);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await minutesLater();
  } finally {
    vi.useRealTimers();
    process.env.SMTP_PORT = port;
    await fake.close();
  }
  expect(fake.emails).toHaveLength(1);
  const sent = await claims();
  expect(sent).toHaveLength(2);
  expect(sent.every((claim) => claim.sentAt !== null)).toBe(true);
  expect(await prisma.comment.count({ where: { id: { in: ids }, authorEmailDueAt: { not: null } } })).toBe(0);
});

test("a run that fails before sending (the project's brand can't be read) takes none of the project's emails and leaves no claim", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { post } = await authorsPost();
  const reader = await verified("Reader");
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  const installation = await prisma.installation.findUniqueOrThrow({ where: { singleton: 1 } });
  await prisma.installation.delete({ where: { singleton: 1 } });
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await minutesLater();
  } finally {
    await prisma.installation.create({ data: installation });
  }
  expect(await prisma.projectEmailMonth.findMany({ where: { projectId: project.id, emails: { gt: 0 } } })).toEqual([]);
  expect(await prisma.replyEmail.count({ where: { commentId: comment.id } })).toBe(0);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt).not.toBeNull();
});
