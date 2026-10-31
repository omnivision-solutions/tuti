import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { autopilotDueToken, scheduleByItself } from "@tuti/jobs";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as due } from "@/app/api/autopilot/due/route";
import { publishCodeChangesNow, stopCodeChanges } from "@/server/code-changes";
import { saveAutopilotSettings } from "@/server/github";
import { createPost } from "@/server/operations/create";
import { createArticle, publishArticle, updateArticle } from "@/server/operations/docs";
import { getCodeChange, runDueAutopilot } from "@/server/operations/code-changes";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

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

/** A published article and an edit to it, written against its newest version. */
async function articleEdit(probability = 0.97) {
  const created = await call(createArticle, team(), { title: `Change the theme ${number}`, body: "Pick Light in Settings." });
  await call(publishArticle, team(), { slug: created.slug });
  const article = await prisma.article.findFirstOrThrow({
    where: { projectId: project.id, slug: created.slug },
    select: { id: true, slug: true, revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } } },
  });
  const { id: codeChangeId } = await change();
  const action = await prisma.codeChangeAction.create({
    data: { codeChangeId, kind: "ARTICLE_EDIT", articleId: article.id, probability, payload: { problem: "wrong", basedOn: article.revisions[0]!.id, content: EDITED, body: "Pick Light, Dark or System in Settings.", before: "Pick Light in Settings." } },
  });
  return { codeChangeId, action, article };
}

const statusOf = (id: string) => prisma.codeChangeAction.findUniqueOrThrow({ where: { id }, select: { status: true, dueAt: true, waitReason: true, decidedById: true, payload: true } });

test("scheduled when it's saved: drafts at once, edits and progress updates after the hold; the rest waits for the team", async () => {
  const before = Date.now();
  const line = await update("CHANGELOG_LINE");
  const draft = await update("NEW_ARTICLE");
  const progress = await update("MOVES_FORWARD");
  const edit = await articleEdit();
  const closes = await update("RESOLVES");
  const unsure = await update("MOVES_FORWARD", { probability: 0.9 });
  const unwritten = await update("MOVES_FORWARD", { comment: "" });
  for (const { codeChangeId } of [line, draft, progress, edit, closes, unsure, unwritten]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  for (const atOnce of [line, draft]) {
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
});

test("when due, checked again and applied as Autopilot's own; held back, with why, when it no longer qualifies", async () => {
  const progress = await update("MOVES_FORWARD");
  const edit = await articleEdit();
  const changed = await articleEdit();
  const later = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [progress, edit, changed, later]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  // The article was saved again meanwhile.
  await call(updateArticle, team(), { slug: changed.article.slug, body: "Pick Light or Sepia in Settings.", publish: true });
  // Due now: progress, edit, changed; `later` an hour after the others.
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [progress.action.id, edit.action.id, changed.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 2, waiting: 1 });

  const done = await statusOf(progress.action.id);
  expect(done).toMatchObject({ status: "APPLIED", decidedById: null, payload: expect.objectContaining({ auto: true }) });
  expect(await prisma.comment.findMany({ where: { postId: progress.postId! }, select: { body: true, authorId: true } })).toEqual([{ body: "Weekly repeats are out.", authorId: owner.id }]);
  expect(await prisma.article.findUniqueOrThrow({ where: { id: edit.article.id }, select: { body: true } })).toEqual({ body: "Pick Light, Dark or System in Settings." });
  expect(await statusOf(changed.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Its article changed since" });
  expect((await statusOf(later.action.id)).status).toBe("SCHEDULED");
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

test("Publish now applies a scheduled update at once, by whoever asks; Stop makes one wait for the team", async () => {
  const now = await update("MOVES_FORWARD");
  const stop = await update("MOVES_FORWARD");
  for (const { codeChangeId } of [now, stop]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  expect(await publishCodeChangesNow(project.slug, [now.action.id])).toEqual({});
  expect(await statusOf(now.action.id)).toMatchObject({ status: "APPLIED", decidedById: owner.id });
  expect(await stopCodeChanges(project.slug, [stop.action.id])).toEqual({});
  expect(await statusOf(stop.action.id)).toMatchObject({ status: "PENDING", dueAt: null, waitReason: "Stopped by Olive Owner" });
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
  expect(await response.json()).toEqual({ applied: 0, waiting: 0 });
});

test("Autopilot's settings: owners save the switches, the three limits and the hold, within reason", async () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(values)) {
      data.set(name, value);
    }
    return data;
  };
  expect(await saveAutopilotSettings(project.slug, {}, form({ drafts: "on", complete: "on", minSure: "90", maxReach: "30", maxViews: "400", holdHours: "12" }))).toEqual({});
  expect(
    await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { autopilotDrafts: true, autopilotArticleEdits: true, autopilotProgress: true, autopilotComplete: true, autopilotMinSure: true, autopilotMaxReach: true, autopilotMaxViews: true, autopilotHoldHours: true },
    }),
  ).toEqual({ autopilotDrafts: true, autopilotArticleEdits: false, autopilotProgress: false, autopilotComplete: true, autopilotMinSure: 90, autopilotMaxReach: 30, autopilotMaxViews: 400, autopilotHoldHours: 12 });
  expect(await saveAutopilotSettings(project.slug, {}, form({ minSure: "40", maxReach: "30", maxViews: "400", holdHours: "12" }))).toEqual({
    error: "How sure is 50 to 100%, people and views at least 1, and the hold 0 to 336 hours (two weeks)",
  });
});
