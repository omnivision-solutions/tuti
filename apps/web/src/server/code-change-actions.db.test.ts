import { type CodeChangeActionKind, type PostStatus, prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type Doc, fromPlainText, toPlainText } from "@tuti/content";
import { addToRunningDraft, docOf, hasTeammateEdit, postVersion, undoChangelogLine } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { applyCodeChange, approveCodeChanges } from "@/server/code-changes";
import {
  applyCodeChangeAction,
  applyCodeChangeActions,
  codeChangeList,
  dismissCodeChangeAction,
  getCodeChange,
  getCodeChangeTarget,
  listCodeChanges,
  undoCodeChangeAction,
  autopilotRecord,
  waitingUpdates,
} from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { ARTICLE_REVISIONS_KEPT, createArticle, deleteArticle, discardChanges, listRevisions, publishArticle, publishChanges, unpublishArticle, updateArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, failTransaction, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

let owner: TestUser;
let voter: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  voter = await signUp("Vera Voter");
  await prisma.user.update({ where: { id: voter.id }, data: { emailVerified: true } });
  project = await createProject(owner);
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const PR_URL = "https://github.com/acme/app/pull/12";

/** A post (voted for by the voter) and a ready code change proposing `kind` for it. */
async function proposal(kind: CodeChangeActionKind, { status = "PLANNED" as PostStatus, probability = 0.9, comment = "" } = {}) {
  const post = await call(createPost, { actor: { kind: "user", userId: voter.id }, projectId: project.id }, { board: "feature-requests", title: `Dark mode ${kind}` });
  const row = await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: post.number } }, data: { status }, select: { id: true, number: true } });
  const change = await prisma.codeChange.upsert({
    where: { projectId_repoId_number: { projectId: project.id, repoId: 1, number: 12 } },
    create: { projectId: project.id, repoId: 1, repo: "acme/app", number: 12, url: PR_URL, title: "Dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
    update: {},
  });
  const action = await prisma.codeChangeAction.create({
    data: { codeChangeId: change.id, kind, postId: row.id, probability, reason: "It ships a dark theme", payload: comment ? { comment } : {} },
  });
  return { post: row, change, action };
}

const postOf = (id: string) =>
  prisma.post.findUniqueOrThrow({
    where: { id },
    select: { status: true, links: { select: { url: true, source: true, codeChangeId: true } }, comments: { select: { body: true, authorId: true } } },
  });
const shippedTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && !email.subject.startsWith("Verify your email"));

describe("applying", () => {
  test("resolves: links the post to the pull request, completes it (its people are emailed) and adds it to the PR's changelog entry", async () => {
    const { post, change, action } = await proposal("RESOLVES");
    const entry = await prisma.changelogEntry.create({
      data: { projectId: project.id, number: 1, title: "Next release", collecting: true, pullRequests: { create: { url: PR_URL, repo: "acme/app", number: 12, title: "Dark theme" } } },
    });
    expect(await call(applyCodeChangeAction, team(), { id: action.id })).toEqual({ id: action.id, kind: "resolves", status: "applied", post: post.number });
    expect(await postOf(post.id)).toEqual({ status: "COMPLETED", links: [{ url: PR_URL, source: "CODE_CHANGE", codeChangeId: change.id }], comments: [] });
    expect(await prisma.changelogEntryPost.findMany({ where: { entryId: entry.id }, select: { postId: true } })).toEqual([{ postId: post.id }]);
    expect(shippedTo(voter.email)).toHaveLength(1);
    expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { status: true, decidedById: true } })).toEqual({
      status: "APPLIED",
      decidedById: owner.id,
    });
    // Once: a second apply is refused, and nothing happens twice.
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Someone already applied or dismissed this");
    expect(shippedTo(voter.email)).toHaveLength(1);
  });

  test("moves forward: In progress (if it was earlier) and the team's comment, as edited, posted by whoever applies it", async () => {
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    await call(applyCodeChangeAction, team(), { id: action.id, comment: "Weekly repeats are out; monthly next." });
    expect(await postOf(post.id)).toMatchObject({ status: "IN_PROGRESS", comments: [{ body: "Weekly repeats are out; monthly next.", authorId: owner.id }] });
    expect(await call(getCodeChange, team(), { id: (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).codeChangeId! })).toMatchObject({
      actions: [{ kind: "moves_forward", status: "applied", comment: "Weekly repeats are out; monthly next.", decidedBy: "Olive Owner" }],
    });
    // Later statuses stay as they are.
    const later = await proposal("MOVES_FORWARD", { status: "COMPLETED", comment: "More to come." });
    await call(applyCodeChangeAction, team(), { id: later.action.id });
    expect((await postOf(later.post.id)).status).toBe("COMPLETED");
  });

  test("links: only the link, no status, no email, no comment", async () => {
    const { post, change, action } = await proposal("LINKS");
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [{ url: PR_URL, source: "CODE_CHANGE", codeChangeId: change.id }], comments: [] });
    expect(shippedTo(voter.email)).toEqual([]);
  });

  test("if applying fails part way, the action is waiting again, and applying it again finishes it once", async () => {
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Getting there." });
    // The post was merged into another meanwhile: comments go there, so this one refuses it.
    const other = await call(createPost, team(), { board: "feature-requests", title: "Themes" });
    const merged = await prisma.post.update({ where: { id: post.id }, data: { duplicateOfId: (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: other.number } })).id } });
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("merged");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
    await prisma.post.update({ where: { id: merged.id }, data: { duplicateOfId: null } });
    await call(applyCodeChangeAction, team(), { id: action.id });
    const after = await postOf(post.id);
    expect(after.links).toHaveLength(1);
    expect(after.comments).toHaveLength(1);
  });

  test("once the comment may be saved, a failure after it leaves the action applied, so it isn't posted twice", async () => {
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Getting there." });
    // The comment is saved; the lookup right after it fails.
    vi.spyOn(prisma.teamMember, "findFirst").mockRejectedValueOnce(new Error("database blip"));
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("database blip");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Someone already applied or dismissed this");
    expect((await postOf(post.id)).comments).toHaveLength(1);
  });


  test("a comment to post is needed; another project's actions aren't found", async () => {
    const { action } = await proposal("MOVES_FORWARD");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Write the comment to post first");
    const { change } = await proposal("LINKS");

    const outsider = await signUp("Otto Outsider");
    const theirs = await createProject(outsider);
    const them = { actor: { kind: "user" as const, userId: outsider.id }, projectId: theirs.id };
    await expect(call(applyCodeChangeAction, them, { id: action.id })).rejects.toThrow("Action not found");
    await expect(call(dismissCodeChangeAction, them, { id: action.id })).rejects.toThrow("Action not found");
    await expect(call(getCodeChange, them, { id: change.id })).rejects.toThrow("Code change not found");
  });
});

test("dismissing, with a reason: it can't be applied after, nor dismissed twice", async () => {
  const { post, action } = await proposal("RESOLVES");
  expect(await call(dismissCodeChangeAction, team(), { id: action.id, reason: "Only half of it" })).toEqual({ id: action.id, status: "dismissed" });
  expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { status: true, dismissReason: true, decidedById: true } })).toEqual({
    status: "DISMISSED",
    dismissReason: "Only half of it",
    decidedById: owner.id,
  });
  await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Someone already applied or dismissed this");
  await expect(call(dismissCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Someone already applied or dismissed this");
  expect((await postOf(post.id)).status).toBe("PLANNED");
});

test("Autopilot's list: each change's updates waiting, how sure on average, and what approving it from the list approves", async () => {
  const closes = await proposal("RESOLVES", { probability: 0.9 });
  // Sure enough, but no comment to post: its page doesn't tick it.
  await proposal("MOVES_FORWARD", { probability: 0.8 });
  // A teammate stopped it: its page doesn't tick it either.
  const stopped = await proposal("MOVES_FORWARD", { probability: 0.95, comment: "Nearly there." });
  await prisma.codeChangeAction.update({ where: { id: stopped.action.id }, data: { waitReason: "Stopped by Olive Owner" } });
  // A link Autopilot wasn't sure of (left by the previous release): not a review item, so left out.
  await proposal("LINKS", { probability: 0.7 });
  // A changelog line the previous release left waiting: left out (it's written into the running draft by itself).
  await prisma.codeChangeAction.create({ data: { codeChangeId: closes.change.id, kind: "CHANGELOG_LINE", probability: 1, payload: { line: "Dark theme" } } });
  const other = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 13, url: "https://github.com/acme/app/pull/13", title: "Exports", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  const draft = await prisma.codeChangeAction.create({ data: { codeChangeId: other.id, kind: "NEW_ARTICLE", probability: 0.6, payload: { title: "Export it" } } });
  // Another project's change: nothing of it.
  const elsewhere = await createProject(owner);
  const theirs = await prisma.codeChange.create({
    data: { projectId: elsewhere.id, repoId: 2, repo: "acme/other", number: 1, url: "https://github.com/acme/other/pull/1", title: "Theirs", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  await prisma.codeChangeAction.create({ data: { codeChangeId: theirs.id, kind: "LINKS", probability: 0.9 } });

  const lists = await waitingUpdates(project.id, [closes.change.id, other.id, theirs.id]);
  const mine = lists.get(closes.change.id)!;
  expect(mine.updates.map((update) => update.kind).sort()).toEqual(["moves_forward", "moves_forward", "resolves"]);
  // (90 + 80 + 95) / 3 = 88%, likely: over their thresholds on average (75%).
  expect(mine.sure).toEqual({ percent: 88, likely: true });
  // The request it closes emails its author; approved as the post's update listed (its version).
  expect(mine.likely).toEqual([{ id: closes.action.id, kind: "resolves", emails: 1, revision: postVersion([closes.action.id]) }]);
  // 60%, under a new article's 80%: not sure, and nothing to approve from the list.
  expect(lists.get(other.id)).toEqual({ updates: [{ id: draft.id, kind: "new_article" }], sure: { percent: 60, likely: false }, likely: [] });
  expect(lists.get(theirs.id)).toEqual({ updates: [], sure: null, likely: [] });

  // Approved from the list: those, and only those.
  expect(await approveCodeChanges(project.slug, mine.likely.map((update) => ({ id: update.id })))).toMatchObject({ applied: 1, failed: [] });
  expect((await waitingUpdates(project.id, [closes.change.id])).get(closes.change.id)!.updates.map((update) => update.kind).sort()).toEqual(["moves_forward", "moves_forward"]);
});

test("the list puts code changes with proposals waiting first, then the newest", async () => {
  const at = (days: number) => new Date(Date.now() - days * 86_400_000);
  const make = (number: number, mergedAt: Date, state: "READY" | "NOTHING_TO_DO") =>
    prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, author: "octo", mergedAt, state },
    });
  await make(1, at(1), "NOTHING_TO_DO");
  const waiting = await make(2, at(5), "READY");
  await make(3, at(2), "READY");
  await prisma.codeChangeAction.create({ data: { codeChangeId: waiting.id, kind: "NEW_ARTICLE", probability: 0.6 } });
  const { codeChanges } = await call(listCodeChanges, team(), {});
  expect(codeChanges.map(({ number, state, waiting: count }) => ({ number, state, waiting: count }))).toEqual([
    { number: 2, state: "ready", waiting: 1 },
    { number: 1, state: "nothing_to_do", waiting: 0 },
    { number: 3, state: "ready", waiting: 0 },
  ]);
  // Catch up lists only those waiting, however many newer ones don't.
  await prisma.codeChange.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number: 100 + i,
      url: `https://github.com/acme/app/pull/${100 + i}`,
      title: `Newer ${i}`,
      author: "octo",
      mergedAt: at(0),
      state: "READY" as const,
    })),
  });
  expect((await codeChangeList(project.id, { waiting: true })).map((change) => change.number)).toEqual([2]);
  // So does Autopilot's To review (its queue), though the latest 100 leave it out.
  expect((await codeChangeList(project.id, { toReview: true })).map((change) => change.number)).toEqual([2]);
  expect((await codeChangeList(project.id)).map((change) => change.number)).not.toContain(2);
  // Analysed again into nothing to do, an update the team stopped still waits: it stays to review.
  const stopped = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  await prisma.codeChangeAction.create({ data: { codeChangeId: stopped.id, kind: "NEW_ARTICLE", probability: 0.9, status: "PENDING", decidedById: owner.id } });
  expect((await codeChangeList(project.id, { toReview: true })).map((change) => change.number)).toEqual([1, 2]);
  // Paused ones pile up (no plan or credits for Autopilot): only the latest 100 of those, every one waiting still.
  await prisma.codeChange.createMany({
    data: Array.from({ length: 101 }, (_, i) => ({
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number: 300 + i,
      url: `https://github.com/acme/app/pull/${300 + i}`,
      title: `Paused ${i}`,
      author: "octo",
      mergedAt: at(0),
      state: "PAUSED" as const,
    })),
  });
  const toReview = (await codeChangeList(project.id, { toReview: true })).map((change) => change.number);
  expect(toReview).toHaveLength(102);
  expect(toReview.slice(0, 2)).toEqual([1, 2]);
  // Those waiting, however many: the newer 100 given an update each, 102 wait.
  const newer = await prisma.codeChange.findMany({ where: { projectId: project.id, title: { startsWith: "Newer" } }, select: { id: true } });
  await prisma.codeChangeAction.createMany({ data: newer.map((change) => ({ codeChangeId: change.id, kind: "NEW_ARTICLE" as const, probability: 0.9 })) });
  expect((await codeChangeList(project.id, { toReview: true })).filter((change) => change.waiting > 0)).toHaveLength(102);
});

test("proposals as likely as each other keep one order: by kind, then id", async () => {
  const { change, post, action: unlikely } = await proposal("LINKS", { probability: 0.5 });
  // Created out of order, so the order they're stored in isn't the one the team sees.
  for (const [id, kind] of [["b", "LINKS"], ["a", "LINKS"], ["c", "RESOLVES"]] as const) {
    await prisma.codeChangeAction.create({ data: { id, codeChangeId: change.id, kind, postId: post.id, probability: 0.9 } });
  }
  expect((await call(getCodeChange, team(), { id: change.id })).actions.map((action) => action.id)).toEqual(["c", "a", "b", unlikely.id]);
});

describe("undo", () => {
  test("a request it closed: back to its status, the link and the entry's post gone; those emailed are counted first, the rest not sent", async () => {
    const { post, action } = await proposal("RESOLVES");
    const entry = await prisma.changelogEntry.create({
      data: { projectId: project.id, number: 1, title: "Next release", collecting: true, pullRequests: { create: { url: PR_URL, repo: "acme/app", number: 12, title: "Dark theme" } } },
    });
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect(shippedTo(voter.email)).toHaveLength(1);
    const detail = await call(getCodeChange, team(), { id: action.codeChangeId! });
    expect(detail.actions.find((a) => a.id === action.id)).toMatchObject({ status: "applied", emailed: 1 });
    expect(await call(undoCodeChangeAction, team(), { id: action.id })).toEqual({ id: action.id, status: "undone" });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
    expect(await prisma.changelogEntryPost.count({ where: { entryId: entry.id } })).toBe(0);
    expect((await call(getCodeChange, team(), { id: action.codeChangeId! })).actions[0]).toMatchObject({ status: "undone", decidedBy: "Olive Owner" });
    // Once: a second undo is refused.
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Only an approved update can be undone");
  });

  test("a progress update: its comment deleted and the post back to its status; a link it didn't add stays", async () => {
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect(await postOf(post.id)).toMatchObject({ status: "IN_PROGRESS", comments: [{ body: "Weekly repeats are out." }] });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(0);

    // The post had the link already: undoing a link leaves it.
    const linked = await proposal("LINKS");
    await prisma.postLink.create({ data: { projectId: project.id, postId: linked.post.id, kind: "PULL_REQUEST", repo: "acme/app", number: 12, url: PR_URL, title: "Dark theme", source: "MANUAL" } });
    await call(applyCodeChangeAction, team(), { id: linked.action.id });
    await call(undoCodeChangeAction, team(), { id: linked.action.id });
    expect((await postOf(linked.post.id)).links).toEqual([{ url: PR_URL, source: "MANUAL", codeChangeId: null }]);
  });

  test("a try that failed part-way puts back what it did (the link, the status it moved), and waits; approved after, Undo still works", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    // Linked and moved to In progress, then the comment's transaction fails: both are put back.
    failTransaction(new Error("connection reset"), { skip: 1 });
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] })).results[0]).toMatchObject({ status: "failed" });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
    await call(applyCodeChangeAction, team(), { id: action.id });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
  });

  test("a progress update on a post merged since: Undo is refused, saying so, and nothing changes", async () => {
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    await call(applyCodeChangeAction, team(), { id: action.id });
    const other = await call(createPost, team(), { board: "feature-requests", title: "Repeating events" });
    const otherId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: other.number } })).id;
    await prisma.post.update({ where: { id: post.id }, data: { duplicateOfId: otherId } });
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The post was merged into another since: change it there");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
    expect((await postOf(post.id)).comments).toHaveLength(1);
  });

  test("a request completed already when it's approved: Undo leaves it Completed, and the review page says its emails still go", async () => {
    const { action } = await proposal("RESOLVES", { status: "COMPLETED" });
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await call(getCodeChange, team(), { id: action.codeChangeId! })).actions.find((a) => a.id === action.id)).toMatchObject({ canUndo: true, putsBackStatus: false });
    const moved = await proposal("RESOLVES");
    await call(applyCodeChangeAction, team(), { id: moved.action.id });
    expect((await call(getCodeChange, team(), { id: moved.action.codeChangeId! })).actions.find((a) => a.id === moved.action.id)).toMatchObject({ putsBackStatus: true });
  });

  test("one approved before Undo was there (nothing recorded to put back) is refused, and has no Undo", async () => {
    const { post, action } = await proposal("RESOLVES");
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", decidedById: owner.id, decidedAt: new Date(), payload: {} } });
    expect((await call(getCodeChange, team(), { id: action.codeChangeId! })).actions[0]).toMatchObject({ status: "applied", canUndo: false });
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("There's no record of what it changed");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
    expect((await postOf(post.id)).status).toBe("PLANNED");
  });

  test("a link: removed", async () => {
    const { post, action } = await proposal("LINKS");
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await postOf(post.id)).links).toHaveLength(1);
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await postOf(post.id)).links).toEqual([]);
  });
});

test("the review page ticks the likely updates as it opens (not a comment nobody wrote, nor a maybe), and says how many people completing a post emails", async () => {
  // Most likely of all, but with no comment to post: not ticked.
  const unwritten = await proposal("MOVES_FORWARD", { probability: 0.95 });
  const likely = await proposal("RESOLVES", { probability: 0.9 });
  const maybe = await proposal("LINKS", { probability: 0.7 });
  // The post's author is the voter; another voter, a commenter, and a teammate who voted (not emailed).
  const other = await signUp("Otto Other");
  const teammate = await signUp("Tess Team");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  await prisma.vote.createMany({ data: [other, teammate].map((user) => ({ projectId: project.id, postId: likely.post.id, userId: user.id })) });
  await prisma.comment.create({ data: { projectId: project.id, postId: likely.post.id, authorId: other.id, body: "Yes please" } });
  const { actions } = await call(getCodeChange, team(), { id: likely.change.id });
  expect(actions.filter((action) => action.applyLikely).map((action) => action.id)).toEqual([likely.action.id]);
  expect(actions.find((action) => action.id === likely.action.id)).toMatchObject({ emails: 2 });
  // Someone emailed already (it was completed, then reopened): not again.
  await prisma.shippedEmail.create({ data: { postId: likely.post.id, userId: other.id, claimedAt: new Date(), sentAt: new Date() } });
  expect((await call(getCodeChange, team(), { id: likely.change.id })).actions.find((action) => action.id === likely.action.id)).toMatchObject({ emails: 1 });
  expect(actions.map((action) => action.id)).toEqual(expect.arrayContaining([unwritten.action.id, maybe.action.id]));
  // A post completed already (by hand, since): approving emails nobody.
  const done = await proposal("RESOLVES", { status: "COMPLETED" });
  const again = await call(getCodeChange, team(), { id: done.change.id });
  expect(again.actions.find((action) => action.id === done.action.id)).toMatchObject({ emails: 0 });
});

test("how Autopilot is doing: of its last updates that went out, those kept as it wrote them (not edited first, nor undone)", async () => {
  expect(await autopilotRecord(project.id)).toMatchObject({ kept: 0, of: 0 });
  const kept = await proposal("RESOLVES");
  const edited = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
  const undone = await proposal("LINKS");
  await call(applyCodeChangeAction, team(), { id: kept.action.id });
  await call(applyCodeChangeAction, team(), { id: edited.action.id, comment: "Weekly repeats are out; monthly next." });
  await call(applyCodeChangeAction, team(), { id: undone.action.id });
  await call(undoCodeChangeAction, team(), { id: undone.action.id });
  // Waiting, or dismissed: not counted.
  const waiting = await proposal("LINKS");
  await call(dismissCodeChangeAction, team(), { id: waiting.action.id });
  expect(await autopilotRecord(project.id)).toMatchObject({ kept: 1, of: 3 });
  // Approved before edits were recorded (its own words or not, nobody knows): left out.
  const old = await proposal("MOVES_FORWARD", { comment: "Monthly too." });
  await prisma.codeChangeAction.update({ where: { id: old.action.id }, data: { status: "APPLIED", decidedAt: new Date(), payload: { comment: "Monthly too, next week." } } });
  // A changelog line approved (one the previous release left waiting): not counted, it's reviewed in the draft.
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 31, url: "https://github.com/acme/app/pull/31", title: "Faster", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  const line = await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "CHANGELOG_LINE", probability: 1, payload: { line: "Faster search" } } });
  await call(applyCodeChangeAction, team(), { id: line.id, line: "Faster search" });
  expect(await autopilotRecord(project.id)).toMatchObject({ kept: 1, of: 3 });
});

test("how Autopilot is doing: what isn't counted when kept isn't counted when undone; the last 50 are the last proposed, whenever undone", async () => {
  const change = await prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 40, url: "https://github.com/acme/app/pull/40", title: "Docs", author: "octo", mergedAt: new Date(), state: "READY" },
  });
  // The changelog line the analysis wrote by itself: nothing went out, as far as the page is concerned.
  await prisma.codeChangeAction.create({
    data: { codeChangeId: change.id, kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", decidedAt: new Date(), payload: { line: "Docs", undo: { previous: null, added: "entry" } } },
  });
  expect(await autopilotRecord(project.id)).toEqual({ kept: 0, of: 0, wentOut: false });
  // A new article's draft, undone: not counted (nor would it be, kept).
  await prisma.codeChangeAction.create({
    data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, status: "UNDONE", createdAt: new Date(Date.now() - 3 * 86_400_000), decidedAt: new Date(), payload: { undo: { revision: null } } },
  });
  // Something went out, though nothing it can count: the page says so, not "Nothing has gone out yet".
  expect(await autopilotRecord(project.id)).toEqual({ kept: 0, of: 0, wentOut: true });
  // An old link, undone just now, then 50 newer ones kept: the last 50 are the newer ones.
  const day = 86_400_000;
  await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "LINKS", probability: 0.9, status: "UNDONE", createdAt: new Date(Date.now() - 2 * day), decidedAt: new Date(), payload: { undo: { linked: true } } } });
  await prisma.codeChangeAction.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({ codeChangeId: change.id, kind: "LINKS" as const, probability: 0.9, status: "APPLIED" as const, createdAt: new Date(Date.now() - day + i * 1000), decidedAt: new Date(Date.now() - day), payload: { undo: { linked: true } } })),
  });
  expect(await autopilotRecord(project.id)).toMatchObject({ kept: 50, of: 50 });
});

describe("approving several (applyMany)", () => {
  test("each as apply does, with its edits; one refused doesn't stop the rest, and says why", async () => {
    const resolves = await proposal("RESOLVES");
    const forward = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    const dismissed = await proposal("LINKS");
    await call(dismissCodeChangeAction, team(), { id: dismissed.action.id });
    const { results } = await call(applyCodeChangeActions, team(), {
      actions: [{ id: resolves.action.id }, { id: dismissed.action.id }, { id: forward.action.id, comment: "Weekly repeats are out; monthly next." }],
    });
    expect(results).toEqual([
      { id: resolves.action.id, status: "applied" },
      { id: dismissed.action.id, status: "failed", code: "already_decided", message: "Someone already applied or dismissed this" },
      { id: forward.action.id, status: "applied" },
    ]);
    expect((await postOf(resolves.post.id)).status).toBe("COMPLETED");
    expect(await postOf(forward.post.id)).toMatchObject({ status: "IN_PROGRESS", comments: [{ body: "Weekly repeats are out; monthly next." }] });
  });

  test("one failing unexpectedly is reported, and those before and after it are still applied", async () => {
    const first = await proposal("LINKS");
    const failing = await proposal("RESOLVES");
    const last = await proposal("LINKS");
    const upsert = prisma.postLink.upsert.bind(prisma.postLink);
    vi.spyOn(prisma.postLink, "upsert").mockImplementation(((args: Parameters<typeof upsert>[0]) =>
      args.where.postId_url?.postId === failing.post.id ? Promise.reject(new Error("connection reset")) : upsert(args)) as unknown as typeof prisma.postLink.upsert);
    vi.spyOn(log, "error").mockImplementation(() => {});
    const { results } = await call(applyCodeChangeActions, team(), { actions: [{ id: first.action.id }, { id: failing.action.id }, { id: last.action.id }] });
    expect(results).toEqual([
      { id: first.action.id, status: "applied" },
      { id: failing.action.id, status: "failed", code: "internal", message: "Couldn't apply it. Try again in a moment." },
      { id: last.action.id, status: "applied" },
    ]);
    // Not done: it's waiting again.
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: failing.action.id } })).status).toBe("PENDING");
  });

  test("a progress update: approved when its comment was saved before something failed, waiting again when it wasn't", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    // Saved, then reading who wrote it fails. Two paragraphs: a comment keeps them with one line between.
    const saved = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Weekly repeats are out.\n\nMonthly ones are next." });
    vi.spyOn(prisma.teamMember, "findFirst").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: saved.action.id }] })).results).toEqual([{ id: saved.action.id, status: "applied" }]);
    expect((await postOf(saved.post.id)).comments).toHaveLength(1);
    // Whether it was edited is recorded on this path too ("how it's doing" counts it): approved as Autopilot wrote it.
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: saved.action.id } })).payload).toMatchObject({ edited: false });
    // Undo knows the comment it found.
    await call(undoCodeChangeAction, team(), { id: saved.action.id });
    expect((await postOf(saved.post.id)).comments).toHaveLength(0);
    // Not saved: the comment's transaction fails.
    const lost = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Monthly too." });
    failTransaction(new Error("connection reset"), { skip: 1 });
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: lost.action.id }] })).results).toEqual([
      { id: lost.action.id, status: "failed", code: "internal", message: "Couldn't apply it. Try again in a moment." },
    ]);
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: lost.action.id } })).status).toBe("PENDING");
    expect((await postOf(lost.post.id)).comments).toHaveLength(0);
    // Not saved, and checking fails too: it stays applied (never posted twice), reported as unknown, not approved.
    const unknown = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Yearly too." });
    failTransaction(new Error("connection reset"), { skip: 1 });
    vi.spyOn(prisma.comment, "findFirst").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: unknown.action.id }] })).results).toEqual([
      { id: unknown.action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" },
    ]);
    // Nothing known to put back: Undo says so, rather than "Undone" with the comment perhaps still there.
    await expect(call(undoCodeChangeAction, team(), { id: unknown.action.id })).rejects.toThrow("There's no record of what it changed");
  });

  test("two people approving the same ones at once apply each once", async () => {
    const { post, action } = await proposal("RESOLVES");
    const both = await Promise.all([1, 2].map(() => call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] })));
    expect(both.flatMap(({ results }) => results.map((result) => result.status)).sort()).toEqual(["applied", "failed"]);
    expect((await postOf(post.id)).status).toBe("COMPLETED");
    expect(shippedTo(voter.email)).toHaveLength(1);
  });

  test("the review page's Approve, as a server action: how many went, and those that didn't", async () => {
    const { action } = await proposal("LINKS");
    // A page from before `publish` went is told to reload, and nothing is applied.
    const old = { error: "Autopilot changed: reload the page to review this again" };
    expect(await applyCodeChange(project.slug, action.id, { publish: false } as never)).toEqual(old);
    expect(await approveCodeChanges(project.slug, [{ id: action.id, publish: false } as never])).toEqual(old);
    // Options that aren't an object are ignored, not a crash.
    await expect(applyCodeChange(project.slug, "nope", "publish" as never)).resolves.toEqual({ error: "Action not found" });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
    expect(await approveCodeChanges(project.slug, [{ id: action.id }, { id: "nope" }])).toEqual({
      applied: 1,
      failed: [{ id: "nope", message: "Action not found" }],
    });
    // None went: each one says why.
    expect(await approveCodeChanges(project.slug, [{ id: action.id }])).toEqual({ applied: 0, failed: [{ id: action.id, message: "Someone already applied or dismissed this" }] });
    // None of them is the project's: refused.
    expect(await approveCodeChanges(project.slug, [{ id: "nope" }])).toEqual({ error: "Action not found" });
  });
});

describe("docs", () => {
  let number = 20;
  const EDITED = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Pick Light, Dark or System in Settings." }] }] };

  /** A published article in three sections, and its slug and id. */
  async function sectioned() {
    const created = await call(createArticle, team(), { title: "Change the theme", content: sectionsDoc("Themes change how the app looks.", ["Light", "Pick Light in Settings."], ["Dark", "Dark is coming."]) });
    await call(publishArticle, team(), { slug: created.slug });
    const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true, slug: true } });
    return article;
  }
  /** The article's text with one section's paragraph (by its heading, "" before the first) replaced. */
  const rewrite = (heading: string, text: string) => (doc: Doc): Doc => {
    const blocks = [...(doc.content ?? [])];
    const at = heading === "" ? 0 : blocks.findIndex((block) => block.type === "heading" && toPlainText(block) === heading) + 1;
    blocks[at] = { type: "paragraph", content: [{ type: "text", text }] };
    return { type: "doc", content: blocks };
  };
  const texts = async (id: string) => {
    const row = await prisma.article.findUniqueOrThrow({ where: { id }, select: { body: true, changes: { select: { body: true } } } });
    return { published: row.body, changes: row.changes?.body ?? null };
  };
  const statusOf = async (id: string) => (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id } })).status;

  test("each pull request's edit is saved into the article's unpublished changes, tagged; approving publishes them all", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 31, rewrite("Light", "Pick Light or Dark in Settings."));
    const two = await landArticleEdit(project.id, article.id, 32, rewrite("Dark", "Dark is here."));
    // Readers still see the published version; the changes hold both.
    expect(await texts(article.id)).toEqual({
      published: "Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is coming.",
      changes: "Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here.",
    });
    // Each is a revision tagged with its update, written on the one before it: its own diff.
    const rows = await prisma.articleRevision.findMany({ where: { articleId: article.id, codeChangeActionId: { not: null } }, select: { id: true, basedOnId: true, codeChangeActionId: true } });
    expect(rows).toHaveLength(2);
    // By whose they are (two saved in one millisecond don't sort by time).
    const tagged = [one.id, two.id].map((id) => rows.find((revision) => revision.codeChangeActionId === id)!);
    expect(tagged[1]!.basedOnId).toBe(tagged[0]!.id);
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    expect(review).toMatchObject({ revision: tagged[1]!.id, teammateEdit: false, overview: "PR 32's edit, with 1 before it" });
    expect(review.actions.map((action) => [action.number, action.status, action.revision])).toEqual(expect.arrayContaining([[31, "pending", tagged[0]!.id], [32, "pending", tagged[1]!.id]]));

    expect(await call(applyCodeChangeAction, team(), { id: one.id, revision: tagged[1]!.id })).toMatchObject({ status: "applied", published: true });
    expect(await texts(article.id)).toEqual({ published: "Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here.", changes: null });
    expect([await statusOf(one.id), await statusOf(two.id)]).toEqual(["APPLIED", "APPLIED"]);
  });

  test("an approval is for the version it was given: once the text changed since, it does nothing and says so", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 33, rewrite("Light", "Pick Light or Dark in Settings."));
    const seen = (await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).revision!;
    await landArticleEdit(project.id, article.id, 34, rewrite("Dark", "Dark is here."));
    await expect(call(applyCodeChangeAction, team(), { id: one.id, revision: seen })).rejects.toThrow("The article changed since you reviewed it");
    expect((await texts(article.id)).published).toContain("Pick Light in Settings.");
    expect(await statusOf(one.id)).toBe("PENDING");
    const newest = (await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).revision!;
    // An edit landing as the approval starts (before the lock that publishes): refused, not published unreviewed.
    // (Where it read the newest version and the changes' time apart, one landing between the two reads went out.)
    const find = prisma.articleChanges.findUnique.bind(prisma.articleChanges) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.articleChanges, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
      await landArticleEdit(project.id, article.id, 35, rewrite("", "Themes change everything."));
      return find(...args);
    }) as never);
    const lookup = prisma.project.findUniqueOrThrow.bind(prisma.project) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.project, "findUniqueOrThrow").mockImplementationOnce((async (...args: unknown[]) => {
      if ((await prisma.codeChangeAction.count({ where: { articleId: article.id, codeChange: { number: 35 } } })) === 0) {
        await landArticleEdit(project.id, article.id, 35, rewrite("", "Themes change everything."));
      }
      return lookup(...args);
    }) as never);
    await expect(call(applyCodeChangeAction, team(), { id: one.id, revision: newest })).rejects.toThrow("The article changed since you reviewed it");
    expect((await texts(article.id)).published).not.toContain("Themes change everything.");
    expect(await statusOf(one.id)).toBe("PENDING");
  });

  test("`publish`, gone, is refused rather than ignored (`publish: false` would otherwise publish everything waiting)", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 47, rewrite("Light", "Pick Light or Dark in Settings."));
    await expect(call(applyCodeChangeAction, team(), { id: one.id, publish: false } as never)).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(call(applyCodeChangeActions, team(), { actions: [{ id: one.id, publish: false }] } as never)).rejects.toMatchObject({ status: 400 });
    expect(await statusOf(one.id)).toBe("PENDING");
  });

  test("the page's Approve is pinned to the version read before what it shows: an edit landing as it loads isn't published with it", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 54, rewrite("Light", "Pick Light or Dark in Settings."));
    // Right after the page reads the edits it shows, another lands.
    const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
      const shown = await findMany(...args);
      await landArticleEdit(project.id, article.id, 55, rewrite("Dark", "Dark is here."));
      return shown;
    }) as never);
    const review = await call(getCodeChangeTarget, team(), { type: "articles", id: article.id });
    expect(review.actions.map((action) => action.id)).toEqual([one.id]);
    await expect(call(applyCodeChangeAction, team(), { id: one.id, revision: review.revision! })).rejects.toThrow("The article changed since you reviewed it");
    expect((await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { body: true } })).body).not.toContain("Dark is here.");
  });

  test("the overview is the newest edit's while the edits it was written with still wait; after a dismiss, each one's reason", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 48, rewrite("Light", "Pick Light or Dark in Settings."));
    const two = await landArticleEdit(project.id, article.id, 49, rewrite("Dark", "Dark is here."));
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).overview).toBe("PR 49's edit, with 1 before it");
    // One written without knowing of an edit under it doesn't cover that one: each one's reason instead.
    const payload = (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: two.id }, select: { payload: true } })).payload as Record<string, unknown>;
    await prisma.codeChangeAction.update({ where: { id: two.id }, data: { payload: { ...payload, overviewOf: [] } } });
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).overview).toBe("PR 48's edit PR 49's edit");
    await prisma.codeChangeAction.update({ where: { id: two.id }, data: { payload: payload as never } });
    await call(dismissCodeChangeAction, team(), { id: one.id });
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).overview).toBe("PR 49's edit");
  });

  test("an edit waiting on an article unpublished since: Dismiss takes it out of the draft's text, where its changes went", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 50, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(unpublishArticle, team(), { slug: article.slug });
    expect((await texts(article.id)).published).toContain("Pick Light or Dark in Settings.");
    await call(dismissCodeChangeAction, team(), { id: one.id });
    expect(await texts(article.id)).toEqual({ published: "Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is coming.", changes: null });
  });

  test("an approval without a version (Publish now, the API) pins the newest before checking for a teammate's edit", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 51, rewrite("Light", "Pick Light or Dark in Settings."));
    // Right after the check found no teammate's edit, a teammate saves one.
    const find = prisma.article.findUnique.bind(prisma.article) as (...args: unknown[]) => Promise<unknown>;
    let saved = false;
    vi.spyOn(prisma.article, "findUnique").mockImplementation((async (...args: unknown[]) => {
      const found = await find(...args);
      const query = args[0] as { where?: { id?: string }; select?: { changes?: unknown } };
      if (!saved && query.where?.id === article.id && query.select?.changes) {
        saved = true;
        await call(updateArticle, team(), { slug: article.slug, title: "Change the theme, our way" });
      }
      return found;
    }) as never);
    await expect(call(applyCodeChangeAction, team(), { id: one.id })).rejects.toThrow("The article changed since you reviewed it");
    expect(saved).toBe(true);
    expect((await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { title: true } })).title).toBe("Change the theme");
  });

  test("an article unpublished and published again: the edits waiting in it went live with it, approved", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 52, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(unpublishArticle, team(), { slug: article.slug });
    await call(publishArticle, team(), { slug: article.slug });
    expect(await statusOf(one.id)).toBe("APPLIED");
    expect((await texts(article.id)).published).toContain("Pick Light or Dark in Settings.");
  });

  test("an edit whose base revision is gone (pruned by a release before this one) is refused by Dismiss and Undo, never emptying the article", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 53, rewrite("Light", "Pick Light or Dark in Settings."));
    const before = await texts(article.id);
    const tagged = await prisma.articleRevision.findFirstOrThrow({ where: { codeChangeActionId: one.id }, select: { basedOnId: true } });
    await prisma.articleRevision.delete({ where: { id: tagged.basedOnId! } });
    await expect(call(dismissCodeChangeAction, team(), { id: one.id })).rejects.toThrow("There's no record of what it changed any more");
    expect(await texts(article.id)).toEqual(before);
    // Approved on its page (which shows what's in it), Undo refuses alike.
    const revision = (await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).revision!;
    await call(applyCodeChangeAction, team(), { id: one.id, revision });
    await expect(call(undoCodeChangeAction, team(), { id: one.id })).rejects.toThrow("There's no record of what it changed any more");
    expect((await texts(article.id)).published).toBe(before.changes);
  });

  test("an edit the previous release wrote (a whole new article, not in its changes) is out of date: shown so, and only dismissed", async () => {
    const article = await sectioned();
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const action = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "ARTICLE_EDIT", articleId: article.id, probability: 0.9, payload: { problem: "wrong", basedOn: null, content: EDITED, body: "Pick Light, Dark or System in Settings.", before: "" } },
    });
    expect((await call(getCodeChange, team(), { id: change.id })).actions[0]!.status).toBe("stale");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The article changed since this edit was written");
    expect(await statusOf(action.id)).toBe("STALE");
    await call(dismissCodeChangeAction, team(), { id: action.id });
  });

  test("Dismiss takes only its sections out of the changes: a teammate's draft and other edits stay; refused under a later edit to the same section", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 35, rewrite("Light", "Pick Light or Dark in Settings."));
    // A teammate's edit to the opening, then another pull request's on top of the first's section.
    // (Made on the newest version, as the editor says: an edit waits.)
    const onNewest = (await prisma.articleRevision.findFirstOrThrow({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id;
    await call(updateArticle, team(), {
      slug: article.slug,
      content: rewrite("", "Themes change everything.")(docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }))),
      revision: onNewest,
    });
    const two = await landArticleEdit(project.id, article.id, 36, rewrite("Light", "Pick Light, Dark or System in Settings."));
    const three = await landArticleEdit(project.id, article.id, 37, rewrite("Dark", "Dark is here."));
    expect(await hasTeammateEdit(article.id)).toBe(true);
    await expect(call(dismissCodeChangeAction, team(), { id: one.id })).rejects.toThrow("PR #36's edit changed the same section since");
    expect(await statusOf(one.id)).toBe("PENDING");
    await call(dismissCodeChangeAction, team(), { id: three.id });
    expect((await texts(article.id)).changes).toBe("Themes change everything.\nLight\nPick Light, Dark or System in Settings.\nDark\nDark is coming.");
    await call(dismissCodeChangeAction, team(), { id: two.id });
    await call(dismissCodeChangeAction, team(), { id: one.id });
    // The teammate's edit survives every Dismiss (and still holds the article).
    expect(await texts(article.id)).toEqual({
      published: "Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is coming.",
      changes: "Themes change everything.\nLight\nPick Light in Settings.\nDark\nDark is coming.",
    });
  });

  test("Undo a published edit: its sections come out of the published version (published again) and the changes; another's published edit and a teammate's draft stay", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 38, rewrite("Light", "Pick Light or Dark in Settings."));
    const two = await landArticleEdit(project.id, article.id, 39, rewrite("Dark", "Dark is here."));
    await call(applyCodeChangeAction, team(), { id: one.id });
    // A teammate's draft after it went out.
    await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(docOf((await prisma.article.findUniqueOrThrow({ where: { id: article.id } })))) });
    expect((await call(getCodeChangeTarget, team(), { type: "articles", id: article.id })).actions.find((action) => action.id === one.id)).toMatchObject({ canUndo: true });
    await call(undoCodeChangeAction, team(), { id: one.id });
    expect(await texts(article.id)).toEqual({
      published: "Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is here.",
      changes: "Themes change everything.\nLight\nPick Light in Settings.\nDark\nDark is here.",
    });
    expect([await statusOf(one.id), await statusOf(two.id)]).toEqual(["UNDONE", "APPLIED"]);
  });

  test("Undo is refused, naming it, when a later edit changed the same section", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 40, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(applyCodeChangeAction, team(), { id: one.id });
    await landArticleEdit(project.id, article.id, 41, rewrite("Light", "Pick Light, Dark or System in Settings."));
    await expect(call(undoCodeChangeAction, team(), { id: one.id })).rejects.toThrow("PR #41's edit changed the same section since");
    expect(await statusOf(one.id)).toBe("APPLIED");
  });

  test(`an edit's revisions outlive the newest ${ARTICLE_REVISIONS_KEPT}: undone after that many saves, only its sections come out`, async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 42, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(applyCodeChangeAction, team(), { id: one.id });
    for (let n = 1; n <= ARTICLE_REVISIONS_KEPT + 1; n++) {
      const now = docOf(await prisma.article.findUniqueOrThrow({ where: { id: article.id } }));
      await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", `Dark is coming, take ${n}.`)(now), publish: true });
    }
    expect(await prisma.articleRevision.count({ where: { articleId: article.id } })).toBe(ARTICLE_REVISIONS_KEPT + 2);
    await call(undoCodeChangeAction, team(), { id: one.id });
    expect((await texts(article.id)).published).toBe(`Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is coming, take ${ARTICLE_REVISIONS_KEPT + 1}.`);
    // Once undone, they go with the rest.
    await call(updateArticle, team(), { slug: article.slug, title: "Themes" });
    expect(await prisma.articleRevision.count({ where: { articleId: article.id } })).toBe(ARTICLE_REVISIONS_KEPT);
  });

  test("on Free, showing 2 versions, an edit's revisions still show and work past them: undone, only its sections come out", async () => {
    vi.stubEnv("PLANS", "on");
    try {
      const article = await sectioned();
      const one = await landArticleEdit(project.id, article.id, 43, rewrite("Light", "Pick Light or Dark in Settings."));
      await call(applyCodeChangeAction, team(), { id: one.id });
      for (let n = 1; n <= 3; n++) {
        const now = docOf(await prisma.article.findUniqueOrThrow({ where: { id: article.id } }));
        await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", `Dark is coming, take ${n}.`)(now), publish: true });
      }
      // The team sees the newest 2, and the edit's own with the one it was written on, as it can still be undone.
      const shown = (await call(listRevisions, team(), { slug: article.slug })).revisions.map(({ id }) => id);
      const edit = await prisma.articleRevision.findFirstOrThrow({ where: { codeChangeActionId: one.id }, select: { id: true, basedOnId: true } });
      expect(shown).toHaveLength(4);
      expect(shown.slice(2)).toEqual([edit.id, edit.basedOnId]);
      await call(undoCodeChangeAction, team(), { id: one.id });
      expect((await texts(article.id)).published).toBe("Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is coming, take 3.");
      // Once undone, they're hidden with the rest (still stored, until past the largest plan's count).
      expect((await call(listRevisions, team(), { slug: article.slug })).revisions).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("two edits saved with their times the wrong way round are replayed as they were written, not taken for a teammate's", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 47, rewrite("Light", "Pick Light or Dark in Settings."));
    const two = await landArticleEdit(project.id, article.id, 48, rewrite("Light", "Pick Light, Dark or System in Settings."));
    const first = await prisma.articleRevision.findFirstOrThrow({ where: { codeChangeActionId: one.id }, select: { createdAt: true } });
    await prisma.articleRevision.updateMany({ where: { codeChangeActionId: two.id }, data: { createdAt: new Date(first.createdAt.getTime() - 1) } });
    expect(await hasTeammateEdit(article.id)).toBe(false);
    // And taking out the one under the other names the one on top, whatever their times.
    await expect(call(dismissCodeChangeAction, team(), { id: one.id })).rejects.toThrow("PR #48's edit changed the same section since");
  });

  test("a waiting edit on an article deleted since is still dismissed", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 49, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(deleteArticle, team(), { slug: article.slug });
    await call(dismissCodeChangeAction, team(), { id: one.id });
    expect(await statusOf(one.id)).toBe("DISMISSED");
    // Its sections are out of the text the deleted article keeps, so restoring it doesn't bring them back.
    const kept = await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { body: true } });
    expect(kept.body).toContain("Pick Light in Settings.");
    expect(kept.body).not.toContain("Pick Light or Dark in Settings.");
    // One under another that changed the same section: refused, as on a live article, the other named.
    // (Another article: the first one's slug finds the deleted one.)
    await prisma.article.update({ where: { id: article.id }, data: { slug: `${article.slug}-gone` } });
    const other = await sectioned();
    const lower = await landArticleEdit(project.id, other.id, 50, rewrite("Dark", "Dark is here."));
    await landArticleEdit(project.id, other.id, 51, rewrite("Dark", "Dark is here, and System."));
    await call(deleteArticle, team(), { slug: other.slug });
    await expect(call(dismissCodeChangeAction, team(), { id: lower.id })).rejects.toThrow("PR #51's edit changed the same section since");
    expect(await statusOf(lower.id)).not.toBe("DISMISSED");
    // With no record of what it was written on, it's dismissed all the same (the editor can't reach a deleted article).
    const top = await prisma.codeChangeAction.findFirstOrThrow({ where: { articleId: other.id, status: "PENDING", id: { not: lower.id } }, select: { id: true } });
    await prisma.articleRevision.updateMany({ where: { codeChangeActionId: top.id }, data: { basedOnId: null } });
    await call(dismissCodeChangeAction, team(), { id: top.id });
    expect(await statusOf(top.id)).toBe("DISMISSED");
  });

  test("an out-of-date edit in the changes goes out with them when they're published, and isn't taken for a teammate's", async () => {
    const article = await sectioned();
    const stale = await landArticleEdit(project.id, article.id, 52, rewrite("Light", "Pick Light or Dark in Settings."));
    const waiting = await landArticleEdit(project.id, article.id, 53, rewrite("Dark", "Dark is here."));
    await prisma.codeChangeAction.update({ where: { id: stale.id }, data: { status: "STALE" } });
    expect(await hasTeammateEdit(article.id)).toBe(false);
    await call(publishChanges, team(), { slug: article.slug });
    expect(await statusOf(stale.id)).toBe("APPLIED");
    expect(await statusOf(waiting.id)).toBe("APPLIED");
  });

  test("publishing the changes from the editor approves the edits in them; discarding them dismisses them", async () => {
    const article = await sectioned();
    const one = await landArticleEdit(project.id, article.id, 43, rewrite("Light", "Pick Light or Dark in Settings."));
    await call(publishChanges, team(), { slug: article.slug });
    expect(await statusOf(one.id)).toBe("APPLIED");
    const two = await landArticleEdit(project.id, article.id, 44, rewrite("Dark", "Dark is here."));
    await call(discardChanges, team(), { slug: article.slug });
    expect(await statusOf(two.id)).toBe("DISMISSED");
    // A save that publishes them (the API's `publish: true`) approves them too.
    const three = await landArticleEdit(project.id, article.id, 45, rewrite("Dark", "Dark is here."));
    // (Made on the newest version, which publishing needs while edits wait.)
    const onNewest = (await prisma.articleRevision.findFirstOrThrow({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id;
    await call(updateArticle, team(), { slug: article.slug, title: "Themes", publish: true, revision: onNewest });
    expect(await statusOf(three.id)).toBe("APPLIED");
    // So the next one, alone in the changes, isn't taken for a teammate's.
    await landArticleEdit(project.id, article.id, 46, rewrite("Light", "Pick Light or Dark in Settings."));
    expect(await hasTeammateEdit(article.id)).toBe(false);
  });

  test("an approved edit from before edits were revisions: Undo publishes the text readers saw before (plain text too)", async () => {
    const article = await sectioned();
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const revision = await prisma.articleRevision.findFirstOrThrow({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const action = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "ARTICLE_EDIT", articleId: article.id, probability: 0.9, status: "APPLIED", decidedAt: new Date(), payload: { problem: "wrong", undo: { revision: revision.id, live: fromPlainText("Pick Light in Settings."), published: true } } },
    });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await texts(article.id)).published).toBe("Pick Light in Settings.");
  });

  test("a failure after the draft is saved leaves the action applied, so a second click can't make a second draft", async () => {
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Themes", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const action = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title: "Use the dark theme", content: EDITED, body: "Pick Light, Dark or System in Settings." } },
    });
    // The draft is saved; looking it up right after fails.
    vi.spyOn(prisma.article, "findFirstOrThrow").mockRejectedValueOnce(new Error("database blip"));
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("database blip");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Someone already applied or dismissed this");
    expect(await prisma.article.count({ where: { projectId: project.id, title: "Use the dark theme" } })).toBe(1);
    // What it saved is known: Undo deletes the draft.
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect(await prisma.article.count({ where: { projectId: project.id, title: "Use the dark theme", deletedAt: null } })).toBe(0);
  });

  test("a teammate's new article with the same title while this one failed before saving isn't taken for it: still waiting", async () => {
    const teammate = await signUp("Tom Teammate");
    await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
    const asTeammate = { actor: { kind: "user" as const, userId: teammate.id }, projectId: project.id };
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Themes", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const draft = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title: "Use the dark theme", content: EDITED, body: "Pick Light, Dark or System in Settings." } },
    });
    vi.spyOn(prisma.project, "findUniqueOrThrow").mockImplementationOnce((async () => {
      await call(createArticle, asTeammate, { title: "Use the dark theme", body: "Pick Light, Dark or System in Settings." });
      throw new Error("database blip");
    }) as never);
    await expect(call(applyCodeChangeAction, team(), { id: draft.id })).rejects.toThrow("database blip");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("PENDING");
  });

  test("approving several: a new article saved before something after it failed is reported as applied, not to try again", async () => {
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 22, url: "https://github.com/acme/app/pull/22", title: "Themes", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const action = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title: "Use the dark theme", content: EDITED, body: "Pick Light, Dark or System in Settings." } },
    });
    // The draft is saved; pointing the action at it fails.
    vi.spyOn(prisma.codeChangeAction, "update").mockRejectedValueOnce(new Error("database blip"));
    vi.spyOn(log, "error").mockImplementation(() => {});
    expect(await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] })).toEqual({ results: [{ id: action.id, status: "applied" }] });
    expect(await prisma.article.count({ where: { projectId: project.id, title: "Use the dark theme" } })).toBe(1);
  });


  test("Undo a new article: its draft is deleted; refused once it's published", async () => {
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Themes", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const create = (title: string) =>
      prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title, content: EDITED, body: "Pick Light, Dark or System in Settings." } } });
    const first = await create("Use the dark theme");
    const { article: slug } = (await call(applyCodeChangeAction, team(), { id: first.id })) as { article: string };
    await call(undoCodeChangeAction, team(), { id: first.id });
    expect(await prisma.article.count({ where: { projectId: project.id, slug, deletedAt: null } })).toBe(0);

    // Published between Undo's first look and its delete: checked again under the lock, it stays.
    const third = await create("Theme shortcuts");
    const { article: racing } = (await call(applyCodeChangeAction, team(), { id: third.id })) as { article: string };
    const transaction = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
      await call(publishArticle, team(), { slug: racing });
      return transaction(...args);
    }) as typeof prisma.$transaction);
    await expect(call(undoCodeChangeAction, team(), { id: third.id })).rejects.toThrow("The draft was edited or published since: change it in Docs");
    expect(await prisma.article.count({ where: { projectId: project.id, slug: racing, deletedAt: null, publishedAt: { not: null } } })).toBe(1);

    const second = await create("Dark theme tips");
    const { article: other } = (await call(applyCodeChangeAction, team(), { id: second.id })) as { article: string };
    await call(publishArticle, team(), { slug: other });
    await expect(call(undoCodeChangeAction, team(), { id: second.id })).rejects.toThrow();
    expect(await prisma.article.count({ where: { projectId: project.id, slug: other, deletedAt: null } })).toBe(1);
  });

  test("a new article becomes a draft, nothing more, and the action points to it", async () => {
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 21, url: "https://github.com/acme/app/pull/21", title: "Themes", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const action = await prisma.codeChangeAction.create({
      data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9, payload: { title: "Use the dark theme", content: EDITED, body: "Pick Light, Dark or System in Settings." } },
    });
    const result = (await call(applyCodeChangeAction, team(), { id: action.id })) as { article: string };
    const draft = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: result.article }, select: { id: true, title: true, publishedAt: true, body: true } });
    expect(draft).toMatchObject({ title: "Use the dark theme", publishedAt: null, body: "Pick Light, Dark or System in Settings." });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).articleId).toBe(draft.id);
  });
});

describe("the changelog line", () => {
  async function line(text: string) {
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    return prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "CHANGELOG_LINE", probability: 1, payload: { line: text } } });
  }
  const draft = () => prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, collecting: true }, select: { body: true, content: true } });

  test("rewrites the pull request's bullet in the running draft (as the team edited it), still linking to it", async () => {
    await addToRunningDraft(project.id, { repo: "acme/app", number: 29, url: "https://github.com/acme/app/pull/29", title: "Faster search" });
    await addToRunningDraft(project.id, { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme" });
    const action = await line("Dark theme");
    expect(await call(applyCodeChangeAction, team(), { id: action.id, line: "A dark theme, in Settings" })).toMatchObject({ status: "applied", changelog: 1 });
    const { body, content } = await draft();
    expect(body).toBe("Faster search (acme/app#29)\nA dark theme, in Settings");
    expect(content).toMatchObject({
      content: [
        {
          type: "bulletList",
          content: [
            expect.anything(),
            { type: "listItem", content: [{ type: "paragraph", content: [{ text: "A dark theme, in Settings", marks: [{ type: "link", attrs: { href: "https://github.com/acme/app/pull/30" } }] }] }] },
          ],
        },
      ],
    });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).payload).toEqual({
      line: "A dark theme, in Settings",
      edited: true,
      undo: { previous: "Add a dark theme (acme/app#30)", added: null },
    });
    // Undo puts the bullet back as it was, still linking to the pull request.
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await draft()).body).toBe("Faster search (acme/app#29)\nAdd a dark theme (acme/app#30)");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("UNDONE");
  });

  test("Undo is refused once the line's entry is published: edit the entry instead", async () => {
    await addToRunningDraft(project.id, { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme" });
    const action = await line("Dark theme");
    await call(applyCodeChangeAction, team(), { id: action.id });
    await prisma.changelogEntry.updateMany({ where: { projectId: project.id, collecting: true }, data: { publishedAt: new Date(), collecting: false } });
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Its changelog entry is published: edit the entry instead");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
  });

  test("a line whose first try added the pull request to the draft and then failed: it comes out again; approved after, Undo takes it out", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const action = await line("A dark theme");
    // The pull request goes into the draft; writing its line fails.
    const transaction = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction")
      .mockImplementationOnce(((...args: Parameters<typeof transaction>) => transaction(...args)) as typeof prisma.$transaction)
      .mockRejectedValueOnce(new Error("connection reset"));
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("connection reset");
    expect(await prisma.changelogEntryPullRequest.count({ where: { url: "https://github.com/acme/app/pull/30", entry: { projectId: project.id } } })).toBe(0);
    await call(applyCodeChangeAction, team(), { id: action.id });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await draft()).body).toBe("");
    expect(await prisma.changelogEntryPullRequest.count({ where: { url: "https://github.com/acme/app/pull/30", entry: { projectId: project.id } } })).toBe(0);
  });

  test("while a line is being applied, Undo has nothing to go on yet: refused, not marked undone", async () => {
    const action = await line("A dark theme");
    const find = prisma.changelogEntryPullRequest.findFirst.bind(prisma.changelogEntryPullRequest) as (...args: unknown[]) => Promise<unknown>;
    let undoing: Promise<unknown> | undefined;
    // Its first read finds what the bullet said; then it's claimed, and while it writes the line, someone clicks Undo.
    vi.spyOn(prisma.changelogEntryPullRequest, "findFirst")
      .mockImplementationOnce(((...args: unknown[]) => find(...args)) as never)
      .mockImplementationOnce((async (...args: unknown[]) => {
        undoing = call(undoCodeChangeAction, team(), { id: action.id }).catch((error: Error) => error.message);
        await undoing;
        return find(...args);
      }) as never);
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect(await undoing).toBe("There's no record of what it changed: change it by hand");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
    expect((await draft()).body).toBe("A dark theme");
  });

  test("Undo of a line someone rewrote since is refused; one whose entry was deleted puts nothing back", async () => {
    await addToRunningDraft(project.id, { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme" });
    const action = await line("A dark theme");
    await call(applyCodeChangeAction, team(), { id: action.id });
    // A teammate rewrites the bullet (still linking to the pull request).
    const { content } = await draft();
    const rewritten = JSON.parse(JSON.stringify(content).replace("A dark theme", "Dark theme, everywhere"));
    await prisma.changelogEntry.updateMany({ where: { projectId: project.id, collecting: true }, data: { content: rewritten } });
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The changelog line was edited since: change it in the entry instead");
    // The entry is deleted: Undo has nothing to put back, and adds nothing to a draft.
    await prisma.changelogEntry.deleteMany({ where: { projectId: project.id } });
    expect(await call(undoCodeChangeAction, team(), { id: action.id })).toEqual({ id: action.id, status: "undone" });
    expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("a bullet a teammate rewrites while the line is being applied: Undo puts back their words, not the ones from before", async () => {
    await addToRunningDraft(project.id, { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme" });
    const action = await line("A dark theme");
    // After the apply's first look, a teammate rewrites the bullet (still linking to the pull request).
    const find = prisma.changelogEntryPullRequest.findFirst.bind(prisma.changelogEntryPullRequest) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.changelogEntryPullRequest, "findFirst")
      .mockImplementationOnce(((...args: unknown[]) => find(...args)) as never)
      .mockImplementationOnce((async (...args: unknown[]) => {
        const { content } = await draft();
        await prisma.changelogEntry.updateMany({
          where: { projectId: project.id, collecting: true },
          data: { content: JSON.parse(JSON.stringify(content).replace("Add a dark theme (acme/app#30)", "Dark theme, from the team")) },
        });
        return find(...args);
      }) as never);
    await call(applyCodeChangeAction, team(), { id: action.id });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await draft()).body).toBe("Dark theme, from the team");
  });

  test("Undo's changelog step leaves an entry published meanwhile as it is", async () => {
    await addToRunningDraft(project.id, { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", title: "Add a dark theme" });
    await prisma.changelogEntry.updateMany({ where: { projectId: project.id, collecting: true }, data: { publishedAt: new Date(), collecting: false } });
    const before = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id }, select: { body: true } });
    const url = "https://github.com/acme/app/pull/30";
    expect(await undoChangelogLine(project.id, url, { applied: "Add a dark theme (acme/app#30)", previous: "Other words", added: null })).toBe("published");
    expect(await undoChangelogLine(project.id, url, { applied: "Add a dark theme (acme/app#30)", previous: "", added: "entry" })).toBe("published");
    expect(await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id }, select: { body: true } })).toEqual(before);
    expect(await prisma.changelogEntryPullRequest.count({ where: { url, entry: { projectId: project.id } } })).toBe(1);
  });

  test("a pull request the draft doesn't have (it had nothing to do, until Analyse anyway) goes into it with its line", async () => {
    const action = await line("A dark theme");
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await draft()).body).toBe("A dark theme");
    expect(await prisma.changelogEntryPullRequest.count({ where: { url: "https://github.com/acme/app/pull/30", entry: { projectId: project.id } } })).toBe(1);
    // Undo takes out what applying added: the bullet, and the pull request with it.
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect((await draft()).body).toBe("");
    expect(await prisma.changelogEntryPullRequest.count({ where: { url: "https://github.com/acme/app/pull/30", entry: { projectId: project.id } } })).toBe(0);
  });
});
