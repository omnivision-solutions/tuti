import { type CodeChangeActionKind, type CodeChangeActionStatus, prisma } from "@tuti/db";
import { postVersion } from "@tuti/jobs";
import { beforeEach, expect, test, vi } from "vitest";

import { homeOverview } from "@/server/home";
import { listMyProjects } from "@/server/membership";
import { getCodeChangeTarget, listCodeChangeTargets, waitingUpdates } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, landArticleEdit, signUp, type TestUser } from "@/test/helpers";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const DAY = 86_400_000;

/** A merged pull request, `days` ago. */
const pullRequest = (number: number, days: number, projectId = project.id) =>
  prisma.codeChange.create({
    data: { projectId, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, author: "octo", mergedAt: new Date(Date.now() - days * DAY), state: "READY", summary: `What ${number} changed` },
  });

const post = async (title: string) => {
  const created = await call(createPost, team(), { board: "feature-requests", title });
  return prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: created.number }, select: { id: true, number: true } });
};

const article = async (title: string) => {
  const created = await call(createArticle, team(), { title, body: "Pick Light in Settings." });
  await call(publishArticle, team(), { slug: created.slug });
  return prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true } });
};

const update = (codeChangeId: string, kind: CodeChangeActionKind, target: { postId?: string; articleId?: string }, status: CodeChangeActionStatus = "PENDING", extra = {}) =>
  prisma.codeChangeAction.create({ data: { codeChangeId, kind, probability: 0.9, status, ...target, ...extra } });

test("Autopilot's list by what it updates: Feedback and Help center, the ones reaching the most first, each with its badge and pull requests", async () => {
  const [one, two, three] = [await pullRequest(1, 30), await pullRequest(2, 2), await pullRequest(3, 1)];
  const quiet = await post("Dark mode");
  // Two voters: it reaches three people with its author.
  const popular = await post("Keyboard shortcuts");
  for (const name of ["Vera Voter", "Val Voter"]) {
    const voter = await signUp(name);
    await prisma.vote.create({ data: { postId: popular.id, userId: voter.id, projectId: project.id } });
  }
  const done = await post("CSV exports");
  const digest = await post("Weekly digest");
  const read = await article("Change the theme");
  await prisma.articleViewDay.create({ data: { articleId: read.id, day: new Date(Date.now() - DAY), views: 5 } });

  const completes = await update(one.id, "RESOLVES", { postId: quiet.id });
  // Approved before: it's waiting that counts, so it's under To review only.
  await update(three.id, "LINKS", { postId: quiet.id }, "APPLIED", { decidedAt: new Date() });
  const goesOut = new Date(Date.now() + DAY);
  const progress = await update(two.id, "MOVES_FORWARD", { postId: popular.id }, "SCHEDULED", { dueAt: goesOut });
  // One article, two pull requests' edits.
  await update(one.id, "ARTICLE_EDIT", { articleId: read.id });
  await update(two.id, "ARTICLE_EDIT", { articleId: read.id });
  // A new article's draft, not written yet: by its update.
  const draft = await update(two.id, "NEW_ARTICLE", {}, "PENDING", { payload: { title: "Use keyboard shortcuts" } });
  // The changelog line is written into the draft by itself: never here, even one the previous release left waiting.
  await update(one.id, "CHANGELOG_LINE", {}, "PENDING", { payload: { line: "A dark theme" } });
  // Decided: one the team dismissed (it does nothing: no badge), one whose progress update went and completion didn't.
  await update(three.id, "RESOLVES", { postId: done.id }, "DISMISSED", { decidedAt: new Date() });
  const minuteAgo = new Date(Date.now() - 60_000);
  await update(three.id, "MOVES_FORWARD", { postId: digest.id }, "APPLIED", { decidedAt: minuteAgo });
  await update(three.id, "RESOLVES", { postId: digest.id }, "UNDONE", { decidedAt: minuteAgo });
  // Another project's: nothing of it.
  const theirs = await createProject(await signUp("Otto Other"));
  await update((await pullRequest(9, 1, theirs.id)).id, "LINKS", {});

  const chip = (change: typeof one) => ({ id: change.id, number: change.number, author: "octo", mergedAt: change.mergedAt.toISOString() });
  const waiting = await call(listCodeChangeTargets, team(), {});
  expect(waiting.feedback).toEqual([
    expect.objectContaining({
      path: `feedback/${popular.id}`,
      section: "feedback",
      title: "Keyboard shortcuts",
      badge: "in_progress",
      reach: 3,
      waiting: 0,
      scheduled: [progress.id],
      nextDueAt: goesOut.toISOString(),
      pullRequests: [expect.objectContaining(chip(two))],
    }),
    expect.objectContaining({
      path: `feedback/${quiet.id}`,
      title: "Dark mode",
      badge: "completing",
      reach: 1,
      waiting: 1,
      nextDueAt: null,
      pullRequests: [expect.objectContaining(chip(one))],
      // What approving it from the list approves.
      likely: [{ id: completes.id, kind: "resolves", emails: 0, revision: postVersion([completes.id]) }],
    }),
  ]);
  expect(waiting.helpCenter).toEqual([
    expect.objectContaining({ path: `articles/${read.id}`, section: "help_center", title: "Change the theme", badge: "updated", reach: 5, waiting: 2, pullRequests: [expect.objectContaining(chip(two)), expect.objectContaining(chip(one))] }),
    expect.objectContaining({ path: `articles/${draft.id}`, title: "Use keyboard shortcuts", badge: "new", reach: 0 }),
  ]);
  // Reviewed: those with nothing waiting, the latest decided first.
  const decided = await call(listCodeChangeTargets, team(), { view: "decided" });
  expect(decided).toEqual({
    feedback: [
      expect.objectContaining({ path: `feedback/${done.id}`, title: "CSV exports", badge: null, pullRequests: [expect.objectContaining(chip(three))] }),
      expect.objectContaining({ path: `feedback/${digest.id}`, title: "Weekly digest", badge: "in_progress" }),
    ],
    helpCenter: [],
  });
});

test("a post's or article's review: every update on it from each pull request, the ones waiting's pull requests, and nothing of another project's", async () => {
  const [one, two] = [await pullRequest(1, 3), await pullRequest(2, 1)];
  const read = await article("Change the theme");
  const first = await update(one.id, "ARTICLE_EDIT", { articleId: read.id });
  const second = await update(two.id, "ARTICLE_EDIT", { articleId: read.id });
  const review = await call(getCodeChangeTarget, team(), { type: "articles", id: read.id });
  expect(review).toMatchObject({ type: "articles", title: "Change the theme", article: { title: "Change the theme" }, post: null });
  expect(review.pullRequests.map((pr) => pr.number)).toEqual([2, 1]);
  expect(review.changes.map((change) => change.summary)).toEqual(["What 2 changed", "What 1 changed"]);
  expect(review.actions.map((action) => [action.id, action.codeChangeId, action.reviewPath]).sort()).toEqual(
    [
      [first.id, one.id, `articles/${read.id}`],
      [second.id, two.id, `articles/${read.id}`],
    ].sort(),
  );

  // Decided, its pull requests are still there (none waits); a new article's draft opens by its update until it's written.
  await prisma.codeChangeAction.updateMany({ where: { id: first.id }, data: { status: "DISMISSED" } });
  expect((await call(getCodeChangeTarget, team(), { type: "articles", id: read.id })).pullRequests.map((pr) => pr.number)).toEqual([2]);
  await prisma.codeChangeAction.updateMany({ where: { id: second.id }, data: { status: "DISMISSED" } });
  expect((await call(getCodeChangeTarget, team(), { type: "articles", id: read.id })).pullRequests.map((pr) => pr.number)).toEqual([2, 1]);
  const draft = await update(two.id, "NEW_ARTICLE", {}, "PENDING", { payload: { title: "Use keyboard shortcuts" } });
  expect(await call(getCodeChangeTarget, team(), { type: "articles", id: draft.id })).toMatchObject({ title: "Use keyboard shortcuts", article: null });

  // Another project's post, or nothing on it: not found.
  const otto = await signUp("Otto Other");
  const theirs = await createProject(otto);
  const theirPost = await prisma.post.create({ data: { projectId: theirs.id, boardId: theirs.boards[0]!.id, authorId: otto.id, number: 1, title: "Theirs", body: "" } });
  await update((await pullRequest(9, 1, theirs.id)).id, "MOVES_FORWARD", { postId: theirPost.id });
  await expect(call(getCodeChangeTarget, team(), { type: "feedback", id: theirPost.id })).rejects.toMatchObject({ status: 404 });
});

test("a changelog line or a link waiting (left by the previous release) isn't counted on Home, in the sidebar or in Autopilot", async () => {
  const one = await pullRequest(1, 1);
  await update(one.id, "CHANGELOG_LINE", {}, "PENDING", { payload: { line: "A dark theme" } });
  // Links Autopilot wasn't sure of: a post with only those isn't to review, and has no review of its own.
  const linked = await post("Reorganise the settings page");
  await update(one.id, "LINKS", { postId: linked.id }, "PENDING", { probability: 0.7 });
  await update((await pullRequest(2, 1)).id, "LINKS", { postId: linked.id }, "PENDING", { probability: 0.66 });
  const counts = async () => {
    const home = await homeOverview(project.id, project.slug, { emailVerified: true });
    const sidebar = (await listMyProjects(owner.id)).find((mine) => mine.slug === project.slug)!;
    return { updates: home.numbers.updatesWaiting, home: home.attention.find((group) => group.key === "autopilot")?.items.length ?? 0, sidebar: sidebar.changesWaiting };
  };
  expect(await counts()).toEqual({ updates: 0, home: 0, sidebar: 0 });
  expect(await call(listCodeChangeTargets, team(), {})).toEqual({ feedback: [], helpCenter: [] });
  expect(await call(listCodeChangeTargets, team(), { view: "decided" })).toEqual({ feedback: [], helpCenter: [] });
  await expect(call(getCodeChangeTarget, team(), { type: "feedback", id: linked.id })).rejects.toMatchObject({ status: 404 });
  expect((await waitingUpdates(project.id, [one.id])).get(one.id)!.updates).toEqual([]);

  // Something else waiting on it: that's counted, and Home's Review opens its activity page.
  const waiting = await post("Dark mode");
  await update(one.id, "MOVES_FORWARD", { postId: waiting.id }, "PENDING", { payload: { comment: "Dark is on its way." } });
  expect(await counts()).toEqual({ updates: 1, home: 1, sidebar: 1 });
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.attention.find((group) => group.key === "autopilot")?.items[0]).toMatchObject({ href: `/app/${project.slug}/autopilot/activity/${one.id}` });
});

test("a post's review with a progress update and links Autopilot wasn't sure of shows only the progress update", async () => {
  const [one, two, three] = [await pullRequest(1, 3), await pullRequest(2, 2), await pullRequest(3, 1)];
  const dark = await post("Dark mode");
  const progress = await update(one.id, "MOVES_FORWARD", { postId: dark.id }, "PENDING", { payload: { comment: "Dark is on its way." } });
  await update(two.id, "LINKS", { postId: dark.id }, "PENDING", { probability: 0.7 });
  await update(three.id, "LINKS", { postId: dark.id }, "PENDING", { probability: 0.66 });
  const review = await call(getCodeChangeTarget, team(), { type: "feedback", id: dark.id });
  expect(review.actions.map((action) => action.id)).toEqual([progress.id]);
  expect(review.pullRequests.map((pr) => pr.number)).toEqual([1]);
  expect(review.update).toMatchObject({ parts: [progress.id], kind: "moves_forward", comment: "Dark is on its way." });
  // In the list, one update waits on it, from one pull request.
  expect((await call(listCodeChangeTargets, team(), {})).feedback).toEqual([expect.objectContaining({ path: `feedback/${dark.id}`, waiting: 1, pullRequests: [expect.objectContaining({ number: 1 })] })]);
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.numbers.updatesWaiting).toBe(1);
});

test("approving an article from the list approves it once (one edit publishes them all), and not with a teammate's edit in it", async () => {
  const read = await article("Change the theme");
  const sure = { probability: 0.97 };
  const first = await landArticleEdit(project.id, read.id, 71, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Dark too." }] }] }), sure);
  await landArticleEdit(project.id, read.id, 72, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "And System." }] }] }), sure);
  const likely = async () => (await call(listCodeChangeTargets, team(), { view: "waiting" })).helpCenter[0]!.likely;
  expect(await likely()).toEqual([{ id: first.id, kind: "article_edit", revision: (await prisma.articleRevision.findFirstOrThrow({ where: { articleId: read.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id }]);
  // One it isn't sure of on it too: approving would publish that one as well, so only its page approves it.
  const unsure = await landArticleEdit(project.id, read.id, 73, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Maybe." }] }] }), { probability: 0.5 });
  expect(await likely()).toEqual([]);
  await prisma.codeChangeAction.update({ where: { id: unsure.id }, data: { status: "DISMISSED" } });
  await prisma.article.update({ where: { id: read.id }, data: { title: "Theme" } });
  await prisma.articleChanges.update({ where: { articleId: read.id }, data: { title: "Change the theme, our way" } });
  expect(await likely()).toEqual([]);
});

test("Activity doesn't offer one pull request's edit to approve while another's it isn't sure of waits on the article (approving would publish both)", async () => {
  const read = await article("Change the theme");
  const sure = await landArticleEdit(project.id, read.id, 77, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Dark too." }] }] }), { probability: 0.97 });
  const likely = async () => (await waitingUpdates(project.id, [sure.codeChangeId!])).get(sure.codeChangeId!)!.likely;
  expect(await likely()).toHaveLength(1);
  await landArticleEdit(project.id, read.id, 78, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Maybe." }] }] }), { probability: 0.5 });
  expect(await likely()).toEqual([]);
});

test("an edit it isn't sure of landing as the list reads an article's version keeps the list from approving it", async () => {
  const read = await article("Change the theme");
  await landArticleEdit(project.id, read.id, 75, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Dark too." }] }] }), { probability: 0.97 });
  // After the list read what waits, before it read the version: the unsure edit is in that version.
  const findFirst = prisma.articleRevision.findFirst.bind(prisma.articleRevision) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(prisma.articleRevision, "findFirst").mockImplementationOnce((async (...args: unknown[]) => {
    await landArticleEdit(project.id, read.id, 76, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Maybe." }] }] }), { probability: 0.5 });
    return findFirst(...args);
  }) as never);
  expect((await call(listCodeChangeTargets, team(), { view: "waiting" })).helpCenter[0]!.likely).toEqual([]);
});

test("the list's Approve is pinned to the version read before checking it for a teammate's edit: one saved after the check makes it do nothing", async () => {
  const read = await article("Change the theme");
  await landArticleEdit(project.id, read.id, 74, (doc) => ({ ...doc, content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text: "Dark too." }] }] }), { probability: 0.97 });
  const before = (await prisma.articleRevision.findFirstOrThrow({ where: { articleId: read.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id;
  const find = prisma.article.findUnique.bind(prisma.article) as (...args: unknown[]) => Promise<unknown>;
  let saved = false;
  vi.spyOn(prisma.article, "findUnique").mockImplementation((async (...args: unknown[]) => {
    const found = await find(...args);
    const query = args[0] as { where?: { id?: string }; select?: { changes?: unknown } };
    if (!saved && query.where?.id === read.id && query.select?.changes) {
      saved = true;
      await prisma.articleChanges.update({ where: { articleId: read.id }, data: { title: "Change the theme, our way" } });
      await prisma.articleRevision.create({ data: { articleId: read.id, title: "Change the theme, our way", body: "", createdAt: new Date() } });
    }
    return found;
  }) as never);
  const [listed] = (await call(listCodeChangeTargets, team(), { view: "waiting" })).helpCenter[0]!.likely;
  vi.restoreAllMocks();
  expect(saved).toBe(true);
  expect(listed).toMatchObject({ revision: before });
});

test("an article's review says when nothing in it shows: an edit the previous release wrote is out of date, and changes saved back to the published text change nothing", async () => {
  const change = await pullRequest(1, 1);
  const read = await article("Change the theme");
  // The previous release's edit: never saved into the article's unpublished changes (no tagged revision).
  const old = await update(change.id, "ARTICLE_EDIT", { articleId: read.id });
  const review = () => call(getCodeChangeTarget, team(), { type: "articles", id: read.id });
  expect(await review()).toMatchObject({ changesReaders: false, outOfDate: [old.id] });
  expect((await review()).actions[0]).toMatchObject({ id: old.id, status: "stale" });
  // Still under To review: it waits for the team to write it again or dismiss it.
  expect((await call(listCodeChangeTargets, team(), {})).helpCenter.map((target) => target.path)).toEqual([`articles/${read.id}`]);

  // An edit saved into its changes shows; once a teammate saves them back to the published text, nothing does.
  await landArticleEdit(project.id, read.id, 2, () => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Pick Light or Dark in Settings." }] }] }));
  expect(await review()).toMatchObject({ changesReaders: true, outOfDate: [old.id] });
  const published = await prisma.article.findUniqueOrThrow({ where: { id: read.id }, select: { title: true, body: true, content: true } });
  await prisma.articleChanges.update({ where: { articleId: read.id }, data: { body: published.body, content: published.content ?? undefined } });
  expect(await review()).toMatchObject({ changesReaders: false });
});
