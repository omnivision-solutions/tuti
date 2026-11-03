import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { postVersion, queueAutopilotNotices, readAutopilotButton, sendAutopilotEmails, signAutopilotButton } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { GET as act } from "@/app/app/[project]/autopilot/[id]/act/route";
import {
  applyCodeChangeAction,
  dismissCodeChangeAction,
  getCodeChangeTarget,
  listCodeChangeTargets,
  undoCodeChangeAction,
} from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** A post's update from several pull requests (docs/plan.md, V4): one status change with one comment, each pull request's part kept. */

let owner: TestUser;
let voter: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let post: { id: string; number: number };
let number = 0;

// AI on (Autopilot and its email need it), with local fakes: nothing leaves the machine.
let fakes: { close: () => Promise<void> }[] = [];
beforeAll(async () => {
  const [model, openai] = await Promise.all([startModelFake(), startOpenAIFake()]);
  fakes = [model, openai];
  for (const [name, value] of Object.entries({ ...model.env, OPENAI_BASE_URL: openai.url, OPENAI_API_KEY: FAKE_OPENAI_KEY })) {
    vi.stubEnv(name, value);
  }
});
afterAll(() => Promise.all(fakes.map((fake) => fake.close())));
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await prisma.autopilotNotice.deleteMany({});
  owner = await signUp("Olive Owner");
  voter = await signUp("Vera Voter");
  await prisma.user.update({ where: { id: voter.id }, data: { emailVerified: true } });
  project = await createProject(owner);
  actAs(owner);
  const created = await call(createPost, { actor: { kind: "user", userId: voter.id }, projectId: project.id }, { board: "feature-requests", title: "Recurring events" });
  post = await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: created.number } }, data: { status: "PLANNED" }, select: { id: true, number: true } });
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** A merged pull request's part of the post's update. */
async function part(kind: CodeChangeActionKind, comment?: string, extra = {}) {
  number++;
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, author: "octo", mergedAt: new Date(), state: "READY", summary: `What ${number} changed` },
  });
  const action = await prisma.codeChangeAction.create({
    data: { codeChangeId: change.id, kind, postId: post.id, probability: 0.9, reason: `Because of ${number}`, payload: comment === undefined ? {} : { comment }, ...extra },
  });
  return { ...action, url: change.url };
}

const review = () => call(getCodeChangeTarget, team(), { type: "feedback", id: post.id });
const postNow = async () => {
  const now = await prisma.post.findUniqueOrThrow({
    where: { id: post.id },
    select: { status: true, commentCount: true, comments: { select: { body: true } }, links: { select: { url: true } } },
  });
  return { ...now, links: now.links.map((link) => link.url).sort() };
};
const statuses = (...ids: string[]) =>
  prisma.codeChangeAction.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" }, select: { status: true } }).then((rows) => rows.map((row) => row.status));

test("a second pull request's progress update joins the waiting one: one update with one comment, approved once, linked to both", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  expect((await review()).update).toEqual({
    parts: [first.id, second.id],
    revision: postVersion([first.id, second.id]),
    kind: "moves_forward",
    comment: "Weekly repeats are out.\n\nMonthly ones are out too.",
    status: "pending",
    applyLikely: true,
    emails: 0,
  });
  // The list shows the post once, as its one update.
  const { feedback } = await call(listCodeChangeTargets, team(), {});
  expect(feedback).toEqual([expect.objectContaining({ path: `feedback/${post.id}`, badge: "in_progress", waiting: 2, likely: [expect.objectContaining({ kind: "moves_forward", revision: postVersion([first.id, second.id]) })] })]);

  // Approving either part approves all of it: one comment, its people told once.
  await call(applyCodeChangeAction, team(), { id: second.id, revision: postVersion([first.id, second.id]) });
  expect(await postNow()).toEqual({
    status: "IN_PROGRESS",
    commentCount: 1,
    // (A paragraph each.)
    comments: [{ body: "Weekly repeats are out.\nMonthly ones are out too." }],
    links: [first.url, second.url].sort(),
  });
  expect(await statuses(first.id, second.id)).toEqual(["APPLIED", "APPLIED"]);
  expect((await review()).update).toBeNull();
  await expect(call(applyCodeChangeAction, team(), { id: first.id })).rejects.toThrow("Someone already applied or dismissed this");
});

test("completing replaces a waiting progress update, its comment folded in; dismissing the completion brings the progress update back", async () => {
  const progress = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const completes = await part("RESOLVES");
  expect((await review()).update).toMatchObject({ parts: [progress.id, completes.id], kind: "resolves", comment: "Weekly repeats are out.", emails: 1 });
  expect((await call(listCodeChangeTargets, team(), {})).feedback[0]).toMatchObject({ badge: "completing" });

  await call(dismissCodeChangeAction, team(), { id: completes.id });
  expect((await review()).update).toMatchObject({ parts: [progress.id], kind: "moves_forward", comment: "Weekly repeats are out." });

  // Completed with it: the post completed (its people emailed that it shipped), the progress comment posted with it.
  const again = await part("RESOLVES");
  await call(applyCodeChangeAction, team(), { id: progress.id, revision: postVersion([progress.id, again.id]) });
  expect(await postNow()).toMatchObject({ status: "COMPLETED", comments: [{ body: "Weekly repeats are out." }] });
  expect(mailbox.emails.filter((email) => email.to.includes(voter.email) && !email.subject.startsWith("Verify"))).toHaveLength(1);
});

test("dismissing one pull request's part takes only its part out of the comment while it waits", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  const third = await part("MOVES_FORWARD", "Yearly ones next.");
  await call(dismissCodeChangeAction, team(), { id: second.id, reason: "Not yet" });
  expect((await review()).update).toMatchObject({ parts: [first.id, third.id], comment: "Weekly repeats are out.\n\nYearly ones next." });
  expect(await statuses(first.id, second.id, third.id)).toEqual(["PENDING", "DISMISSED", "PENDING"]);
});

test("an approval is for the update it was shown: a part landing or going since refuses it, and nothing is posted", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const shown = (await review()).update!.revision;
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  await expect(call(applyCodeChangeAction, team(), { id: first.id, revision: shown })).rejects.toThrow("The post's update changed since you reviewed it");
  await call(dismissCodeChangeAction, team(), { id: second.id });
  // As it was again: the same parts.
  await call(applyCodeChangeAction, team(), { id: first.id, revision: shown });
  expect((await postNow()).comments).toEqual([{ body: "Weekly repeats are out." }]);
});

test("Undo of a post's update applied as one puts all of it back, for every pull request in it, and the review says so first", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("RESOLVES");
  await call(applyCodeChangeAction, team(), { id: first.id });
  expect(await postNow()).toMatchObject({ status: "COMPLETED", commentCount: 1, links: [first.url, second.url].sort() });

  // Each part's Undo says it's the whole update (the page's dialog: "all of it is undone").
  const decided = (await review()).actions;
  for (const id of [first.id, second.id]) {
    expect(decided.find((action) => action.id === id)).toMatchObject({ status: "applied", canUndo: true, together: [first.id, second.id] });
  }
  await call(undoCodeChangeAction, team(), { id: second.id });
  expect(await postNow()).toEqual({ status: "PLANNED", commentCount: 0, comments: [], links: [] });
  expect(await statuses(first.id, second.id)).toEqual(["UNDONE", "UNDONE"]);
  await expect(call(undoCodeChangeAction, team(), { id: first.id })).rejects.toThrow("Only an approved update can be undone");
});

test("the email shows the post's whole update, and its one click approves only that: after another part lands, it does nothing and says so", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  await queueAutopilotNotices(second.codeChangeId);
  await sendAutopilotEmails(new Date(Date.now() + 11 * 60_000));
  const email = mailbox.emails.find((one) => one.to.includes(owner.email) && one.from.startsWith('"Tuti Autopilot"'))!;
  // Both pull requests' words: what Approve posts.
  expect(email.text).toMatch(/\+ Weekly repeats are out\.\s+Monthly ones are out too\./);
  // Its Approve is for that version.
  const token = new URL(email.text.match(/Approve (\S+)/)![1]!).searchParams.get("token")!;
  expect(readAutopilotButton(token)?.button).toBe(`approve:${second.id}@${postVersion([first.id, second.id])}`);

  // A third lands before the click: the click does nothing, and the review says the update changed.
  await part("MOVES_FORWARD", "Yearly ones next.");
  const landed = await click(second.codeChangeId, token);
  expect(landed).toBe(`/app/${project.slug}/autopilot/feedback/${post.id}?done=changed&button=approve&update=${second.id}&select=${second.id}`);
  expect((await postNow()).comments).toEqual([]);
});

/** Opens a button's link as the browser would: where it lands. */
async function click(codeChangeId: string, token: string): Promise<string> {
  return act(new Request(`http://tuti.localhost/app/${project.slug}/autopilot/${codeChangeId}/act?token=${token}`), {
    params: Promise.resolve({ project: project.slug, id: codeChangeId }),
  }).then(
    () => "no redirect",
    (error: { digest?: string }) => error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);/)?.[1] ?? Promise.reject(error),
  );
}

test("a part landing as an approval starts (after the update was read, before it's claimed) refuses it: never what's left of it beside the new part", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  // The approval reads the post's update (its first read of the parts), then another pull request's part lands.
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  let landed: Awaited<ReturnType<typeof part>> | null = null;
  vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
    const read = await findMany(...args);
    landed = await part("MOVES_FORWARD", "Monthly ones are out too.");
    return read;
  }) as never);
  await expect(call(applyCodeChangeAction, team(), { id: first.id })).rejects.toThrow("The post's update changed since you reviewed it");
  expect(await statuses(first.id, landed!.id)).toEqual(["PENDING", "PENDING"]);
  expect(await postNow()).toMatchObject({ status: "PLANNED", comments: [], links: [] });
});

test("a failed approval puts every part back to waiting in one go, or none: never a post's update half applied", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  // Merged into another post meanwhile: posting there is refused, and the parts are put back…
  const other = await call(createPost, team(), { board: "feature-requests", title: "Calendar" });
  await prisma.post.update({ where: { id: post.id }, data: { duplicateOfId: (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: other.number } })).id } });
  // …and putting the second back fails.
  const updateMany = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => unknown;
  let writes = 0;
  vi.spyOn(prisma.codeChangeAction, "updateMany").mockImplementation(((...args: unknown[]) =>
    ++writes === 2 ? Promise.reject(new Error("connection reset")) : updateMany(...args)) as never);
  await expect(call(applyCodeChangeAction, team(), { id: first.id })).rejects.toThrow("Couldn't put an Autopilot update back after a failure");
  // Neither went back: it's one update, applied as far as anyone can tell (never applied again on its own), and says to check it.
  expect(await statuses(first.id, second.id)).toEqual(["APPLIED", "APPLIED"]);
});

test("a failed approval puts each part back as it was when claimed: a hold put on it just before stays", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.", { status: "SCHEDULED", dueAt: new Date(Date.now() + 3_600_000) });
  // Merged into another post meanwhile: the approval is refused after its claim, and puts the parts back.
  const other = await call(createPost, team(), { board: "feature-requests", title: "Calendar" });
  await prisma.post.update({ where: { id: post.id }, data: { duplicateOfId: (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: other.number } })).id } });
  // Right after the approval first reads the post's update, the schedule holds the second back (the same parts: the
  // approval goes ahead). (A teammate's Stop there changes the update's version: refused before anything's claimed.)
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
    const read = await findMany(...args);
    await prisma.codeChangeAction.update({ where: { id: second.id }, data: { status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" } });
    return read;
  }) as never);
  await expect(call(applyCodeChangeAction, team(), { id: first.id })).rejects.toThrow("merged");
  expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: second.id }, select: { status: true, decidedById: true, waitReason: true, dueAt: true } })).toEqual({
    status: "PENDING",
    decidedById: null,
    waitReason: "Another part of its update waits for you",
    dueAt: null,
  });
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("PENDING");
});

test("a part a teammate stopped: the email has no one-click Approve for its update, and one shown before the Stop does nothing", async () => {
  const first = await part("MOVES_FORWARD", "Weekly repeats are out.");
  const second = await part("MOVES_FORWARD", "Monthly ones are out too.");
  // An Approve the email showed before the Stop: for both parts as they were then.
  const before = signAutopilotButton(owner.id, first.codeChangeId, `approve:${first.id}@${postVersion([first.id, second.id])}`)!;
  await prisma.codeChangeAction.update({ where: { id: second.id }, data: { decidedById: owner.id, decidedAt: new Date(), waitReason: "Stopped by Olive Owner" } });
  await queueAutopilotNotices(first.codeChangeId);
  await sendAutopilotEmails(new Date(Date.now() + 11 * 60_000));
  const email = mailbox.emails.find((one) => one.to.includes(owner.email) && one.from.startsWith('"Tuti Autopilot"'))!;
  // Its update shows (both pull requests' words), with Edit: Review on the page, which shows the Stop and asks.
  expect(email.text).toMatch(/\+ Weekly repeats are out\.\s+Monthly ones are out too\./);
  expect(email.text).not.toMatch(/Approve http/);
  expect(email.text).toMatch(/Edit http\S+\/autopilot\/feedback\//);
  expect(await click(first.codeChangeId, before)).toBe(`/app/${project.slug}/autopilot/feedback/${post.id}?done=changed&button=approve&update=${first.id}&select=${first.id}`);
  expect((await postNow()).comments).toEqual([]);
});
