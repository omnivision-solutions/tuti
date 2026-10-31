import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { autopilotDue, autopilotDueToken, scheduleByItself } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake, startWebhookReceiver } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as due } from "@/app/api/autopilot/due/route";
import { publishCodeChangesNow, stopCodeChanges } from "@/server/code-changes";
import { saveAutopilotSettings } from "@/server/github";
import { createPost } from "@/server/operations/create";
import { createArticle, publishArticle, updateArticle } from "@/server/operations/docs";
import { homeOverview } from "@/server/home";
import { applyCodeChangeAction, getCodeChange, runDueAutopilot, stopCodeChangeAction, undoCodeChangeAction } from "@/server/operations/code-changes";
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
  // Its owner is told it went (Autopilot's email); not about the edit held back.
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: progress.codeChangeId, userId: owner.id } })).toBe(1);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: changed.codeChangeId } })).toBe(0);
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

test("held back when its pull request was analysed again since, or its changelog line's entry is published", async () => {
  const progress = await update("MOVES_FORWARD");
  const line = await update("CHANGELOG_LINE");
  for (const { codeChangeId } of [progress, line]) {
    await scheduleByItself(project.id, codeChangeId);
  }
  await prisma.codeChange.update({ where: { id: progress.codeChangeId }, data: { state: "NOTHING_TO_DO" } });
  const { url } = await prisma.codeChange.findUniqueOrThrow({ where: { id: line.codeChangeId } });
  await prisma.changelogEntry.create({
    data: { projectId: project.id, number: 1, title: "1.0", publishedAt: new Date(), pullRequests: { create: { url, repo: "acme/app", number: 1, title: "Dark theme" } } },
  });
  await prisma.codeChangeAction.updateMany({ where: { id: { in: [progress.action.id, line.action.id] } }, data: { dueAt: new Date(Date.now() - 1000) } });
  expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 2 });
  expect(await statusOf(progress.action.id)).toMatchObject({ status: "PENDING", waitReason: "Its pull request was analysed again" });
  expect(await statusOf(line.action.id)).toMatchObject({ status: "PENDING", waitReason: "Its changelog entry is published" });
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
  expect(await response.json()).toEqual({ applied: 0, waiting: 0, emailed: 0 });
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
  expect(home.attention.find((item) => item.kind === "Autopilot")?.scheduled).toMatchObject({ ids: [action.id], emails: 1 });
});

test("another project's published entry with the same pull request doesn't hold this project's line back", async () => {
  const line = await update("CHANGELOG_LINE");
  const { url } = await prisma.codeChange.findUniqueOrThrow({ where: { id: line.codeChangeId } });
  const other = await createProject(await signUp("Otto Other"));
  await prisma.changelogEntry.create({
    data: { projectId: other.id, number: 1, title: "1.0", publishedAt: new Date(), pullRequests: { create: { url, repo: "acme/app", number: 1, title: "Dark theme" } } },
  });
  await scheduleByItself(project.id, line.codeChangeId);
  expect(await statusOf(line.action.id)).toMatchObject({ status: "SCHEDULED" });
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
  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Connection lost"));
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
  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Connection lost"));
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

test("a due article edit whose article changed as it was applied: out of date, saying why, and told about", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  const receiver = await startWebhookReceiver();
  try {
    await prisma.webhook.create({ data: { projectId: project.id, url: receiver.url, secret: "whsec_test", events: ["code_change.ready"], createdById: owner.id } });
    const edit = await articleEdit();
    await scheduleByItself(project.id, edit.codeChangeId);
    await prisma.codeChangeAction.update({ where: { id: edit.action.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    asApplyStarts(() => call(updateArticle, team(), { slug: edit.article.slug, body: "Pick Light or Sepia in Settings.", publish: true }));
    expect(await runDueAutopilot()).toEqual({ applied: 0, waiting: 1 });
    expect(await statusOf(edit.action.id)).toMatchObject({
      status: "STALE",
      decidedById: null,
      waitReason: "The article changed since this edit was written. Analyse again to write it again, or dismiss it.",
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
  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Connection lost"));
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
