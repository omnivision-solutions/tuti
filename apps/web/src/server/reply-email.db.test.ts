import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createComment, createPost } from "@/server/operations/create";
import { mergePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { OperationError } from "@/server/operations";
import { call } from "@/server/operations/run";
import { votersToEmail } from "@/server/post-lists";
import { addComment } from "@/server/posts";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};
// Sign-up sends a verification email; these are the rest.
const emailsTo = (address: string) => mailbox.emails.filter((e) => e.to.includes(address) && !e.subject.startsWith("Verify your email"));

/** A post with these people voting for it (its author votes for it too). */
async function votedFor(...voters: TestUser[]) {
  const author = await verified("Author");
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  for (const voter of voters) {
    await call(setVote, as(voter.id), { number: post.number, voted: true });
  }
  return { post, author };
}

test("the team's reply with Email voters goes to the post's voters, each once; not to the team, nor without it", async () => {
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  const [voter, other, unverified] = [await verified("Voter"), await verified("Other"), await signUp("Unverified")];
  const { post, author } = await votedFor(voter, other, unverified, owner);

  // Without it: nobody's emailed.
  await call(createComment, as(owner.id), { number: post.number, body: "Looking into it." });
  expect(emailsTo(voter.email)).toEqual([]);

  await call(createComment, as(owner.id), { number: post.number, body: "Dark mode ships next week.", emailVoters: true });
  for (const address of [voter.email, other.email, author.email]) {
    const [email, ...more] = emailsTo(address);
    expect(more).toEqual([]);
    expect(email!.subject).toBe("Re: Dark mode");
    expect(email!.text).toContain("Owner from");
    expect(email!.text).toContain("Dark mode ships next week.");
    expect(email!.text).toContain(`http://${project.slug}.localhost:3100/feedback/feature-requests/dark-mode-${post.number}`);
    expect(email!.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
  }
  // Not the team (who wrote it), nor an address nobody verified.
  expect(emailsTo(owner.email)).toEqual([]);
  expect(emailsTo(unverified.email)).toEqual([]);
  // Done: not due any more.
  expect(await prisma.comment.count({ where: { votersEmailDueAt: { not: null } } })).toBe(0);
});

test("the team's reply form says how many voters it emails, and emails them when switched on", async () => {
  const [voter, unverified] = [await verified("Voter"), await signUp("Unverified")];
  const { post } = await votedFor(voter, unverified, owner);
  const { id } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  // Its author and Voter: not an address nobody verified, nor the team.
  expect(await votersToEmail(project.id, id)).toBe(2);
  actAs(owner);
  const form = new FormData();
  form.set("postId", id);
  form.set("body", "Shipping soon.");
  form.set("emailVoters", "on");
  expect(await addComment({}, form)).toEqual({});
  expect(emailsTo(voter.email)).toHaveLength(1);
});

test("only the team emails voters, and a note isn't emailed", async () => {
  const voter = await verified("Voter");
  const { post } = await votedFor(voter);
  const reader = await verified("Reader");
  await expect(call(createComment, as(reader.id), { number: post.number, body: "Hi all", emailVoters: true })).rejects.toThrow(
    new OperationError(403, "forbidden", "Only your team can email a post's voters"),
  );
  await expect(call(createComment, as(owner.id), { number: post.number, body: "Note", internal: true, emailVoters: true })).rejects.toThrow(
    new OperationError(400, "invalid_input", "An internal note isn't emailed to anyone"),
  );
  expect(emailsTo(voter.email)).toEqual([]);
});

test("a voter who unsubscribed from the project isn't emailed", async () => {
  const [voter, gone] = [await verified("Voter"), await verified("Gone")];
  const { post } = await votedFor(voter, gone);
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: gone.id } });
  await call(createComment, as(owner.id), { number: post.number, body: "Shipping soon.", emailVoters: true });
  expect(emailsTo(voter.email)).toHaveLength(1);
  expect(emailsTo(gone.email)).toEqual([]);
});

test("a send that fails is tried again by the safety net, to that voter only", async () => {
  const [voter, other] = [await verified("Voter"), await verified("Other")];
  const { post } = await votedFor(voter, other);
  vi.spyOn(log, "warn").mockImplementation(() => {});
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "Shipping soon.", emailVoters: true });
  expect(emailsTo(voter.email)).toEqual([]);
  expect(emailsTo(other.email)).toHaveLength(1);
  // Still due; later, the safety net queues it again.
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date(Date.now() - 11 * 60_000) } });
  await handlers.resubmitReplyEmails({}, { info: () => {}, warn: () => {} });
  expect(emailsTo(voter.email)).toHaveLength(1);
  expect(emailsTo(other.email)).toHaveLength(1);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: reply.id } })).votersEmailDueAt).toBeNull();
});

test("a reply still to be emailed whose post is merged into another isn't emailed to that one's voters", async () => {
  const [voter, otherVoter] = [await verified("Voter"), await verified("Other voter")];
  const { post } = await votedFor(voter);
  const other = await votedFor(otherVoter);
  vi.spyOn(log, "warn").mockImplementation(() => {});
  // Its send fails for now: still due, and (a while on) late for the safety net.
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "About this one only.", emailVoters: true });
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date(Date.now() - 11 * 60_000) } });
  await call(mergePost, as(owner.id), { number: post.number, into: other.post.number });
  // The safety net: nothing goes to the other post's voters.
  await handlers.resubmitReplyEmails({}, { info: () => {}, warn: () => {} });
  expect(emailsTo(otherVoter.email)).toEqual([]);
  expect(emailsTo(other.author.email)).toEqual([]);
});

test("a crashed send's claim for a voter who has since unsubscribed doesn't keep the reply due", async () => {
  const [voter, gone] = [await verified("Voter"), await verified("Gone")];
  const { post } = await votedFor(voter, gone);
  vi.spyOn(log, "warn").mockImplementation(() => {});
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "Shipping soon.", emailVoters: true });
  // A run died while sending to Gone (its claim left unsent), and Gone has unsubscribed since.
  await prisma.replyEmail.upsert({
    where: { commentId_userId: { commentId: reply.id, userId: gone.id } },
    create: { commentId: reply.id, userId: gone.id, claimedAt: new Date(Date.now() - 11 * 60_000) },
    update: { sentAt: null, claimedAt: new Date(Date.now() - 11 * 60_000) },
  });
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: gone.id } });
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date(Date.now() - 11 * 60_000) } });
  await handlers.resubmitReplyEmails({}, { info: () => {}, warn: () => {} });
  expect(emailsTo(voter.email)).toHaveLength(1);
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: reply.id } })).votersEmailDueAt).toBeNull();
});

test("the safety net leaves a paused project's replies out, so they don't fill its batch before ones that can go", async () => {
  const voter = await verified("Voter");
  const { post } = await votedFor(voter);
  vi.spyOn(log, "warn").mockImplementation(() => {});
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "Shipping soon.", emailVoters: true });
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date(Date.now() - 11 * 60_000) } });
  vi.stubEnv("PLANS", "on");
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
  try {
    expect(await handlers.resubmitReplyEmails({}, { info: () => {}, warn: () => {} })).toEqual({ found: 0, queued: 0 });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the safety net leaves a new project's replies out once it's past its daily cap, as paused ones", async () => {
  const voter = await verified("Voter");
  const { post } = await votedFor(voter);
  vi.spyOn(log, "warn").mockImplementation(() => {});
  mailbox.refuseNext(voter.email, { code: 421 });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "Shipping soon.", emailVoters: true });
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "support.example.com");
  // Midday, so the cap's day is the same day for the row and the safety net (not across midnight UTC).
  const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  vi.useFakeTimers({ toFake: ["Date"], now: noon });
  try {
    await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date(noon.getTime() - 11 * 60_000) } });
    await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(noon.toISOString().slice(0, 10)), claimed: 200 } });
    expect(await handlers.resubmitReplyEmails({}, { info: () => {}, warn: () => {} })).toEqual({ found: 0, queued: 0 });
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
