import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createComment, createPost } from "@/server/operations/create";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";
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
  expect(await prisma.comment.count({ where: { authorEmailDueAt: { not: null } } })).toBe(0);
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
  expect(await prisma.comment.count({ where: { authorEmailDueAt: { not: null } } })).toBe(0);
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
  const { author, post } = await authorsPost();
  const reader = await verified("Reader");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 1; }));
  const now = new Date();
  await prisma.projectEmailMonth.create({ data: { projectId: project.id, month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), emails: 1 } });
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Nice idea." });
  await minutesLater();
  expect(commentEmails(author.email)).toEqual([]);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).authorEmailDueAt).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  expect(await prisma.replyEmail.count({ where: { commentId: comment.id } })).toBe(0);
});
