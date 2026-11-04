import type { Doc } from "@tuti/content";
import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { autopilotDue, autopilotDueToken, lockProject, scheduleByItself } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake, startWebhookReceiver } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { POST as due } from "@/app/api/autopilot/due/route";
import { publishCodeChangesNow, stopCodeChanges } from "@/server/code-changes";
import { saveAutopilotSettings, setAutopilotSwitch } from "@/server/github";
import { createPost } from "@/server/operations/create";
import { createArticle, publishArticle, unpublishArticle, updateArticle } from "@/server/operations/docs";
import { homeOverview } from "@/server/home";
import { applyCodeChangeAction, dismissCodeChangeAction, getCodeChange, getCodeChangeTarget, listCodeChangeTargets, publishCodeChangeActionNow, runDueAutopilot, stopCodeChangeAction, undoCodeChangeAction } from "@/server/operations/code-changes";
import { call } from "@/server/operations/run";
import { actAs, createProject, failTransaction, landArticleEdit, signUp, type TestUser } from "@/test/helpers";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let number = 0;

// AI on (Autopilot needs it), with local fakes: nothing leaves the machine.
let fakes: { close: () => Promise<void> }[] = [];
beforeAll(async () => {
  const model = await startModelFake();
  const openai = await startOpenAIFake();
  fakes = [model, openai];
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
});
afterAll(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
});

beforeEach(async () => {
  // One database for the file: no scheduled update of another test's is due in this one.
  await prisma.codeChange.deleteMany({});
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  // Article edits and progress updates going out by themselves (off by default until owners are emailed, A5).
  await prisma.project.update({ where: { id: project.id }, data: { autopilotArticleEdits: true, autopilotProgress: true } });
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const HOUR = 3_600_000;
const EDITED = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Pick Light, Dark or System in Settings." }] }] };

async function change() {
  number++;
  return prisma.codeChange.create({
    data: { projectId: project.id, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: "Dark theme", author: "octo", mergedAt: new Date(), state: "READY" },
  });
}

/** An update for a new post (or the given kind without one), as an analysis saves it. */
async function update(kind: CodeChangeActionKind, { probability = 0.97, comment = "Weekly repeats are out." } = {}) {
  const { id: codeChangeId } = await change();
  const post = kind === "RESOLVES" || kind === "MOVES_FORWARD" || kind === "LINKS" ? await call(createPost, team(), { board: "feature-requests", title: `Dark mode ${number}` }) : null;
  const postId = post ? (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).id : null;
  const payload = kind === "MOVES_FORWARD" ? { comment } : kind === "NEW_ARTICLE" ? { title: `Use the dark theme ${number}`, content: EDITED, body: "Pick Light, Dark or System in Settings." } : kind === "CHANGELOG_LINE" ? { line: "Dark theme" } : {};
  const action = await prisma.codeChangeAction.create({ data: { codeChangeId, kind, postId, probability, payload } });
  return { codeChangeId, action, postId };
}

/** A published article (or `article`) and a pull request's edit to it, saved into its unpublished changes. */
async function articleEdit(probability = 0.97, article?: { id: string; slug: string }) {
  if (!article) {
    const created = await call(createArticle, team(), { title: `Change the theme ${number}`, body: "Pick Light in Settings." });
    await call(publishArticle, team(), { slug: created.slug });
    article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true, slug: true } });
  }
  const action = await landArticleEdit(project.id, article.id, ++number, () => EDITED as Doc, { probability });
  return { codeChangeId: action.codeChangeId, action, article };
}

const statusOf = (id: string) => prisma.codeChangeAction.findUniqueOrThrow({ where: { id }, select: { status: true, dueAt: true, waitReason: true, decidedById: true, payload: true } });

test("scheduled when it's saved: drafts at once, edits and progress updates after the hold; the rest waits for the team", async () => {
  const before = Date.now();
  const draft = await update("NEW_ARTICLE");
  const progress = await update("MOVES_FORWARD");
  const edit = await articleEdit();
  const closes = await update("RESOLVES");
  const unsure = await update("MOVES_FORWARD", { probability: 0.9 });
  const unwritten = await update("MOVES_FORWARD", { comment: "" });
  for (const { codeChangeId } of [draft, progress, edit, closes, unsure, unwritten]) {
    await scheduleByItself(project.id, codeChangeId!);
  }
  for (const atOnce of [draft]) {
    const { status, dueAt } = await statusOf(atOnce.action.id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeLessThan(before + HOUR);
  }
  for (const held of [progress, edit]) {
    const { status, dueAt } = await statusOf(held.action.id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR);
  }
  // Completing posts asks first by default; below the bar, or with nothing to post, it waits too.
  for (const waits of [closes, unsure, unwritten]) {
    expect((await statusOf(waits.action.id)).status).toBe("PENDING");
  }
  // Completing on, the request goes out too; a post that reaches too many people doesn't.
  await prisma.project.update({ where: { id: project.id }, data: { autopilotComplete: true, autopilotMaxReach: 2 } });
  const ok = await update("RESOLVES");
  await scheduleByItself(project.id, ok.codeChangeId);
  expect((await statusOf(ok.action.id)).status).toBe("SCHEDULED");
  const popular = await update("RESOLVES");
  const voter = await signUp("Vera Voter");
  await prisma.vote.create({ data: { projectId: project.id, postId: popular.postId!, userId: voter.id } });
  await scheduleByItself(project.id, popular.codeChangeId);
  expect((await statusOf(popular.action.id)).status).toBe("PENDING");
  // Its review says how many follow it now (its author and voters), which moves with them; the stored reason doesn't.
  const reach = async () => (await call(getCodeChangeTarget, team(), { type: "feedback", id: popular.postId! })).reach;
  expect(await reach()).toBe(2);
  await prisma.vote.create({ data: { projectId: project.id, postId: popular.postId!, userId: (await signUp("Val Voter")).id } });
  expect(await reach()).toBe(3);
  // Not sure of it either: the reason said is the one the review can show, how many it reaches.
  const unsurePopular = await update("RESOLVES", { probability: 0.5 });
  await prisma.vote.create({ data: { projectId: project.id, postId: unsurePopular.postId!, userId: voter.id } });
  await scheduleByItself(project.id, unsurePopular.codeChangeId);
  expect(await statusOf(unsurePopular.action.id)).toMatchObject({ status: "PENDING", waitReason: "Its post reaches 2 people or more" });
  // Its subscribers count too (its shipped email goes to them): one is enough here, with its author.
  const followed = await update("RESOLVES");
  const follower = await signUp("Fay Follower");
  await prisma.postSubscription.create({ data: { postId: followed.postId!, userId: follower.id } });
  await scheduleByItself(project.id, followed.codeChangeId);
  expect((await statusOf(followed.action.id)).status).toBe("PENDING");
});

test("when due, checked again and applied as Autopilot's own; held back, with why, when it no longer qualifies", async () => {
  const progress = await update("MOVES_FORWARD");
  const edit = await articleEdit();
  const changed = await articleEdit();
  const later = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [progress, edit, changed, later]) {
    await scheduleByItself(project.id, codeChangeId!);
  }
  // A teammate edited the article meanwhile (unpublished): it never goes out by itself with that.
  await call(updateArticle, team(), { slug: changed.article.slug, title: "Change the theme, our way" });
  // Due now: progress, edit, changed; `later` an hour after the others.
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [progress.action.id, edit.action.id, changed.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 2, waiting: 1 });

  const done = await statusOf(progress.action.id);
  expect(done).toMatchObject({ status: "APPLIED", decidedById: null, payload: expect.objectContaining({ auto: true }) });
  expect(await prisma.comment.findMany({ where: { postId: progress.postId! }, select: { body: true, authorId: true } })).toEqual([{ body: "Weekly repeats are out.", authorId: owner.id }]);
  expect(await prisma.article.findUniqueOrThrow({ where: { id: edit.article.id }, select: { body: true } })).toEqual({ body: "Pick Light, Dark or System in Settings." });
  expect(await statusOf(changed.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Its article has a teammate's unpublished edit" });
  expect((await statusOf(later.action.id)).status).toBe("SCHEDULED");
  // Its owner is told it went (Autopilot's email); not about the edit held back.
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: progress.codeChangeId, userId: owner.id } })).toBe(1);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: changed.codeChangeId! } })).toBe(0);
  // The page says it was Autopilot's own.
  const detail = await call(getCodeChange, team(), { id: progress.codeChangeId });
  expect(detail.actions[0]).toMatchObject({ status: "applied", auto: true, decidedBy: "Autopilot" });
  // Once: a second run does nothing.
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
});

test("held back at its time when it fell below the bar, or the switch went off", async () => {
  const a = await update("MOVES_FORWARD");
  const b = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [a, b]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [a.action.id, b.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  await prisma.project.update({ where: { id: project.id }, data: { autopilotMinSure: 99 } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 2 });
  expect(await statusOf(a.action.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 99% sure" });
});

test("a changelog line the previous release scheduled is written into the draft when due, whatever the switches; not where its entry is published", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { autopilotDrafts: false } });
  const line = await update("CHANGELOG_LINE");
  const held = await update("CHANGELOG_LINE");
  const due = { status: "SCHEDULED" as const, dueAt: new Date(Date.now() - 1000) };
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [line.action.id, held.action.id] } }, data: due });
  const { url } = await prisma.codeChange.findUniqueOrThrow({ where: { id: held.codeChangeId } });
  await prisma.changelogEntry.create({
    data: { projectId: project.id, number: 90, title: "1.0", publishedAt: new Date(), pullRequests: { create: { url, repo: "acme/app", number: 1, title: "Dark theme" } } },
  });
  expect(await runDueAutopilot()).toEqual({ applied: 1, waiting: 1 });
  expect(await statusOf(line.action.id)).toMatchObject({ status: "APPLIED" });
  const { url: written } = await prisma.codeChange.findUniqueOrThrow({ where: { id: line.codeChangeId } });
  const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, pullRequests: { some: { url: written } } }, select: { body: true, publishedAt: true } });
  expect(entry).toMatchObject({ publishedAt: null });
  expect(entry.body).toContain("Dark theme");
  expect(await statusOf(held.action.id)).toMatchObject({ status: "PENDING", waitReason: "Its changelog entry is published" });
});

test("an edit that can't go live because the project publishes more articles than its plan allows waits, saying so; once there's room it goes", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  // The file's AI fakes stay stubbed: only these go back.
  onTestFinished(() => {
    vi.stubEnv("PLANS", "");
    vi.stubEnv("ARTICLE_LIMIT_FREE", "");
  });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const edit = await articleEdit();
  const other = await call(createArticle, team(), { title: "Another article", body: "Hello." });
  await call(publishArticle, team(), { slug: other.slug });
  await scheduleByItself(project.id, edit.codeChangeId!);
  // Scheduled before the downgrade; due after it.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  await prisma.codeChangeAction.update({ where: { id: edit.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });

  const why = "Your plan publishes up to 1 article. Unpublish some, or upgrade to Pro.";
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await statusOf(edit.action.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: "Its project published more articles than its plan allowed" });
  expect(await prisma.article.findUniqueOrThrow({ where: { id: edit.article.id }, select: { body: true } })).toEqual({ body: "Pick Light in Settings." });
  // Not tried again by itself, even as another edit lands on its article: neither goes on the schedule while it can't go
  // live. The team's Approve says the way out until there's room.
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
  const next = await landArticleEdit(project.id, edit.article.id, ++number, (doc) => doc, { probability: 0.97 });
  await scheduleByItself(project.id, next.codeChangeId!);
  expect(await statusOf(edit.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Its project published more articles than its plan allowed" });
  expect(await statusOf(next.id)).toMatchObject({ status: "PENDING", dueAt: null });
  await expect(call(applyCodeChangeAction, team(), { id: edit.action.id })).rejects.toMatchObject({ status: 402, message: why });
  await prisma.article.updateMany({ where: { id: { not: edit.article.id }, projectId: project.id }, data: { publishedAt: null } });
  expect(await call(applyCodeChangeAction, team(), { id: edit.action.id })).toMatchObject({ status: "applied" });
});

test("an edit waiting for the plan's published articles, once there's room, says what holds it now when an unsure edit lands on its article", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  onTestFinished(() => {
    vi.stubEnv("PLANS", "");
    vi.stubEnv("ARTICLE_LIMIT_FREE", "");
  });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO", autopilotMinSure: 80 } });
  const first = await articleEdit();
  const other = await call(createArticle, team(), { title: "Another article", body: "Hello." });
  await call(publishArticle, team(), { slug: other.slug });
  await scheduleByItself(project.id, first.codeChangeId!);
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect((await statusOf(first.action.id)).waitReason).toBe("Its project published more articles than its plan allowed");

  // Room made, then an edit it isn't sure of lands on the article: that one holds the first back now.
  await call(unpublishArticle, team(), { slug: other.slug });
  const unsure = await landArticleEdit(project.id, first.article.id, ++number, (doc) => doc, { probability: 0.7 });
  await scheduleByItself(project.id, unsure.codeChangeId!);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
  expect(await statusOf(unsure.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 80% sure" });
});

test("Publish now past the plan's published articles: the edit waits, saying so; Home's other updates still go, and it says which didn't", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  onTestFinished(() => {
    vi.stubEnv("PLANS", "");
    vi.stubEnv("ARTICLE_LIMIT_FREE", "");
  });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const edit = await articleEdit();
  await call(publishArticle, team(), { slug: (await call(createArticle, team(), { title: "Another article", body: "Hello." })).slug });
  const progress = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [edit, progress]) {
    await scheduleByItself(project.id, codeChangeId!);
  }
  // Scheduled before the downgrade.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  const why = "Your plan publishes up to 1 article. Unpublish some, or upgrade to Pro.";
  const waits = { status: "PENDING", dueAt: null, decidedById: null, waitReason: "Its project published more articles than its plan allowed" };

  // On its own: refused, and it waits for the team saying why (not looking stopped, not on the schedule).
  expect(await publishCodeChangesNow(project.slug, [edit.action.id])).toEqual({ error: why });
  expect(await statusOf(edit.action.id)).toMatchObject(waits);

  // With another update (Home's Publish now for both): that one goes, and the edit waits, said so.
  await prisma.codeChangeAction.update({ where: { id: edit.action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR), waitReason: null } });
  expect(await publishCodeChangesNow(project.slug, [edit.action.id, progress.action.id])).toEqual({ error: `An article edit waits; 1 other update went out now. ${why}` });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "APPLIED" });
  expect(await statusOf(edit.action.id)).toMatchObject(waits);

  // Others skipped as no longer scheduled, one stopped and one that went out by itself meanwhile: it says only what this
  // click published, never that the rest didn't go.
  const [went, stopped, gone] = [await update("MOVES_FORWARD"), await update("MOVES_FORWARD"), await update("MOVES_FORWARD")];
  for (const { codeChangeId } of [went, stopped, gone]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.update({ where: { id: edit.action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR), waitReason: null } });
  await stopCodeChanges(project.slug, [stopped.action.id]);
  await prisma.codeChangeAction.update({ where: { id: gone.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 1, waiting: 0 });
  expect(await publishCodeChangesNow(project.slug, [edit.action.id, went.action.id, stopped.action.id, gone.action.id])).toEqual({
    error: `An article edit waits; 1 other update went out now. ${why}`,
  });
  expect(await statusOf(gone.action.id)).toMatchObject({ status: "APPLIED" });
});

test("Publish now on an article's two scheduled edits past the plan's published articles: both wait, saying why, and it's told the limit", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  onTestFinished(() => {
    vi.stubEnv("PLANS", "");
    vi.stubEnv("ARTICLE_LIMIT_FREE", "");
  });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const first = await articleEdit();
  const second = await landArticleEdit(project.id, first.article.id, ++number, (doc) => doc, { probability: 0.97 });
  await call(publishArticle, team(), { slug: (await call(createArticle, team(), { title: "Another article", body: "Hello." })).slug });
  for (const codeChangeId of [first.codeChangeId, second.codeChangeId]) {
    await scheduleByItself(project.id, codeChangeId!);
  }
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  expect((await statusOf(second.id)).status).toBe("SCHEDULED");

  // The article's review page sends both.
  const why = "Your plan publishes up to 1 article. Unpublish some, or upgrade to Pro.";
  expect(await publishCodeChangesNow(project.slug, [first.action.id, second.id])).toEqual({ error: `2 article edits wait. ${why}` });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: "Its project published more articles than its plan allowed" });
  expect(await statusOf(second.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: "Another edit to its article waits for you" });
});

test("Publish now from Home with an article edit held by one refused earlier past the plan's published articles: the rest go, and it says which waits", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");
  onTestFinished(() => {
    vi.stubEnv("PLANS", "");
    vi.stubEnv("ARTICLE_LIMIT_FREE", "");
  });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const first = await articleEdit();
  const second = await landArticleEdit(project.id, first.article.id, ++number, (doc) => doc, { probability: 0.97 });
  const progress = await update("MOVES_FORWARD");
  await call(publishArticle, team(), { slug: (await call(createArticle, team(), { title: "Another article", body: "Hello." })).slug });
  for (const codeChangeId of [first.codeChangeId, second.codeChangeId, progress.codeChangeId]) {
    await scheduleByItself(project.id, codeChangeId!);
  }
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  // The first edit comes due first: refused for the limit, it waits saying so.
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });

  // Home's Publish now for the second pull request's updates: the post's goes, the edit waits behind the first.
  const held = "Another edit to its article waits for you";
  expect(await publishCodeChangesNow(project.slug, [second.id, progress.action.id])).toEqual({ error: `An article edit waits; 1 other update went out now. ${held}` });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "APPLIED" });
  expect(await statusOf(second.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: held });
});

test("held back when its pull request was analysed again since", async () => {
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  await prisma.codeChange.update({ where: { id: progress.codeChangeId }, data: { state: "NOTHING_TO_DO" } });
  await prisma.codeChangeAction.updateMany({ where: { id: progress.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "PENDING", waitReason: "Its pull request was analysed again" });
});

test("Home's Stop for a change's scheduled updates goes past one that went out meanwhile", async () => {
  const sent = await update("MOVES_FORWARD");
  const later = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [sent, later]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await publishCodeChangesNow(project.slug, [sent.action.id]);
  expect(await stopCodeChanges(project.slug, [sent.action.id, later.action.id])).toEqual({});
  expect((await statusOf(later.action.id)).status).toBe("PENDING");
});

test("Publish now applies a scheduled update at once, by whoever asks; Stop makes one wait for the team", async () => {
  const now = await update("MOVES_FORWARD");
  const stop = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [now, stop]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  expect(await publishCodeChangesNow(project.slug, [now.action.id])).toEqual({});
  expect(await statusOf(now.action.id)).toMatchObject({ status: "APPLIED", decidedById: owner.id });
  const due = (await statusOf(stop.action.id)).dueAt;
  expect(await stopCodeChanges(project.slug, [stop.action.id])).toEqual({});
  // When it would have gone out is kept, for its review to say; Autopilot's list says who stopped it.
  expect(await statusOf(stop.action.id)).toMatchObject({ status: "PENDING", dueAt: due, waitReason: "Stopped by Olive Owner" });
  expect((await call(listCodeChangeTargets, team(), {})).feedback).toContainEqual(expect.objectContaining({ path: `feedback/${stop.postId}`, stopped: "Stopped by Olive Owner" }));
  // The API says it as when it would have gone out, not when it goes out (it doesn't).
  expect((await call(getCodeChange, team(), { id: stop.codeChangeId })).actions[0]).toMatchObject({ dueAt: null, wouldHaveGoneOutAt: due!.toISOString() });
  // Not scheduled any more: refused, saying why.
  expect(await stopCodeChanges(project.slug, [stop.action.id])).toEqual({ error: "It isn't scheduled any more: it went out, or someone stopped it" });
  // The runner has nothing to do with either.
  await prisma.codeChangeAction.updateMany({ where: { id: stop.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
});

test("the worker's minute reaches the runner only with the server's token", async () => {
  const request = (token?: string) => new Request("http://tuti.localhost/api/autopilot/due", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect((await due(request())).status).toBe(401);
  expect((await due(request("not-it"))).status).toBe(401);
  const response = await due(request(autopilotDueToken()!));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ applied: 0, waiting: 0, emailed: 0 });
});

test("Autopilot's settings: owners flip each switch on its own, and save the three limits and the hold, within reason", async () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(values)) {
      data.set(name, value);
    }
    return data;
  };
  const saved = () =>
    prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { autopilotDrafts: true, autopilotArticleEdits: true, autopilotProgress: true, autopilotComplete: true, autopilotMinSure: true, autopilotMaxReach: true, autopilotMaxViews: true, autopilotHoldHours: true },
    });
  const switches = await saved();
  expect(await setAutopilotSwitch(project.slug, "complete", !switches.autopilotComplete)).toEqual({});
  expect(await setAutopilotSwitch(project.slug, "drafts", !switches.autopilotDrafts)).toEqual({});
  // A name that isn't a switch saves nothing.
  expect(await setAutopilotSwitch(project.slug, "autopilotHoldHours" as "drafts", true)).toEqual({ error: "No such setting" });
  // Save leaves the switches as they are: an unticked one isn't sent, and isn't turned off.
  expect(await saveAutopilotSettings(project.slug, {}, form({ minSure: "90", maxReach: "30", maxViews: "400", holdHours: "12" }))).toEqual({});
  expect(await saved()).toEqual({
    autopilotDrafts: !switches.autopilotDrafts,
    autopilotArticleEdits: switches.autopilotArticleEdits,
    autopilotProgress: switches.autopilotProgress,
    autopilotComplete: !switches.autopilotComplete,
    autopilotMinSure: 90,
    autopilotMaxReach: 30,
    autopilotMaxViews: 400,
    autopilotHoldHours: 12,
  });
  expect(await saveAutopilotSettings(project.slug, {}, form({ minSure: "40", maxReach: "30", maxViews: "400", holdHours: "12" }))).toEqual({
    error: "How sure is 50 to 100%, people and views at least 1, and the hold 0 to 336 hours (two weeks)",
  });
  // A hold left out, or blank, isn't no hold: refused, not saved as 0.
  for (const holdHours of [undefined, " "]) {
    expect(await saveAutopilotSettings(project.slug, {}, form({ minSure: "90", maxReach: "30", maxViews: "400", ...(holdHours !== undefined && { holdHours }) }))).toMatchObject({
      error: expect.stringContaining("the hold 0 to 336 hours"),
    });
  }
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).autopilotHoldHours).toBe(12);
});

test("a request that goes out by itself says how many people completing it emails, as one waiting does", async () => {
  const { codeChangeId, action } = await update("RESOLVES");
  await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR) } });
  // Its author (not the team) asked for it: one person.
  const reader = await signUp("Rae Reader");
  await prisma.post.update({ where: { id: action.postId! }, data: { authorId: reader.id } });
  expect((await call(getCodeChange, team(), { id: codeChangeId })).actions.find((a) => a.id === action.id)).toMatchObject({ status: "scheduled", emails: 1 });
});

test("held back at its time, it's told about (code_change.ready); one a teammate stopped meanwhile keeps who stopped it", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  const receiver = await startWebhookReceiver();
  try {
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    const a = await update("MOVES_FORWARD");
    const b = await update("MOVES_FORWARD");
    for (const { codeChangeId } of [a, b]) {
      await scheduleByItself(project.id, codeChangeId);
    }
    await prisma.codeChangeAction.updateMany({ where: { id: { in: [a.action.id, b.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
    await prisma.project.update({ where: { id: project.id }, data: { autopilotMinSure: 99 } });
    // As the runner reads what's due, a teammate stops b.
    const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
      const due = await findMany(...args);
      await call(stopCodeChangeAction, team(), { id: b.action.id });
      return due;
    }) as never);
    expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
    expect(await statusOf(a.action.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 99% sure" });
    expect(await statusOf(b.action.id)).toMatchObject({ status: "PENDING", waitReason: "Stopped by Olive Owner" });
    // a's change is told about: one update waits there now.
    await vi.waitFor(() => expect(receiver.received).toHaveLength(1));
    expect(JSON.parse(receiver.received[0]!.body)).toMatchObject({ type: "code_change.ready", data: { codeChange: { id: a.codeChangeId, waiting: 1 } } });
  } finally {
    await receiver.close();
  }
});

test("Home's Publish now says how many people a request it completes emails", async () => {
  const { action } = await update("RESOLVES");
  await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR) } });
  const reader = await signUp("Rae Reader");
  await prisma.post.update({ where: { id: action.postId! }, data: { authorId: reader.id } });
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.attention.find((group) => group.key === "autopilot")?.items[0]?.scheduled).toMatchObject({ ids: [action.id], emails: 1, posts: 1 });
});

test("Home's Publish now, on a row per post as To review lists them: each counts its own post once, and its people", async () => {
  const { codeChangeId, action, postId } = await update("RESOLVES");
  const other = await call(createPost, team(), { board: "feature-requests", title: "Export CSV" });
  const otherId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: other.number } })).id;
  // Two posts, the first one twice.
  const more = await Promise.all(
    [otherId, postId!].map((id) => prisma.codeChangeAction.create({ data: { codeChangeId, kind: "RESOLVES", postId: id, probability: 0.97 } })),
  );
  const ids = [action.id, ...more.map((m) => m.id)];
  await prisma.codeChangeAction.updateMany({ where: { id: { in: ids } }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR) } });
  for (const [name, id] of [["Rae Reader", postId!], ["Otto Other", otherId]] as const) {
    const reader = await signUp(name);
    await prisma.post.update({ where: { id }, data: { authorId: reader.id } });
  }
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  const rows = home.attention.find((group) => group.key === "autopilot")!.items;
  // The first post, completed twice: one row, both its updates, its people once.
  expect(rows.find((item) => item.scheduled?.ids.includes(action.id))?.scheduled).toMatchObject({ ids: expect.arrayContaining([action.id, more[1]!.id]), emails: 1, posts: 1 });
  expect(rows.find((item) => item.scheduled?.ids.includes(more[0]!.id))?.scheduled).toMatchObject({ ids: [more[0]!.id], emails: 1, posts: 1 });
});

test("an update Autopilot applied by itself without a record of what it changed has no Undo (only a link it made is just a link)", async () => {
  const { codeChangeId, action } = await update("RESOLVES");
  await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", decidedAt: new Date(), payload: { auto: true } } });
  expect((await call(getCodeChange, team(), { id: codeChangeId })).actions.find((a) => a.id === action.id)).toMatchObject({ canUndo: false });
  await expect(call(undoCodeChangeAction, team(), { id: action.id })).rejects.toThrow("There's no record of what it changed");
});

test("due, its comment failing and the check for it too: it stays applied, credited to nobody, and the page says to check it", async () => {
  const progress = await update("MOVES_FORWARD");
  // Already in progress: posting the comment is all it does.
  await prisma.post.update({ where: { id: progress.postId! }, data: { status: "IN_PROGRESS" } });
  await scheduleByItself(project.id, progress.codeChangeId);
  await prisma.codeChangeAction.update({ where: { id: progress.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  failTransaction(new Error("Connection lost"), { skip: 1 });
  vi.spyOn(prisma.comment, "findFirst").mockRejectedValueOnce(new Error("Connection lost"));
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "APPLIED", decidedById: null });
  const detail = await call(getCodeChange, team(), { id: progress.codeChangeId });
  expect(detail.actions[0]).toMatchObject({ status: "applied", unsure: true, auto: false, decidedBy: null });
});

test("stopped, then an approval that fails: still stopped by who stopped it, so analysing again doesn't schedule it", async () => {
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  await call(stopCodeChangeAction, team(), { id: progress.action.id });
  // A teammate approves it and moving the post fails, before anything's saved.
  failTransaction(new Error("Connection lost"), { skip: 1 });
  await expect(call(applyCodeChangeAction, team(), { id: progress.action.id })).rejects.toThrow("Connection lost");
  // Back to waiting, still stopped (what keeps an analysis from replacing and scheduling it again).
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "PENDING", decidedById: owner.id, waitReason: "Stopped by Olive Owner" });
});

/**
 * Runs `before` as the apply starts (its first read of the update), between taking it off the schedule and
 * the apply; `skip`: reads of it before that one (Publish now's own).
 */
function asApplyStarts(before: () => Promise<unknown>, skip = 0) {
  const findFirst = prisma.codeChangeAction.findFirst.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  const spy = vi.spyOn(prisma.codeChangeAction, "findFirst").mockImplementation((async (...args: unknown[]) => {
    if (reads++ === skip) {
      spy.mockRestore();
      await before();
    }
    return findFirst(...args);
  }) as never);
}

test("analysed again while the runner applies a due update: the update it took is left alone, and goes out", async () => {
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  await prisma.codeChangeAction.update({ where: { id: progress.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // What an analysis saved at that moment replaces (finish in @tuti/jobs): what nobody has decided.
  asApplyStarts(() =>
    prisma.codeChangeAction.deleteMany({
      where: { codeChangeId: progress.codeChangeId, OR: [{ status: { in: ["STALE", "SCHEDULED"] } }, { status: "PENDING", decidedById: null }] },
    }),
  );
  expect(await runDueAutopilot()).toEqual({ applied: 1, waiting: 0 });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "APPLIED", decidedById: null, payload: expect.objectContaining({ auto: true }) });
});

test("an article's due edit doesn't go out by itself while another edit on it is out of date (it would publish that one too)", async () => {
  const due = await articleEdit();
  const stale = await articleEdit(0.97, due.article);
  await prisma.codeChangeAction.update({ where: { id: due.action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() - 1000) } });
  await prisma.codeChangeAction.update({ where: { id: stale.action.id }, data: { status: "STALE", dueAt: null } });
  await runDueAutopilot();
  expect(await statusOf(due.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
});

test("an article's sure edit isn't scheduled to go out by itself while an out-of-date one is in its changes", async () => {
  const stale = await articleEdit();
  await prisma.codeChangeAction.update({ where: { id: stale.action.id }, data: { status: "STALE" } });
  const sure = await landArticleEdit(project.id, stale.article.id, 900, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Themes apply at once." }] }] }), { probability: 0.97 });
  await scheduleByItself(project.id, sure.codeChangeId!);
  expect(await statusOf(sure.id)).toMatchObject({ status: "PENDING", dueAt: null });
});

test("an article's edits go out together: another landing restarts the hold for both; an unsure one on top keeps both waiting", async () => {
  const before = Date.now();
  const first = await articleEdit();
  await scheduleByItself(project.id, first.codeChangeId!);
  // Its hold nearly over…
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(before - 1000) } });
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  for (const edit of [first, second]) {
    const { status, dueAt } = await statusOf(edit.action.id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR);
  }
  // A third it isn't sure of: none goes by itself, each saying why.
  const unsure = await articleEdit(0.5, first.article);
  await scheduleByItself(project.id, unsure.codeChangeId!);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Another edit to its article waits for you" });
  expect(await statusOf(unsure.action.id)).toMatchObject({ status: "PENDING", dueAt: null });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
});

test("Publish now never publishes a teammate's unpublished edit with an article's edits: refused, to review on its page", async () => {
  const edit = await articleEdit();
  await scheduleByItself(project.id, edit.codeChangeId!);
  await call(updateArticle, team(), { slug: edit.article.slug, title: "Change the theme, our way" });
  expect(await publishCodeChangesNow(project.slug, [edit.action.id])).toEqual({
    error: "Its article has a teammate's unpublished edit: review it on its page to publish them together",
  });
  expect((await prisma.article.findUniqueOrThrow({ where: { id: edit.article.id }, select: { title: true } })).title).not.toBe("Change the theme, our way");
});

test("dismissing the edit that held an article's others back: they go out by themselves again", async () => {
  const sure = await articleEdit();
  await scheduleByItself(project.id, sure.codeChangeId!);
  const unsure = await articleEdit(0.5, sure.article);
  await scheduleByItself(project.id, unsure.codeChangeId!);
  expect(await statusOf(sure.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
  await call(dismissCodeChangeAction, team(), { id: unsure.action.id });
  expect(await statusOf(sure.action.id)).toMatchObject({ status: "SCHEDULED", waitReason: null });
});

test("a post's part whose apply failed keeps saying why when an unsure part lands beside it", async () => {
  const failed = await update("MOVES_FORWARD");
  await prisma.codeChangeAction.update({ where: { id: failed.action.id }, data: { status: "PENDING", waitReason: "Couldn't post its comment" } });
  const unsure = await partOf(failed.postId!, "MOVES_FORWARD", { probability: 0.5 });
  await scheduleByItself(project.id, unsure.codeChangeId);
  expect(await statusOf(failed.action.id)).toMatchObject({ status: "PENDING", waitReason: "Couldn't post its comment" });
  expect(await statusOf(unsure.action.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 95% sure" });
});

test("an article's edit whose publish failed keeps saying why when an out-of-date edit holds the others back", async () => {
  const failed = await articleEdit();
  await prisma.codeChangeAction.update({ where: { id: failed.action.id }, data: { status: "PENDING", waitReason: "Couldn't publish its article" } });
  const outdated = await articleEdit(0.97, failed.article);
  await prisma.codeChangeAction.update({ where: { id: outdated.action.id }, data: { status: "STALE" } });
  const landing = await articleEdit(0.97, failed.article);
  await scheduleByItself(project.id, landing.codeChangeId!);
  expect(await statusOf(failed.action.id)).toMatchObject({ status: "PENDING", waitReason: "Couldn't publish its article" });
  expect(await statusOf(landing.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
});

test("a post's part whose old reason no longer holds says what holds it now when an unsure part lands beside it", async () => {
  const first = await update("MOVES_FORWARD");
  // It waited for its post's reach, before the team raised the limit.
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { status: "PENDING", waitReason: "Its post reaches 100 people or more" } });
  const unsure = await partOf(first.postId!, "MOVES_FORWARD", { probability: 0.5 });
  await scheduleByItself(project.id, unsure.codeChangeId);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another part of its update waits for you" });
  expect(await statusOf(unsure.action.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 95% sure" });
});

test("an article's out-of-date edit holds the others back, each waiting one still saying its own why", async () => {
  const sure = await articleEdit();
  const unsure = await articleEdit(0.5, sure.article);
  const outdated = await articleEdit(0.97, sure.article);
  await prisma.codeChangeAction.update({ where: { id: outdated.action.id }, data: { status: "STALE" } });
  await scheduleByItself(project.id, unsure.codeChangeId!);
  expect(await statusOf(sure.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
  expect(await statusOf(unsure.action.id)).toMatchObject({ status: "PENDING", waitReason: "Less than 95% sure" });
});

test("dismissing the edit that held one back while another is already going out: it joins that one, at its time", async () => {
  const going = await articleEdit();
  const held = await articleEdit(0.97, going.article);
  const unsure = await articleEdit(0.5, going.article);
  // One already going out soon, one the runner parked for the unsure one.
  const soon = new Date(Date.now() + 60_000);
  await prisma.codeChangeAction.update({ where: { id: going.action.id }, data: { status: "SCHEDULED", dueAt: soon } });
  await prisma.codeChangeAction.update({ where: { id: held.action.id }, data: { status: "PENDING", dueAt: null, waitReason: "Another edit to its article waits for you" } });
  await call(dismissCodeChangeAction, team(), { id: unsure.action.id });
  expect(await statusOf(held.action.id)).toMatchObject({ status: "SCHEDULED", dueAt: soon, waitReason: null });
  expect(await statusOf(going.action.id)).toMatchObject({ status: "SCHEDULED", dueAt: soon });
});

test("the page's Dismiss takes every edit out, the one a first dismiss scheduled again too", async () => {
  const sure = await articleEdit();
  await scheduleByItself(project.id, sure.codeChangeId!);
  const unsure = await articleEdit(0.5, sure.article);
  await scheduleByItself(project.id, unsure.codeChangeId!);
  // Newest first, as the page does: dismissing the unsure one schedules the sure one again…
  await call(dismissCodeChangeAction, team(), { id: unsure.action.id });
  expect((await statusOf(sure.action.id)).status).toBe("SCHEDULED");
  // …which is still dismissed, and its text comes out.
  await call(dismissCodeChangeAction, team(), { id: sure.action.id });
  expect((await statusOf(sure.action.id)).status).toBe("DISMISSED");
  expect(await prisma.articleChanges.count({ where: { articleId: sure.article.id } })).toBe(0);
});

test("an article's edit due while another lands: the runner's hold on it isn't a Stop, and both go out together after a fresh hold", async () => {
  const first = await articleEdit();
  await scheduleByItself(project.id, first.codeChangeId!);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  let second: Awaited<ReturnType<typeof articleEdit>> | undefined;
  // As the runner applies the first, another pull request's edit lands on the article and is scheduled.
  asApplyStarts(async () => {
    second = await articleEdit(0.97, first.article);
    await scheduleByItself(project.id, second.codeChangeId!);
  });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
  for (const edit of [first, second!]) {
    const { status, dueAt } = await statusOf(edit.action.id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
  }
});

test("dismissing an edit that held nothing back leaves the others' time as it was (the hold restarts only as an edit lands)", async () => {
  const first = await articleEdit();
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  const soon = new Date(Date.now() + 60_000);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: soon } });
  // A teammate stops the second, then dismisses it.
  await call(stopCodeChangeAction, team(), { id: second.action.id });
  await call(dismissCodeChangeAction, team(), { id: second.action.id });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "SCHEDULED", dueAt: soon });
});

test("rescheduling after a dismiss reads Autopilot's settings under the project's lock, never before it", async () => {
  const sure = await articleEdit();
  await scheduleByItself(project.id, sure.codeChangeId!);
  const unsure = await articleEdit(0.5, sure.article);
  await scheduleByItself(project.id, unsure.codeChangeId!);
  // Outside the transaction, a switch turned off between the read and the lock would be missed.
  const outside = vi.spyOn(prisma.project, "findUniqueOrThrow");
  await call(dismissCodeChangeAction, team(), { id: unsure.action.id });
  expect(outside.mock.calls.filter(([query]) => JSON.stringify(query).includes("autopilotHoldHours"))).toEqual([]);
  expect((await statusOf(sure.action.id)).status).toBe("SCHEDULED");
});

test("a Stop landing as the runner publishes an article's edit holds it: nothing goes out (issue #506)", async () => {
  const first = await articleEdit();
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // Past the runner's check, as it applies the first, a teammate stops the second.
  asApplyStarts(() => call(stopCodeChangeAction, team(), { id: second.action.id }));
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", decidedById: null, waitReason: "Another edit to its article waits for you" });
  expect((await statusOf(second.action.id)).waitReason).toMatch(/^Stopped by/);
  expect((await prisma.article.findUniqueOrThrow({ where: { id: first.article.id }, select: { body: true } })).body).toBe("Pick Light in Settings.");
});

test("a Stop waits for the project's lock: one arriving while an article's publish holds it finds the edit gone out (issue #506)", async () => {
  const first = await articleEdit();
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  let stop: Promise<string> | undefined;
  await prisma.$transaction(async (tx) => {
    // As a publish does: the lock, then its edits settled.
    await lockProject(tx, project.id);
    stop = call(stopCodeChangeAction, team(), { id: second.action.id }).then(
      () => "stopped",
      (error: { code?: string }) => error.code ?? "failed",
    );
    // Until Postgres shows a session waiting on this transaction (the Stop), or it's done (it didn't wait); bounded.
    let done = false;
    void stop.then(() => (done = true));
    const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    for (const deadline = Date.now() + 10_000; !done && Date.now() < deadline; ) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if (waiting > 0) {
        break;
      }
    }
    await tx.codeChangeAction.updateMany({ where: { id: { in: [first.action.id, second.action.id] } }, data: { status: "APPLIED", dueAt: null } });
  });
  expect(await stop).toBe("not_scheduled");
  expect((await statusOf(second.action.id)).status).toBe("APPLIED");
});

test("two of an article's edits going out at once (the runner, and a Publish now) don't hold each other back", async () => {
  const first = await articleEdit();
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  // The runner holds the second as it applies it (claimed: waiting, with the owner)…
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { status: "PENDING", dueAt: null, decidedById: owner.id } });
  // …as a teammate publishes the first now: it goes, with the second.
  expect(await publishCodeChangesNow(project.slug, [first.action.id])).toEqual({});
  expect([(await statusOf(first.action.id)).status, (await statusOf(second.action.id)).status]).toEqual(["APPLIED", "APPLIED"]);
});

test("stopping one of an article's edits keeps the others from going out with it", async () => {
  const first = await articleEdit();
  const second = await articleEdit(0.97, first.article);
  await scheduleByItself(project.id, second.codeChangeId!);
  expect((await statusOf(first.action.id)).status).toBe("SCHEDULED");
  await call(stopCodeChangeAction, team(), { id: first.action.id });
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await statusOf(second.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another edit to its article waits for you" });
  expect((await prisma.article.findUniqueOrThrow({ where: { id: first.article.id }, select: { body: true } })).body).toBe("Pick Light in Settings.");
});

test("a due article edit whose article changed as it was applied: out of date, saying why, and told about", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  const receiver = await startWebhookReceiver();
  try {
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    const edit = await articleEdit();
    await scheduleByItself(project.id, edit.codeChangeId!);
    await prisma.codeChangeAction.update({ where: { id: edit.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    asApplyStarts(() => call(updateArticle, team(), { slug: edit.article.slug, title: "Change the theme, our way" }));
    expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
    // Checked again by the schedule's rules: the teammate's edit holds it, saying so.
    expect(await statusOf(edit.action.id)).toMatchObject({
      status: "PENDING",
      decidedById: null,
      waitReason: "Its article has a teammate's unpublished edit",
    });
    await vi.waitFor(() => expect(receiver.received).toHaveLength(1));
  } finally {
    await receiver.close();
  }
});

test("a worker without the web app's address says so only while an update is due", async () => {
  const appUrl = process.env.APP_URL ?? "";
  vi.stubEnv("APP_URL", "");
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  // Nothing scheduled (Autopilot off, or nothing sure enough): nothing to say each minute.
  expect(await autopilotDue()).toEqual({ skipped: true });
  expect(logged).not.toHaveBeenCalled();
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  await prisma.codeChangeAction.update({ where: { id: progress.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await autopilotDue()).toEqual({ skipped: true });
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("set APP_URL and BETTER_AUTH_SECRET on the worker"));
  vi.stubEnv("APP_URL", appUrl);
  logged.mockRestore();
});

test("Publish now with an analysis saved at that moment: the update it took is applied, not replaced and scheduled again", async () => {
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  asApplyStarts(() =>
    prisma.codeChangeAction.deleteMany({
      where: { codeChangeId: progress.codeChangeId, OR: [{ status: { in: ["STALE", "SCHEDULED"] } }, { status: "PENDING", decidedById: null }] },
    }),
    1,
  );
  expect(await publishCodeChangesNow(project.slug, [progress.action.id])).toEqual({});
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "APPLIED", decidedById: owner.id });
});

test("a Publish now that fails leaves the update waiting for anyone, not looking stopped", async () => {
  const progress = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, progress.codeChangeId);
  // Moving the post fails, before anything's saved.
  failTransaction(new Error("Connection lost"), { skip: 1 });
  await expect(publishCodeChangesNow(project.slug, [progress.action.id])).rejects.toThrow("Connection lost");
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "PENDING", decidedById: null });
});

test("an update that went out by itself is told to its owner at once, even if the next due one fails", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 2000) } });
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // Taking the second off the schedule fails (a database error), after the first went out.
  const updateMany = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.codeChangeAction, "updateMany").mockImplementation((async (...args: unknown[]) => {
    const { where } = args[0] as { where: { id?: string; status?: string } };
    if (where.id === second.action.id && where.status === "SCHEDULED") {
      throw new Error("database blip");
    }
    return updateMany(...args);
  }) as never);
  await expect(runDueAutopilot()).rejects.toThrow("database blip");
  spy.mockRestore();
  expect((await statusOf(first.action.id)).status).toBe("APPLIED");
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: first.codeChangeId, userId: owner.id } })).toBe(1);
});

/** Another pull request's part of the post's update (docs/plan.md, V4). */
async function partOf(postId: string, kind: CodeChangeActionKind, { probability = 0.97, comment = "Monthly ones too." } = {}) {
  const { id: codeChangeId } = await change();
  const action = await prisma.codeChangeAction.create({ data: { codeChangeId, kind, postId, probability, payload: kind === "MOVES_FORWARD" ? { comment } : {} } });
  return { codeChangeId, action, postId };
}

test("a post's update goes out together: another part landing restarts the hold for both; an unsure one keeps both waiting", async () => {
  const before = Date.now();
  const first = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, first.codeChangeId);
  // Its hold nearly over…
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(before - 1000) } });
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  await scheduleByItself(project.id, second.codeChangeId);
  for (const part of [first, second]) {
    const { status, dueAt } = await statusOf(part.action.id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR);
  }
  // A third it isn't sure of: none goes by itself, each saying why.
  const unsure = await partOf(first.postId!, "MOVES_FORWARD", { probability: 0.5 });
  await scheduleByItself(project.id, unsure.codeChangeId);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" });
  // The unsure one says its own why, which the post's card shows (it lists no parts to point "another part" at).
  expect(await statusOf(unsure.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Less than 95% sure" });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });

  // Dismissed, the others go out by themselves again: due, as one comment, Autopilot's own.
  await call(dismissCodeChangeAction, team(), { id: unsure.action.id });
  expect((await statusOf(second.action.id)).status).toBe("SCHEDULED");
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [first.action.id, second.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 2, waiting: 0 });
  const comments = await prisma.comment.findMany({ where: { postId: first.postId! }, select: { body: true } });
  expect(comments).toEqual([{ body: "Weekly repeats are out.\nMonthly ones too." }]);
  for (const part of [first, second]) {
    expect(await statusOf(part.action.id)).toMatchObject({ status: "APPLIED", decidedById: null, payload: expect.objectContaining({ auto: true }) });
  }
});

test("a post's part due while another one waits for someone (not checked yet) doesn't go out by itself", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  await scheduleByItself(project.id, first.codeChangeId);
  await scheduleByItself(project.id, second.codeChangeId);
  // The second waits for someone (a Stop stops the whole update: this is one nobody checked, not sure enough).
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { status: "PENDING", dueAt: null, probability: 0.5 } });
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another part of its update waits for you" });
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
});

test("Stop on one part of a post's update stops all of it; Publish now never sends a part a teammate stopped or nobody checked", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await call(stopCodeChangeAction, team(), { id: second.action.id });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: expect.any(Date), waitReason: "Stopped by Olive Owner" });
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("It isn't scheduled any more");

  // One going out beside a part nobody checked (waiting): Publish now leaves both as they are.
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() + HOUR), decidedById: null, waitReason: null } });
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { decidedById: null, waitReason: null } });
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("Another part of its post's update waits for you");
  expect((await statusOf(first.action.id)).status).toBe("SCHEDULED");
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
});

test("due, a post's update goes out as the parts the runner checked: one landing meanwhile holds it, checked by the schedule's rules", async () => {
  const first = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, first.codeChangeId);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // Right after the runner reads the post's update, a part it isn't sure of lands. (Spies other tests left go first.)
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  let landed: Awaited<ReturnType<typeof partOf>> | null = null;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    if ((args[0] as { where?: { postId?: unknown } }).where?.postId && !landed) {
      spy.mockRestore();
      landed = await partOf(first.postId!, "MOVES_FORWARD", { probability: 0.5 });
    }
    return read;
  }) as never);
  vi.spyOn(log, "error").mockImplementation(() => {});
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", waitReason: "Another part of its update waits for you" });
  expect((await statusOf(landed!.action.id)).status).toBe("PENDING");
  vi.restoreAllMocks();
});

test("a teammate's Stop landing after the runner checked a post's update and took its part, before the apply claims the rest: nothing goes out, all of it waits", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [first.action.id, second.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  // The runner reads the post's update (both going out) and takes the first off the schedule; as the apply reads it
  // (its second read of the parts), a teammate stops the second.
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    // The apply's read: once the runner holds the first (taken off the schedule, as the owner's).
    if ((args[0] as { where?: { postId?: unknown } }).where?.postId && (await statusOf(first.action.id)).status === "PENDING") {
      spy.mockRestore();
      await call(stopCodeChangeAction, team(), { id: second.action.id });
    }
    return read;
  }) as never);
  vi.spyOn(log, "error").mockImplementation(() => {});
  await runDueAutopilot();
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
  expect(await statusOf(second.action.id)).toMatchObject({ status: "PENDING", waitReason: "Stopped by Olive Owner" });
  // Back under the schedule's rules: it waits, with why.
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: "Another part of its update waits for you" });
  vi.restoreAllMocks();
});

test("due, a post's part whose update has a part that stopped qualifying: all of it waits, each part saying its own why", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  // Before it's due, the second stops qualifying (it's less sure now, as an analysis' fix to its record would leave it).
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { probability: 0.5 } });
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 2 });
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" });
  expect(await statusOf(second.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Less than 95% sure" });
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
});

test("Publish now's claim on one part of a post's update, landing as the runner checks another due part: the runner leaves the update to it", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // As the runner reads what's due, Publish now takes the first off the schedule (its claim: waiting, held as the
  // teammate's, with no Stop's words), on its way to applying the update.
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
    const due = await findMany(...args);
    await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { status: "PENDING", dueAt: null, decidedById: owner.id } });
    return due;
  }) as never);
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 0 });
  // The claim is left as it was, and the second still going out with it…
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", decidedById: owner.id, waitReason: null });
  expect((await statusOf(second.action.id)).status).toBe("SCHEDULED");
  // …so Publish now's apply sends all of it, once.
  await call(applyCodeChangeAction, team(), { id: first.action.id });
  expect(await prisma.comment.findMany({ where: { postId: first.postId! }, select: { body: true } })).toEqual([{ body: "Weekly repeats are out.\nMonthly ones too." }]);
  vi.restoreAllMocks();
});

test("due, a post's update whose apply fails: all of it waits, the failed part saying why, not put back on a fresh hold by the rest due with it", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  // Already in progress: posting the comment is all it does.
  await prisma.post.update({ where: { id: first.postId! }, data: { status: "IN_PROGRESS" } });
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 2000) } });
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  // Posting the comment fails (after the claim), and nothing was saved.
  vi.spyOn(log, "error").mockImplementation(() => {});
  failTransaction(new Error("Connection lost"), { skip: 1 });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 2 });
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", dueAt: null, decidedById: null, waitReason: "Couldn't apply it" });
  expect(await statusOf(second.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" });
  vi.restoreAllMocks();
});

test("due, a post's part dismissed as the runner applies it: the rest of its update goes on as it was", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  const later = new Date(Date.now() + HOUR);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  await prisma.codeChangeAction.update({ where: { id: second.action.id }, data: { dueAt: later } });
  // Right after the runner takes the first off the schedule, a teammate dismisses it: its apply is refused.
  vi.restoreAllMocks();
  const updateMany = prisma.codeChangeAction.updateMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma.codeChangeAction, "updateMany").mockImplementationOnce((async (...args: unknown[]) => {
    const claimed = await updateMany(...args);
    await call(dismissCodeChangeAction, team(), { id: first.action.id });
    return claimed;
  }) as never);
  vi.spyOn(log, "error").mockImplementation(() => {});
  await runDueAutopilot();
  expect((await statusOf(first.action.id)).status).toBe("DISMISSED");
  expect(await statusOf(second.action.id)).toMatchObject({ status: "SCHEDULED", waitReason: null });
  vi.restoreAllMocks();
});

test("Publish now refused because its post's update changed as it went (a part landed while it held it): all of it back under the schedule's rules", async () => {
  const first = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, first.codeChangeId);
  // As the apply reads the update (after Publish now took the first off the schedule), another pull request's part
  // lands, as an analysis saves it: the update being applied is left to Publish now.
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  let landed: Awaited<ReturnType<typeof partOf>> | null = null;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    if ((args[0] as { where?: { postId?: unknown } }).where?.postId && ++reads === 2) {
      spy.mockRestore();
      landed = await partOf(first.postId!, "MOVES_FORWARD");
      await scheduleByItself(project.id, landed.codeChangeId);
      expect((await statusOf(landed.action.id)).status).toBe("PENDING");
    }
    return read;
  }) as never);
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("The post's update changed since you reviewed it");
  // Not stuck waiting with nobody to send it: both qualify, so both go out by themselves together.
  for (const id of [first.action.id, landed!.action.id]) {
    expect(await statusOf(id)).toMatchObject({ status: "SCHEDULED", decidedById: null });
  }
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
  vi.restoreAllMocks();
});

test("Publish now refused because a part landed while it held the update: the hold restarts for all of it, as when any part lands", async () => {
  const before = Date.now();
  const first = await update("MOVES_FORWARD");
  await scheduleByItself(project.id, first.codeChangeId);
  await prisma.codeChangeAction.update({ where: { id: first.action.id }, data: { dueAt: new Date(Date.now() + HOUR) } });
  // As the apply reads the update, another part lands (as an analysis saves it, left to Publish now's claim).
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  let landed: Awaited<ReturnType<typeof partOf>> | null = null;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    if ((args[0] as { where?: { postId?: unknown } }).where?.postId && ++reads === 2) {
      spy.mockRestore();
      landed = await partOf(first.postId!, "MOVES_FORWARD");
      await scheduleByItself(project.id, landed.codeChangeId);
    }
    return read;
  }) as never);
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("The post's update changed since you reviewed it");
  // A fresh hold for both (the landed part's own hold isn't skipped by going out at the first's old time).
  for (const id of [first.action.id, landed!.action.id]) {
    const { status, dueAt } = await statusOf(id);
    expect(status).toBe("SCHEDULED");
    expect(dueAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR);
  }
  vi.restoreAllMocks();
});

test("Publish now refused because a part went while it held the update (none landed): the rest keeps the time it was going out at", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  const at = new Date(Date.now() + HOUR);
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [first.action.id, second.action.id] } }, data: { dueAt: at } });
  // As the apply reads the update (Publish now holding the first), a teammate dismisses the second.
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    if ((args[0] as { where?: { postId?: unknown } }).where?.postId && (await statusOf(first.action.id)).status === "PENDING") {
      spy.mockRestore();
      await call(dismissCodeChangeAction, team(), { id: second.action.id });
    }
    return read;
  }) as never);
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("The post's update changed since you reviewed it");
  expect(await statusOf(first.action.id)).toMatchObject({ status: "SCHEDULED", dueAt: at });
  vi.restoreAllMocks();
});

test("Publish now on a post's update that fails (nothing went): all of it waits, its part saying why, none of it left going out by itself", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  // Already in progress: posting the comment is all it does.
  await prisma.post.update({ where: { id: first.postId! }, data: { status: "IN_PROGRESS" } });
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  // Posting the comment fails, after the claim, and nothing was saved.
  failTransaction(new Error("Connection lost"), { skip: 1 });
  await expect(call(publishCodeChangeActionNow, team(), { id: first.action.id })).rejects.toThrow("Connection lost");
  expect(await prisma.comment.count({ where: { postId: first.postId! } })).toBe(0);
  expect(await statusOf(first.action.id)).toMatchObject({ status: "PENDING", decidedById: null, waitReason: "Couldn't apply it" });
  expect(await statusOf(second.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" });
  vi.restoreAllMocks();
});

test("due, a post's update goes out as Autopilot's own: only the parts it applied, not one its owner approved by hand meanwhile", async () => {
  const first = await update("MOVES_FORWARD");
  const second = await partOf(first.postId!, "MOVES_FORWARD");
  for (const { codeChangeId } of [first, second]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [first.action.id, second.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  // As the runner went to apply it, the owner approved another of the post's updates by hand (a completion that
  // landed and was applied meanwhile).
  let byHand: Awaited<ReturnType<typeof partOf>> | null = null;
  vi.restoreAllMocks();
  const findMany = prisma.codeChangeAction.findMany.bind(prisma.codeChangeAction) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.codeChangeAction, "findMany").mockImplementation((async (...args: unknown[]) => {
    if ((args[0] as { where?: { status?: unknown } }).where?.status === "APPLIED") {
      spy.mockRestore();
      byHand = await partOf(first.postId!, "RESOLVES");
      await prisma.codeChangeAction.update({ where: { id: byHand.action.id }, data: { status: "APPLIED", decidedById: owner.id, decidedAt: new Date() } });
    }
    return findMany(...args);
  }) as never);
  expect(await runDueAutopilot()).toEqual({ applied: 2, waiting: 0 });
  for (const id of [first.action.id, second.action.id]) {
    expect(await statusOf(id)).toMatchObject({ status: "APPLIED", decidedById: null, payload: expect.objectContaining({ auto: true }) });
  }
  // Theirs stays theirs: approved by them, not marked Autopilot's.
  expect(await statusOf(byHand!.action.id)).toMatchObject({ status: "APPLIED", decidedById: owner.id });
  expect((await statusOf(byHand!.action.id)).payload).not.toHaveProperty("auto");
  vi.restoreAllMocks();
});
