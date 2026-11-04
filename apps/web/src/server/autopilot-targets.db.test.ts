import { type CodeChangeActionKind, type CodeChangeActionStatus, prisma } from "@tuti/db";
import { postVersion } from "@tuti/jobs";
import { beforeEach, expect, test, vi } from "vitest";

import { homeOverview } from "@/server/home";
import { listMyProjects } from "@/server/membership";
import { editedRange, getCodeChangeTarget, listCodeChangeTargets, waitingUpdates } from "@/server/operations/code-changes";
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

test("Reviewed says what became of each post or article, in the past tense, who decided it and when", async () => {
  const [one, two] = [await pullRequest(1, 3), await pullRequest(2, 2)];
  const done = await post("Week numbers");
  const dropped = await post("Shared team calendars");
  const read = await article("Download invoices");
  const at = new Date(Date.now() - 2 * 60 * 60_000);
  await update(one.id, "RESOLVES", { postId: done.id }, "APPLIED", { decidedById: owner.id, decidedAt: at });
  // A link Autopilot applied by itself doesn't hide the completion the team approved.
  await update(two.id, "LINKS", { postId: done.id }, "APPLIED", { payload: { auto: true }, decidedAt: new Date() });
  await update(one.id, "MOVES_FORWARD", { postId: dropped.id }, "DISMISSED", { decidedById: owner.id, decidedAt: at, payload: { comment: "Soon." } });
  await update(two.id, "ARTICLE_EDIT", { articleId: read.id }, "APPLIED", { payload: { auto: true }, decidedAt: at });

  const { feedback, helpCenter } = await call(listCodeChangeTargets, team(), { view: "decided" });
  const outcomes = Object.fromEntries([...feedback, ...helpCenter].map((target) => [target.title, target.outcome]));
  expect(outcomes).toEqual({
    "Week numbers": { outcome: "completed", line: "Approved by Olive", at: at.toISOString() },
    "Shared team calendars": { outcome: "dismissed", line: "Dismissed by Olive", at: at.toISOString() },
    "Download invoices": { outcome: "published", line: "Published by Autopilot", at: at.toISOString() },
  });
  // One Autopilot couldn't tell went out (going out by itself): said, to check.
  const unsure = await article("Time zones");
  await update(two.id, "ARTICLE_EDIT", { articleId: unsure.id }, "APPLIED", { payload: { unsure: true }, decidedAt: at });
  expect((await call(listCodeChangeTargets, team(), { view: "decided" })).helpCenter.find((target) => target.title === "Time zones")!.outcome).toEqual({
    outcome: "published",
    line: "Couldn't tell whether it went out: check it",
    at: at.toISOString(),
  });
  // What Autopilot published, undone by someone no longer known (their account deleted): not credited to Autopilot.
  await prisma.codeChangeAction.updateMany({ where: { articleId: read.id }, data: { status: "UNDONE", decidedById: null } });
  const undone = await call(getCodeChangeTarget, team(), { type: "articles", id: read.id });
  expect(undone.actions.map((action) => [action.status, action.decidedBy])).toEqual([["undone", null]]);
  // Waiting ones have none.
  await update(two.id, "RESOLVES", { postId: (await post("Dark mode")).id });
  expect((await call(listCodeChangeTargets, team(), {})).feedback.map((target) => target.outcome)).toEqual([null]);
});

test("a published article's Reviewed page compares the version its edits were written on with the newest, by when each was written", async () => {
  const read = await article("Change the theme");
  const [older, newer] = [await pullRequest(1, 3), await pullRequest(2, 1)];
  const a = await update(older.id, "ARTICLE_EDIT", { articleId: read.id }, "APPLIED", { createdAt: new Date(Date.now() - 3 * DAY) });
  const b = await update(newer.id, "ARTICLE_EDIT", { articleId: read.id }, "APPLIED", { createdAt: new Date(Date.now() - DAY) });
  const version = (body: string, extra: object) => prisma.articleRevision.create({ data: { articleId: read.id, title: "Change the theme", body, ...extra } });
  const base = await version("Pick Light.", { createdAt: new Date(Date.now() - 4 * DAY) });
  // The newer pull request's edit was written first; the older one's was written again on top of it.
  const onBase = await version("Pick Light or Dark.", { codeChangeActionId: b.id, basedOnId: base.id, createdAt: new Date(Date.now() - 2 * 60_000) });
  const onTop = await version("Pick Light, Dark or System.", { codeChangeActionId: a.id, basedOnId: onBase.id, createdAt: new Date(Date.now() - 60_000) });
  const updates = [
    { kind: "article_edit", status: "applied", revision: onBase.id, basedOn: base.id },
    { kind: "article_edit", status: "applied", revision: onTop.id, basedOn: onBase.id },
  ];
  expect(await editedRange(read.id, updates)).toMatchObject({ from: { id: base.id, body: "Pick Light." }, to: { id: onTop.id, body: "Pick Light, Dark or System." } });
  // Its versions gone (pruned), nothing to compare.
  expect(await editedRange(read.id, [{ kind: "article_edit", status: "applied", revision: "gone", basedOn: base.id }])).toBeNull();
  expect(await editedRange(read.id, [])).toBeNull();
test("a post's review has what its users asked, who, and its Inbox conversations; each review names the same pull request's other updates still waiting", async () => {
  const [one, two] = [await pullRequest(221, 1), await pullRequest(222, 1)];
  const created = await call(createPost, team(), { board: "feature-requests", title: "Dark mode", body: "The dashboard is too bright at night.\n\nA dark theme would help a lot.\nSo would a dimmer one.\nAnd a schedule." });
  const dark = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: created.number }, select: { id: true } });
  for (const name of ["Ana Abbott", "Ben Castro"]) {
    const voter = await signUp(name);
    await prisma.vote.create({ data: { postId: dark.id, userId: voter.id, projectId: project.id } });
  }
  await prisma.post.update({ where: { id: dark.id }, data: { voteCount: 27 } });
  const conversation = await prisma.conversation.create({ data: { projectId: project.id, number: 7, subject: "Night mode?", origin: "API", lastMessageAt: new Date() } });
  await prisma.conversationPost.create({ data: { conversationId: conversation.id, postId: dark.id } });
  // Spam isn't listed, as on the post's page.
  const spam = await prisma.conversation.create({ data: { projectId: project.id, number: 8, subject: "Cheap watches", origin: "API", lastMessageAt: new Date(), spam: true } });
  await prisma.conversationPost.create({ data: { conversationId: spam.id, postId: dark.id } });
  const read = await article("Change the theme");
  await update(one.id, "RESOLVES", { postId: dark.id });
  await update(one.id, "ARTICLE_EDIT", { articleId: read.id });
  // Another pull request's, and one of #221's already decided: not named.
  await update(two.id, "MOVES_FORWARD", { postId: (await post("Keyboard shortcuts")).id }, "PENDING", { payload: { comment: "Soon." } });
  await update(one.id, "MOVES_FORWARD", { postId: (await post("Week numbers")).id }, "DISMISSED");

  const review = await call(getCodeChangeTarget, team(), { type: "feedback", id: dark.id });
  expect(review.asked).toMatchObject({
    // Its first three lines, then "…".
    excerpt: "The dashboard is too bright at night.\nA dark theme would help a lot.\nSo would a dimmer one.…",
    voteCount: 27,
    conversations: [{ number: 7, subject: "Night mode?" }],
    conversationCount: 1,
  });
  // The first to vote first (its author, who voted as they posted it).
  expect(review.asked!.voters.map((voter) => voter.name)).toEqual(["Olive Owner", "Ana Abbott", "Ben Castro"]);
  expect(review.also).toEqual([{ codeChangeId: one.id, number: 221, path: `articles/${read.id}`, title: "Change the theme", kind: "article_edit" }]);
  expect((await call(getCodeChangeTarget, team(), { type: "articles", id: read.id })).also).toEqual([{ codeChangeId: one.id, number: 221, path: `feedback/${dark.id}`, title: "Dark mode", kind: "resolves" }]);
  // An article's review has no "what they asked".
  expect((await call(getCodeChangeTarget, team(), { type: "articles", id: read.id })).asked).toBeNull();
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
    return { updates: home.numbers.toReview, home: home.attention.find((group) => group.key === "autopilot")?.items.length ?? 0, sidebar: sidebar.changesWaiting };
  };
  expect(await counts()).toEqual({ updates: 0, home: 0, sidebar: 0 });
  expect(await call(listCodeChangeTargets, team(), {})).toEqual({ feedback: [], helpCenter: [] });
  expect(await call(listCodeChangeTargets, team(), { view: "decided" })).toEqual({ feedback: [], helpCenter: [] });
  await expect(call(getCodeChangeTarget, team(), { type: "feedback", id: linked.id })).rejects.toMatchObject({ status: 404 });
  expect((await waitingUpdates(project.id, [one.id])).get(one.id)!.updates).toEqual([]);

  // Something else waiting on it: that's counted, and Home's Review opens the post's review.
  const waiting = await post("Dark mode");
  await update(one.id, "MOVES_FORWARD", { postId: waiting.id }, "PENDING", { payload: { comment: "Dark is on its way." } });
  expect(await counts()).toEqual({ updates: 1, home: 1, sidebar: 1 });
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.attention.find((group) => group.key === "autopilot")?.items[0]).toMatchObject({ href: `/app/${project.slug}/autopilot/feedback/${waiting.id}` });
});

test("one count of what waits: the sidebar, Home's number, Home's rows and To review count posts and articles to review, whatever pull requests or Verify runs are behind them", async () => {
  const [one, two, three] = [await pullRequest(1, 3), await pullRequest(2, 2), await pullRequest(3, 1)];
  // Two pull requests' progress updates on one post (one going out by itself), and one of them also completes another.
  const recurring = await post("Recurring events");
  await update(one.id, "MOVES_FORWARD", { postId: recurring.id }, "PENDING", { payload: { comment: "Weekly repeats are out." } });
  await update(two.id, "MOVES_FORWARD", { postId: recurring.id }, "SCHEDULED", { payload: { comment: "Monthly too." }, dueAt: new Date(Date.now() + DAY) });
  const dark = await post("Dark mode");
  await update(three.id, "RESOLVES", { postId: dark.id });
  // That pull request edits an article, which a Verify run's fix waits on too: one article.
  const read = await article("Change the theme");
  await update(three.id, "ARTICLE_EDIT", { articleId: read.id });
  const run = await prisma.articleVerification.create({ data: { projectId: project.id, articleId: read.id, state: "DONE" } });
  await prisma.codeChangeAction.create({ data: { verificationId: run.id, articleId: read.id, kind: "ARTICLE_EDIT", probability: 1, status: "PENDING" } });
  // A decided one isn't counted, nor one on sample content (listed in To review, labelled Sample; Home leaves it out).
  await update(one.id, "RESOLVES", { postId: (await post("Week numbers")).id }, "APPLIED");
  const sample = await post("Try a sample post");
  await prisma.post.update({ where: { id: sample.id }, data: { sample: true } });
  await update(two.id, "MOVES_FORWARD", { postId: sample.id }, "PENDING", { payload: { comment: "Soon." } });

  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  const sidebar = (await listMyProjects(owner.id)).find((mine) => mine.slug === project.slug)!;
  const toReview = await call(listCodeChangeTargets, team(), {});
  const group = home.attention.find((g) => g.key === "autopilot")!;
  const listed = [...toReview.feedback, ...toReview.helpCenter].filter((target) => !target.sample);
  expect([home.numbers.toReview, group.total, sidebar.changesWaiting, listed.length]).toEqual([3, 3, 3, 3]);
  // Home's rows are To review's, in its order, each opening its review; the post going out partly by itself says so.
  expect(group.items.map((item) => [item.title, item.href])).toEqual([
    ["Recurring events", `/app/${project.slug}/autopilot/feedback/${recurring.id}`],
    ["Dark mode", `/app/${project.slug}/autopilot/feedback/${dark.id}`],
    ["Change the theme", `/app/${project.slug}/autopilot/articles/${read.id}`],
  ]);
  expect(group.items[0]!.scheduled).toMatchObject({ ids: [expect.any(String)], emails: 0, posts: 0 });
  expect(group.items[1]!.scheduled).toBeUndefined();
});

test("Home's Autopilot rows keep To review's order when a sample post leads a board", async () => {
  const [one, two, three] = [await pullRequest(1, 3), await pullRequest(2, 2), await pullRequest(3, 1)];
  const other = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  // On the first board: a sample post reaching three people, and a real one reaching one.
  const sample = await post("Try a sample post");
  for (const name of ["Vera Voter", "Val Voter"]) {
    const voter = await signUp(name);
    await prisma.vote.create({ data: { postId: sample.id, userId: voter.id, projectId: project.id } });
  }
  await prisma.post.update({ where: { id: sample.id }, data: { sample: true } });
  const quiet = await post("Week numbers");
  // On the other board: a real one reaching two.
  const loud = await post("Reminder emails");
  await prisma.post.update({ where: { id: loud.id }, data: { boardId: other.id } });
  await prisma.vote.create({ data: { postId: loud.id, userId: (await signUp("Ana Abbott")).id, projectId: project.id } });
  for (const [change, target] of [[one, sample], [two, quiet], [three, loud]] as const) {
    await update(change.id, "MOVES_FORWARD", { postId: target.id }, "PENDING", { payload: { comment: "Soon." } });
  }
  // To review: the first board (led by the sample post), then Bugs. Home: the same, the sample post left out.
  const home = await homeOverview(project.id, project.slug, { emailVerified: true });
  expect(home.attention.find((group) => group.key === "autopilot")!.items.map((item) => item.title)).toEqual(["Week numbers", "Reminder emails"]);
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
  expect(home.numbers.toReview).toBe(1);
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
