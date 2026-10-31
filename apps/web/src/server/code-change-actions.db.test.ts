import { type CodeChangeActionKind, type PostStatus, prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { addToRunningDraft, undoChangelogLine } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { approveCodeChanges } from "@/server/code-changes";
import { applyCodeChangeAction, applyCodeChangeActions, codeChangeList, dismissCodeChangeAction, getCodeChange, listCodeChanges, undoCodeChangeAction } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { createArticle, publishArticle, updateArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
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
    expect(await call(getCodeChange, team(), { id: (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).codeChangeId })).toMatchObject({
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
    const detail = await call(getCodeChange, team(), { id: action.codeChangeId });
    expect(detail.actions.find((a) => a.id === action.id)).toMatchObject({ status: "applied", emailed: 1 });
    expect(await call(undoCodeChangeAction, team(), { id: action.id })).toEqual({ id: action.id, status: "undone" });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
    expect(await prisma.changelogEntryPost.count({ where: { entryId: entry.id } })).toBe(0);
    expect((await call(getCodeChange, team(), { id: action.codeChangeId })).actions[0]).toMatchObject({ status: "undone", decidedBy: "Olive Owner" });
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

  test("a try that failed part-way, then approved: Undo puts back what both did (the link and the status the first one moved)", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const { post, action } = await proposal("MOVES_FORWARD", { comment: "Weekly repeats are out." });
    // Linked and moved to In progress, then the comment's transaction fails.
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] })).results[0]).toMatchObject({ status: "failed" });
    expect(await postOf(post.id)).toMatchObject({ status: "IN_PROGRESS", comments: [] });
    await call(applyCodeChangeAction, team(), { id: action.id });
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect(await postOf(post.id)).toEqual({ status: "PLANNED", links: [], comments: [] });
  });

  test("one approved before Undo was there (nothing recorded to put back) is refused, and has no Undo", async () => {
    const { post, action } = await proposal("RESOLVES");
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", decidedById: owner.id, decidedAt: new Date(), payload: {} } });
    expect((await call(getCodeChange, team(), { id: action.codeChangeId })).actions[0]).toMatchObject({ status: "applied", canUndo: false });
    await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("It was approved before Undo was there");
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
    // Saved, then reading who wrote it fails.
    const saved = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Weekly repeats are out." });
    vi.spyOn(prisma.teamMember, "findFirst").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: saved.action.id }] })).results).toEqual([{ id: saved.action.id, status: "applied" }]);
    expect((await postOf(saved.post.id)).comments).toHaveLength(1);
    // Not saved: the comment's transaction fails.
    const lost = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Monthly too." });
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: lost.action.id }] })).results).toEqual([
      { id: lost.action.id, status: "failed", code: "internal", message: "Couldn't apply it. Try again in a moment." },
    ]);
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: lost.action.id } })).status).toBe("PENDING");
    expect((await postOf(lost.post.id)).comments).toHaveLength(0);
    // Not saved, and checking fails too: it stays applied (never posted twice), reported as unknown, not approved.
    const unknown = await proposal("MOVES_FORWARD", { status: "IN_PROGRESS", comment: "Yearly too." });
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(prisma.comment, "count").mockRejectedValueOnce(new Error("connection reset"));
    expect((await call(applyCodeChangeActions, team(), { actions: [{ id: unknown.action.id }] })).results).toEqual([
      { id: unknown.action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" },
    ]);
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

  /** A published article, and a ready code change proposing an edit to it, written against its newest version. */
  async function articleEdit() {
    const created = await call(createArticle, team(), { title: "Change the theme", body: "Pick Light in Settings." });
    await call(publishArticle, team(), { slug: created.slug });
    const article = await prisma.article.findFirstOrThrow({
      where: { projectId: project.id, slug: created.slug },
      select: { id: true, slug: true, revisions: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } } },
    });
    const change = await prisma.codeChange.create({
      data: { projectId: project.id, repoId: 1, repo: "acme/app", number: ++number, url: `https://github.com/acme/app/pull/${number}`, title: "Dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
    });
    const action = await prisma.codeChangeAction.create({
      data: {
        codeChangeId: change.id,
        kind: "ARTICLE_EDIT",
        articleId: article.id,
        probability: 0.9,
        payload: { problem: "wrong", basedOn: article.revisions[0]!.id, title: "Change the theme", content: EDITED, body: "Pick Light, Dark or System in Settings.", before: "Pick Light in Settings." },
      },
    });
    return { article, change, action };
  }
  const published = async (slug: string) =>
    prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { body: true, changes: { select: { body: true } } } });

  test("an article edit: published as a new version, or kept unpublished to finish in the editor", async () => {
    const { article, change, action } = await articleEdit();
    expect(await call(getCodeChange, team(), { id: change.id })).toMatchObject({
      actions: [{ kind: "article_edit", status: "pending", problem: "wrong", before: "Pick Light in Settings.", after: "Pick Light, Dark or System in Settings.", article: { slug: article.slug } }],
    });
    expect(await call(applyCodeChangeAction, team(), { id: action.id })).toMatchObject({ status: "applied", article: article.slug, published: true });
    expect(await published(article.slug)).toEqual({ body: "Pick Light, Dark or System in Settings.", changes: null });

    const later = await articleEdit();
    await call(applyCodeChangeAction, team(), { id: later.action.id, publish: false });
    expect(await published(later.article.slug)).toEqual({ body: "Pick Light in Settings.", changes: { body: "Pick Light, Dark or System in Settings." } });
  });

  test("an article saved since the edit was written makes it out of date: shown so, and not applied", async () => {
    const { article, change, action } = await articleEdit();
    await call(updateArticle, team(), { slug: article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
    expect((await call(getCodeChange, team(), { id: change.id })).actions[0]!.status).toBe("stale");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The article changed since this edit was written");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("STALE");
    expect((await published(article.slug)).body).toBe("Pick Light or Sepia in Settings.");
    // Dismissing it still works.
    await call(dismissCodeChangeAction, team(), { id: action.id });
  });

  test("a save between the out-of-date check and the edit isn't overwritten: the edit is out of date", async () => {
    const { article, action } = await articleEdit();
    // Right as the action is claimed, after the check, someone saves the article.
    const claim = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.codeChangeAction, "updateMany").mockImplementationOnce((async (...args: unknown[]) => {
      await call(updateArticle, team(), { slug: article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
      return claim(...args);
    }) as never);
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The article changed since this edit was written");
    expect((await published(article.slug)).body).toBe("Pick Light or Sepia in Settings.");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("STALE");
  });

  test("two versions saved in the same millisecond: the edit is checked against the one articles.update calls newest", async () => {
    const { article, action } = await articleEdit();
    const newest = await prisma.articleRevision.findFirstOrThrow({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    // Another version at the very same time, sorting before it by id: still not newer.
    await prisma.articleRevision.create({ data: { id: `0${newest.id.slice(1)}`, articleId: article.id, title: newest.title, body: newest.body, createdAt: newest.createdAt } });
    expect((await call(getCodeChange, team(), { id: (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).codeChangeId })).actions[0]!.status).toBe("pending");
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await published(article.slug)).body).toBe("Pick Light, Dark or System in Settings.");
  });

  test("unpublished changes waiting on the article make the edit out of date too (applying would publish them)", async () => {
    const { article, action } = await articleEdit();
    await call(updateArticle, team(), { slug: article.slug, body: "Half-written" });
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The article changed since");
    expect(await published(article.slug)).toEqual({ body: "Pick Light in Settings.", changes: { body: "Half-written" } });
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
  });

  test("a failure before anything is saved (looking up the portal's address) leaves it waiting, to apply again", async () => {
    const { article, action } = await articleEdit();
    // articles.update looks the project up for its portal's address before it saves anything.
    vi.spyOn(prisma.project, "findUniqueOrThrow").mockRejectedValueOnce(new Error("database blip"));
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("database blip");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await published(article.slug)).body).toBe("Pick Light, Dark or System in Settings.");
  });

  test("a teammate's save while this one failed before saving isn't taken for it: still waiting (and now out of date)", async () => {
    const teammate = await signUp("Tom Teammate");
    await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
    const asTeammate = { actor: { kind: "user" as const, userId: teammate.id }, projectId: project.id };
    const { article, action } = await articleEdit();
    // The lookup before saving: meanwhile the teammate saves the article, then the lookup fails.
    vi.spyOn(prisma.project, "findUniqueOrThrow").mockImplementationOnce((async () => {
      await call(updateArticle, asTeammate, { slug: article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
      throw new Error("database blip");
    }) as never);
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("database blip");
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("The article changed since");

    // A new article: the teammate writes one with the same title meanwhile.
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

  test("approving several: an article edit whose save failed and whose check failed too is reported as unknown, not to try again", async () => {
    const { action } = await articleEdit();
    vi.spyOn(log, "error").mockImplementation(() => {});
    // The edit's save fails, and so does the check of whether it was saved.
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(prisma.articleRevision, "count").mockRejectedValueOnce(new Error("connection reset"));
    const { results } = await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] });
    expect(results).toEqual([{ id: action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" }]);
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPLIED");
  });

  test("approving several: refused (the article changed meanwhile), and the check of what was saved failed too: unknown, not the refusal", async () => {
    const { article, action } = await articleEdit();
    vi.spyOn(log, "error").mockImplementation(() => {});
    const claim = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.codeChangeAction, "updateMany").mockImplementationOnce((async (...args: unknown[]) => {
      await call(updateArticle, team(), { slug: article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
      return claim(...args);
    }) as never);
    vi.spyOn(prisma.articleRevision, "count").mockRejectedValueOnce(new Error("connection reset"));
    const { results } = await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] });
    expect(results).toEqual([{ id: action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" }]);
  });

  test("approving several: refused (the article changed meanwhile), then not put back (the database went): unknown, not the refusal", async () => {
    const { article, action } = await articleEdit();
    vi.spyOn(log, "error").mockImplementation(() => {});
    // Right as it's claimed, someone saves the article (so its save is refused as changed)...
    const claim = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.codeChangeAction, "updateMany")
      .mockImplementationOnce((async (...args: unknown[]) => {
        await call(updateArticle, team(), { slug: article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
        return claim(...args);
      }) as never)
      // ...and putting it back fails.
      .mockRejectedValueOnce(new Error("connection reset"));
    const { results } = await call(applyCodeChangeActions, team(), { actions: [{ id: action.id }] });
    expect(results).toEqual([{ id: action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" }]);
  });

  test("Undo an article edit: its previous version is published again; refused once someone edited it since", async () => {
    const { article, action } = await articleEdit();
    await call(applyCodeChangeAction, team(), { id: action.id });
    expect((await published(article.slug)).body).toBe("Pick Light, Dark or System in Settings.");
    await call(undoCodeChangeAction, team(), { id: action.id });
    expect(await published(article.slug)).toEqual({ body: "Pick Light in Settings.", changes: null });
    expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("UNDONE");

    const again = await articleEdit();
    await call(applyCodeChangeAction, team(), { id: again.action.id });
    await call(updateArticle, team(), { slug: again.article.slug, body: "Pick Light, Dark, Sepia or System.", publish: true });
    await expect(call(undoCodeChangeAction, team(), { id: again.action.id })).rejects.toThrow("The article was edited since");
    expect((await published(again.article.slug)).body).toBe("Pick Light, Dark, Sepia or System.");
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

  test("a line whose first try added the pull request to the draft and then failed: Undo still takes the pull request out", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const action = await line("A dark theme");
    // The pull request goes into the draft; writing its line fails.
    const transaction = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction")
      .mockImplementationOnce(((...args: Parameters<typeof transaction>) => transaction(...args)) as typeof prisma.$transaction)
      .mockRejectedValueOnce(new Error("connection reset"));
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("connection reset");
    expect(await prisma.changelogEntryPullRequest.count({ where: { url: "https://github.com/acme/app/pull/30", entry: { projectId: project.id } } })).toBe(1);
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
    expect(await undoing).toBe("It was approved before Undo was there: change it by hand");
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
