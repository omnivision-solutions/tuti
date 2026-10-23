import { type CodeChangeActionKind, type PostStatus, prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyLikelyCodeChanges } from "@/server/code-changes";
import { applyCodeChangeAction, dismissCodeChangeAction, getCodeChange, listCodeChanges } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
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

  test("a comment to post is needed; other kinds can't be applied yet; another project's actions aren't found", async () => {
    const { action } = await proposal("MOVES_FORWARD");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Write the comment to post first");
    const { change } = await proposal("LINKS");
    const article = await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "NEW_ARTICLE", probability: 0.9 } });
    await expect(call(applyCodeChangeAction, team(), { id: article.id })).rejects.toThrow("can't be applied yet");

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
});

test('"Apply likely" applies the likely feedback proposals and leaves the maybes, and a comment nobody wrote', async () => {
  // Most likely of all, but with no comment to post: it waits for the team, and doesn't stop the rest.
  const unwritten = await proposal("MOVES_FORWARD", { probability: 0.95 });
  const likely = await proposal("RESOLVES", { probability: 0.9 });
  const maybe = await proposal("LINKS", { probability: 0.7 });
  expect(await applyLikelyCodeChanges(project.slug, likely.change.id)).toEqual({});
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: likely.action.id } })).status).toBe("APPLIED");
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: maybe.action.id } })).status).toBe("PENDING");
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: unwritten.action.id } })).status).toBe("PENDING");
  expect((await call(getCodeChange, team(), { id: likely.change.id })).actions.filter((action) => action.applyLikely)).toEqual([]);
  expect((await postOf(likely.post.id)).status).toBe("COMPLETED");
});
