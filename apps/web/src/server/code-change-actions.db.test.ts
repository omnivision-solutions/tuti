import { type CodeChangeActionKind, type PostStatus, prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyLikelyCodeChanges } from "@/server/code-changes";
import { applyCodeChangeAction, dismissCodeChangeAction, getCodeChange, listCodeChanges } from "@/server/operations/code-changes";
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


  test("a comment to post is needed; the changelog line can't be applied yet; another project's actions aren't found", async () => {
    const { action } = await proposal("MOVES_FORWARD");
    await expect(call(applyCodeChangeAction, team(), { id: action.id })).rejects.toThrow("Write the comment to post first");
    const { change } = await proposal("LINKS");
    const line = await prisma.codeChangeAction.create({ data: { codeChangeId: change.id, kind: "CHANGELOG_LINE", probability: 1 } });
    await expect(call(applyCodeChangeAction, team(), { id: line.id })).rejects.toThrow("can't be applied yet");

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
