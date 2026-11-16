import { prisma } from "@tuti/db";
import { postStatusChanged } from "@tuti/jobs";
import { readFileSync } from "node:fs";

import { handlers } from "@tuti/jobs";
import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  // The heading (an h1, upper-cased in plain text).
  expect(email.text).toContain("CSV EXPORT IS IN PROGRESS");
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

test("a Planned run that finishes after the post moved to In progress leaves the In progress emails due, and they go", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  // Planned and due, its run not started yet (set here, so no job runs).
  await prisma.post.update({ where: { id: postId }, data: { status: "PLANNED", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
  // The team moves it on just as that run takes its first person (the move's own job not run yet).
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      await prisma.post.update({ where: { id: postId }, data: { status: "IN_PROGRESS", shippedEmailsDueAt: new Date() } });
      await prisma.postEvent.create({ data: { postId, from: "PLANNED", to: "IN_PROGRESS" } });
    }
    return transaction(...args);
  }) as never);
  try {
    await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  } finally {
    spy.mockRestore();
  }
  expect(subjectsTo(voter.email)).toEqual([]);
  // The late Planned run didn't take the In progress emails' due time: the next run sends them.
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt).not.toBeNull();
  await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  expect(subjectsTo(voter.email)).toEqual([`In progress: ${post.title}`]);
});

test("the migration clears due times the previous release left on posts that aren't Completed, and keeps a Completed one's", async () => {
  const author = await verified("Author");
  const [reopened, shipped] = [await postVotedBy(author, []), await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" })];
  const due = new Date(Date.now() - 60_000);
  const idOf = async (number: number) => (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number }, select: { id: true } })).id;
  const [reopenedId, shippedId] = [await idOf(reopened.number), await idOf(shipped.number)];
  // Completed with its emails held, then reopened by the previous release (which never cleared the due time).
  await prisma.post.update({ where: { id: reopenedId }, data: { status: "IN_PROGRESS", shippedEmailsDueAt: due } });
  await prisma.post.update({ where: { id: shippedId }, data: { status: "COMPLETED", shippedEmailsDueAt: due } });

  await prisma.$executeRawUnsafe(readFileSync(`${__dirname}/../../../../packages/db/prisma/migrations/20261116090000_status_emails_stale_due/migration.sql`, "utf8"));

  expect(await prisma.post.findUniqueOrThrow({ where: { id: reopenedId }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: null });
  expect(await prisma.post.findUniqueOrThrow({ where: { id: shippedId }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: due });
});

test("reopened after it shipped, then planned or started again: nobody told it shipped gets a progress email; someone who came since does", async () => {
  for (const [reopened, next, subject] of [
    ["open", "in_progress", "In progress: CSV export"],
    ["closed", "planned", "Planned: CSV export"],
  ] as const) {
    const [author, voter] = [await verified("Author"), await verified("Voter")];
    const post = await postVotedBy(author, [voter]);
    await setStatus(post.number, "completed");
    await setStatus(post.number, reopened);
    const later = await verified("Later");
    await call(setVote, as(later.id), { number: post.number, voted: true });

    await setStatus(post.number, next);

    for (const told of [author, voter]) {
      expect(subjectsTo(told.email)).toEqual(["Done: CSV export"]);
    }
    expect(subjectsTo(later.email)).toEqual([subject]);
  }
});

test("a due time a move back left (the previous release's, during a deploy) emails nobody, and is cleared", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  // Moved from Completed back to In progress by the previous release, which left its due time set.
  await prisma.post.update({ where: { id: postId }, data: { status: "IN_PROGRESS", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "COMPLETED", to: "IN_PROGRESS" } });

  expect(await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} })).toEqual({ skipped: true });
  expect(subjectsTo(voter.email)).toEqual([]);
  expect(await prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: null });
});

test("moved on and back to the same status while its run goes, nobody else is claimed: the move back emails nobody", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  // In progress and due, its run not started yet (set here, so no job runs).
  await prisma.post.update({ where: { id: postId }, data: { status: "IN_PROGRESS", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "IN_PROGRESS" } });
  // As the run takes its first person, the team completes it and reopens it to In progress (its due time left as it was).
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      await prisma.postEvent.create({ data: { postId, from: "IN_PROGRESS", to: "COMPLETED" } });
      await prisma.postEvent.create({ data: { postId, from: "COMPLETED", to: "IN_PROGRESS" } });
    }
    return transaction(...args);
  }) as never);
  try {
    await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  } finally {
    spy.mockRestore();
  }
  expect(subjectsTo(voter.email)).toEqual([]);
  expect(await prisma.statusEmail.count({ where: { postId } })).toBe(0);
});

test("a run that finishes after its post moved away and back to the same status leaves the newer move's emails due", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  // Planned and due, its run not started yet (set here, so no job runs).
  await prisma.post.update({ where: { id: postId }, data: { status: "PLANNED", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
  // As the run takes its first person, the team reopens it and plans it again: a new move, due for its own run.
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      await prisma.postEvent.create({ data: { postId, from: "PLANNED", to: "OPEN" } });
      await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
      await prisma.post.update({ where: { id: postId }, data: { shippedEmailsDueAt: new Date() } });
    }
    return transaction(...args);
  }) as never);
  try {
    await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  } finally {
    spy.mockRestore();
  }
  // The older run didn't clear what the newer move left due.
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { shippedEmailsDueAt: true } })).shippedEmailsDueAt).not.toBeNull();
});

test("a run's people are never older than the move it checks: someone voting while the post goes away and back to Planned is emailed by the next run", async () => {
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "PLANNED", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
  const later = await verified("Later");
  // Right after the run reads the post and its people: reopened, Later votes, planned again (due for its own run).
  const findFirst = prisma.post.findFirst.bind(prisma.post) as (...args: unknown[]) => Promise<unknown>;
  let moved = false;
  vi.spyOn(prisma.post, "findFirst").mockImplementation((async (args: { where?: { id?: string; status?: unknown } }) => {
    const read = await findFirst(args);
    if (!moved && args?.where?.id === postId && args.where.status !== undefined) {
      moved = true;
      await prisma.postEvent.create({ data: { postId, from: "PLANNED", to: "OPEN" } });
      await prisma.vote.create({ data: { postId, userId: later.id, projectId: project.id } });
      await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
      await prisma.post.update({ where: { id: postId }, data: { shippedEmailsDueAt: new Date() } });
    }
    return read;
  }) as never);
  await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  vi.restoreAllMocks();
  expect(moved).toBe(true);
  expect(subjectsTo(voter.email)).toEqual(["Planned: CSV export"]);
  // The older run's people didn't have Later; it left the newer move due, so its run emails them.
  expect(subjectsTo(later.email)).toEqual([]);
  await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  expect(subjectsTo(later.email)).toEqual(["Planned: CSV export"]);
  expect(subjectsTo(voter.email)).toHaveLength(1);
});

test("a status handler that resumes after another move committed neither clears nor sets that move's due time", async () => {
  // The project's email paused, so the newer move's emails stay due (its run waits) for the delayed handler to meet.
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "IN_PROGRESS" } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "IN_PROGRESS" } });
  // Moved back to Planned (emails nobody: its handler clears what's due); that handler waits as it starts, while the
  // post goes to Open and is planned again (due for its emails).
  const count = prisma.post.count.bind(prisma.post) as (...args: unknown[]) => Promise<number>;
  let delayed = false;
  vi.spyOn(prisma.post, "count").mockImplementation((async (args: { where?: { id?: string; sample?: boolean } }) => {
    if (!delayed && args?.where?.id === postId && args.where.sample === true) {
      delayed = true;
      await setStatus(post.number, "open");
      await setStatus(post.number, "planned");
    }
    return count(args);
  }) as never);
  await setStatus(post.number, "planned");
  vi.restoreAllMocks();
  expect(delayed).toBe(true);
  const due = await prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { status: true, shippedEmailsDueAt: true } });
  expect(due.status).toBe("PLANNED");
  // The newer move's due time is still there, for its run once the email resumes.
  expect(due.shippedEmailsDueAt).not.toBeNull();
});

test("someone told it shipped while an In progress run was paused (completed, reopened, started again) gets no progress email from it", async () => {
  const voter = await verified("Voter");
  const author = await verified("Author");
  const post = await postVotedBy(author, [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "IN_PROGRESS", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "IN_PROGRESS" } });
  // As the run takes its first person: completed (both told it shipped), reopened and started again.
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      await prisma.postEvent.create({ data: { postId, from: "IN_PROGRESS", to: "COMPLETED" } });
      await prisma.shippedEmail.createMany({ data: [voter, author].map(({ id }) => ({ postId, userId: id, sentAt: new Date() })) });
      await prisma.postEvent.create({ data: { postId, from: "COMPLETED", to: "OPEN" } });
      await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "IN_PROGRESS" } });
    }
    return transaction(...args);
  }) as never);
  await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} });
  vi.restoreAllMocks();
  expect(claims).toBeGreaterThan(0);
  for (const person of [voter, author]) {
    expect(subjectsTo(person.email)).toEqual([]);
  }
});

test("a run the monthly limit holds leaves a newer move's due time as it was, not next month", async () => {
  // One email a month: the run's second person waits.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => {
    free.limits.emailsPerMonth = 1;
  }));
  const voter = await verified("Voter");
  const post = await postVotedBy(await verified("Author"), [voter]);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "PLANNED", shippedEmailsDueAt: new Date() } });
  await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
  // As the run takes its first person, the team reopens it and plans it again: due now, for that move's own run.
  const newer = new Date(Date.now() - 1000);
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      await prisma.postEvent.create({ data: { postId, from: "PLANNED", to: "OPEN" } });
      await prisma.postEvent.create({ data: { postId, from: "OPEN", to: "PLANNED" } });
      await prisma.post.update({ where: { id: postId }, data: { shippedEmailsDueAt: newer } });
    }
    return transaction(...args);
  }) as never);
  expect(await handlers.postShipped({ postId }, { info: () => {}, warn: () => {} })).toMatchObject({ emailed: 1, waiting: expect.any(String) });
  vi.restoreAllMocks();
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { shippedEmailsDueAt: true } })).shippedEmailsDueAt).toEqual(newer);
});
