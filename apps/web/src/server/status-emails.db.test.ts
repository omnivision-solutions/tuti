import { prisma } from "@tuti/db";
import { postStatusChanged } from "@tuti/jobs";
import { beforeEach, expect, test } from "vitest";

import { createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** A post's people hear when the team moves it to Planned or In progress, once per status, as they hear when it ships. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
const setStatus = (number: number, status: "open" | "under_review" | "planned" | "in_progress" | "completed" | "closed") => call(updatePost, as(owner.id), { number, status });
const subjectsTo = (address: string) => mailbox.emails.filter((e) => e.to.includes(address) && !e.subject.startsWith("Verify your email")).map((e) => e.subject);
const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};

/** A post by `author` that `voters` voted for. */
async function postVotedBy(author: TestUser, voters: TestUser[]) {
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "CSV export" });
  for (const voter of voters) {
    await call(setVote, as(voter.id), { number: post.number, voted: true });
  }
  return post;
}

test("moving a post to In progress emails its voters once, with its votes and status", async () => {
  const [author, voter] = [await verified("Author"), await verified("Voter")];
  const post = await postVotedBy(author, [voter]);

  await setStatus(post.number, "in_progress");

  for (const person of [author, voter]) {
    expect(subjectsTo(person.email)).toEqual(["In progress: CSV export"]);
  }
  const email = mailbox.emails.find((e) => e.to.includes(voter.email) && e.subject.startsWith("In progress"))!;
  expect(email.text).toContain("CSV export is in progress");
  expect(email.text).toContain("The team has started building it. We'll email you again when it ships.");
  expect(email.text).toContain(`/feedback/feature-requests/csv-export-${post.number}`);
  expect(email.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
  // Counted on the change, as a completion's are.
  expect(await prisma.postEvent.findFirstOrThrow({ where: { post: { projectId: project.id }, to: "IN_PROGRESS" }, select: { emailed: true } })).toEqual({ emailed: 2 });
});

test("Planned then In progress sends one of each; back and forth sends nothing more; Completed still sends the shipped email, and reopening it nothing", async () => {
  const [author, voter] = [await verified("Author"), await verified("Voter")];
  const post = await postVotedBy(author, [voter]);

  await setStatus(post.number, "planned");
  await setStatus(post.number, "in_progress");
  expect(subjectsTo(voter.email)).toEqual(["Planned: CSV export", "In progress: CSV export"]);

  await setStatus(post.number, "planned");
  await setStatus(post.number, "in_progress");
  expect(subjectsTo(voter.email)).toHaveLength(2);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: null });

  await setStatus(post.number, "completed");
  expect(subjectsTo(voter.email)).toEqual(["Planned: CSV export", "In progress: CSV export", "Done: CSV export"]);
  await setStatus(post.number, "in_progress");
  expect(subjectsTo(voter.email)).toHaveLength(3);
});

test("moving back (an Undo, a reopened post) tells nobody, though that status was never emailed", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  await setStatus(post.number, "completed");
  await setStatus(post.number, "in_progress");
  await setStatus(post.number, "planned");
  expect(subjectsTo(voter.email)).toEqual(["Done: CSV export"]);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: null });
});

test("Under review, Open and Closed email nobody; nor does a move for people who turned these emails off or unsubscribed", async () => {
  const [author, voter, quiet, unsubscribed] = [await verified("Author"), await verified("Voter"), await verified("Quiet"), await verified("Gone")];
  const post = await postVotedBy(author, [voter, quiet, unsubscribed]);
  await prisma.emailPreference.create({ data: { projectId: project.id, userId: quiet.id, followedPosts: false } });
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: unsubscribed.id } });

  for (const status of ["under_review", "closed", "open"] as const) {
    await setStatus(post.number, status);
  }
  expect(subjectsTo(voter.email)).toEqual([]);

  await setStatus(post.number, "in_progress");
  expect(subjectsTo(voter.email)).toEqual(["In progress: CSV export"]);
  expect(subjectsTo(quiet.email)).toEqual([]);
  expect(subjectsTo(unsubscribed.email)).toEqual([]);
});

test("a change the post has already moved on from leaves the newer change's emails due", async () => {
  const [author, voter] = [await verified("Author"), await verified("Voter")];
  const post = await postVotedBy(author, [voter]);
  await setStatus(post.number, "in_progress");
  const row = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  const due = new Date();
  await prisma.post.update({ where: { id: row.id }, data: { shippedEmailsDueAt: due } });

  // An earlier move back to Open, its handler finishing late (after the webhooks were told), while the post is In progress.
  const stale = { number: post.number, title: "CSV export", status: "open", visibility: "public" } as unknown as Parameters<typeof postStatusChanged>[2];
  await postStatusChanged(project.id, row.id, stale, "PLANNED");

  expect(await prisma.post.findUniqueOrThrow({ where: { id: row.id }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: due });
});
