import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { type CodeChangeActionKind, Prisma, prisma } from "@tuti/db";
import { articleLimit, ARTICLES_FULL_WAIT, codeChangesEnabled, log, planIncludes } from "@tuti/shared";

import { hasTeammateEdit, scheduleArticle } from "./article-layers";

/**
 * Autopilot's hold (docs/plan.md, Autopilot A4): what it's sure of goes out by itself, drafts at once
 * and the rest after the project's hold, unless it must wait for someone. Checked when the analysis is
 * saved (scheduleByItself) and again when it's due (the web app's runner).
 */

/** A project's Autopilot settings, as waitsBecause reads them. */
export const autopilotSettingsSelect = {
  plan: true,
  analyseCodeChanges: true,
  autopilotDrafts: true,
  autopilotArticleEdits: true,
  autopilotProgress: true,
  autopilotComplete: true,
  autopilotMinSure: true,
  autopilotMaxReach: true,
  autopilotMaxViews: true,
  autopilotHoldHours: true,
} satisfies Prisma.ProjectSelect;

export type AutopilotSettings = Prisma.ProjectGetPayload<{ select: typeof autopilotSettingsSelect }>;

/** Drafts only the team sees go out at once; the rest wait for the hold. */
const AT_ONCE = new Set<CodeChangeActionKind>(["NEW_ARTICLE"]);

/**
 * What Autopilot's review holds: every update but the changelog line, which the analysis writes into the running
 * draft by itself (it's reviewed there), and a link still waiting. Lines the previous release left waiting are left out
 * too. A link changes nothing customers see: a sure one is applied by itself (`decisions.autoLink`), and an unsure one the
 * previous release left waiting isn't a review item (applied, dismissed or undone ones stay in the history).
 */
export const inReview = {
  kind: { not: "CHANGELOG_LINE" },
  NOT: { kind: "LINKS", status: { in: ["PENDING", "STALE", "SCHEDULED"] } },
} satisfies Prisma.CodeChangeActionWhereInput;

/** How many people a post reaches: its author, voters, commenters and subscribers (whom its shipped email goes to), each once. */
export async function postReach(postId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const [row] = await db.$queryRaw<{ people: bigint }[]>`
    SELECT COUNT(DISTINCT x."userId") AS people FROM (
      SELECT "authorId" AS "userId" FROM post WHERE id = ${postId}
      UNION SELECT "userId" FROM vote WHERE "postId" = ${postId}
      UNION SELECT "authorId" FROM comment WHERE "postId" = ${postId}
      UNION SELECT "userId" FROM post_subscription WHERE "postId" = ${postId}
    ) x`;
  return Number(row?.people ?? 0);
}

/** How often an article was read on the portal in the last 30 days. */
export async function recentViews(articleId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const { _sum } = await db.articleViewDay.aggregate({ where: { articleId, day: { gte: since } }, _sum: { views: true } });
  return _sum.views ?? 0;
}

/** postReach for many posts at once (Autopilot's list puts the ones that reach the most people first), by post id. */
export async function postsReach(postIds: string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<{ postId: string; people: bigint }[]>`
    SELECT x."postId", COUNT(DISTINCT x."userId") AS people FROM (
      SELECT id AS "postId", "authorId" AS "userId" FROM post WHERE id IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "userId" FROM vote WHERE "postId" IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "authorId" FROM comment WHERE "postId" IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "userId" FROM post_subscription WHERE "postId" IN (${Prisma.join(postIds)})
    ) x
    GROUP BY x."postId"`;
  return new Map(rows.map((row) => [row.postId, Number(row.people)]));
}

/** recentViews for many articles at once, by article id. */
export async function articlesViews(articleIds: string[]): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.articleViewDay.groupBy({ by: ["articleId"], where: { articleId: { in: articleIds }, day: { gte: since } }, _sum: { views: true } });
  return new Map(rows.map((row) => [row.articleId, row._sum.views ?? 0]));
}

/**
 * Where an update is reviewed, under `/app/<project>/autopilot/`: its post's page, or its article's (a new article's by
 * the update itself until its draft exists). Null for the changelog line, which isn't reviewed in Autopilot.
 */
export const reviewPath = (action: { id: string; kind: CodeChangeActionKind; postId: string | null; articleId: string | null }): string | null =>
  action.postId ? `feedback/${action.postId}` : action.articleId ? `articles/${action.articleId}` : action.kind === "NEW_ARTICLE" ? `articles/${action.id}` : null;

/** Why a Verify run's fix waits: it always does. */
export const VERIFY_WAITS = "Verify's fixes wait for you";

type Candidate = {
  id: string;
  /** Null: a Verify run's fix. */
  codeChangeId: string | null;
  kind: CodeChangeActionKind;
  probability: number;
  payload: Prisma.JsonValue;
  postId: string | null;
  articleId: string | null;
};

/**
 * Why an update must wait for someone, whatever the hold (null: it may go out by itself): Autopilot is
 * off for it, it's not sure enough, or its post or article reaches too many people, or changed since.
 */
export async function waitsBecause(action: Candidate, project: AutopilotSettings, db: Prisma.TransactionClient = prisma): Promise<string | null> {
  // A Verify fix never goes out by itself (docs/plan.md, V5).
  if (action.codeChangeId === null) {
    return VERIFY_WAITS;
  }
  // A changelog line the previous release scheduled: it goes into the draft whatever the switches (it's reviewed there,
  // and can't wait here: the review leaves it out), only not where its entry is published (readers would see it).
  if (action.kind === "CHANGELOG_LINE") {
    const change = await db.codeChange.findUnique({ where: { id: action.codeChangeId }, select: { url: true, projectId: true } });
    const published = change && (await db.changelogEntryPullRequest.count({ where: { url: change.url, entry: { projectId: change.projectId, publishedAt: { not: null } } } })) > 0;
    return published ? "Its changelog entry is published" : null;
  }
  if (!codeChangesEnabled() || !project.analyseCodeChanges || !planIncludes(project.plan, "codeChanges")) {
    return "Autopilot is off";
  }
  const on: Partial<Record<CodeChangeActionKind, boolean>> = {
    NEW_ARTICLE: project.autopilotDrafts,
    ARTICLE_EDIT: project.autopilotArticleEdits,
    MOVES_FORWARD: project.autopilotProgress,
    RESOLVES: project.autopilotComplete,
  };
  if (!on[action.kind]) {
    return "Autopilot asks first for these";
  }
  const change = await db.codeChange.findUnique({ where: { id: action.codeChangeId }, select: { state: true } });
  if (change?.state !== "READY") {
    return "Its pull request was analysed again";
  }
  const payload = (action.payload ?? {}) as { comment?: string };
  if (action.kind === "MOVES_FORWARD" && !(payload.comment ?? "").trim()) {
    return "No progress update to post";
  }
  // Its post's update's comment, every part's joined: one longer than a comment can be can't be posted as it is.
  if (POST_UPDATE.includes(action.kind) && action.postId) {
    const { comment } = await postUpdate(action.postId, db);
    if (comment.length > POST_COMMENT_MAX) {
      return tooLong(comment);
    }
  }
  if (action.postId) {
    const post = await db.post.findUnique({ where: { id: action.postId }, select: { status: true, duplicateOfId: true } });
    if (!post || post.duplicateOfId || post.status === "COMPLETED" || post.status === "CLOSED") {
      return "Its post changed since";
    }
    if ((await postReach(action.postId, db)) >= project.autopilotMaxReach) {
      return `Its post reaches ${project.autopilotMaxReach} people or more`;
    }
  }
  if (action.kind === "ARTICLE_EDIT" && action.articleId) {
    const article = await db.article.findUnique({ where: { id: action.articleId }, select: { deletedAt: true, publishedAt: true, projectId: true } });
    // One the previous release wrote, as a whole new article (not saved into its changes), is out of date.
    if (!article || article.deletedAt || !article.publishedAt || (await db.articleRevision.count({ where: { codeChangeActionId: action.id } })) === 0) {
      return "Its article changed since";
    }
    if (await hasTeammateEdit(action.articleId, db)) {
      return "Its article has a teammate's unpublished edit";
    }
    // Past the plan's published articles (a downgrade), it can't go live: it waits rather than going on the schedule.
    const limit = articleLimit(project.plan);
    if (limit !== null && (await db.article.count({ where: { projectId: article.projectId, publishedAt: { not: null }, deletedAt: null } })) > limit) {
      return ARTICLES_FULL_WAIT;
    }
    if ((await recentViews(action.articleId, db)) >= project.autopilotMaxViews) {
      return `Its article was read ${project.autopilotMaxViews} times or more in 30 days`;
    }
  }
  // Last: the reasons above are what a review can say (the app never says how sure it is).
  if (action.probability * 100 < project.autopilotMinSure) {
    return `Less than ${project.autopilotMinSure}% sure`;
  }
  return null;
}

/**
 * Whether a stored reason is one this check gives (or what holds an update back), so worked out again each time: not
 * a failed apply's message, which a waiting part keeps. Keep it beside `waitsBecause`'s wordings.
 */
const checksSay = (why: string) =>
  /^(Autopilot is off|Autopilot asks first|Its pull request was analysed again|Less than \d+% sure|No progress update|Its comment is too long|Its post |Its article |Its project |Its changelog entry|Another (part|edit) )/.test(why);

/** When an update that may go out by itself goes: drafts now, the rest after the project's hold. */
export const dueAt = (kind: CodeChangeActionKind, project: AutopilotSettings, now = new Date()) =>
  AT_ONCE.has(kind) ? now : new Date(now.getTime() + project.autopilotHoldHours * 3_600_000);

/** Why a post's update completing it waits after all: its comment went first, and whether it was saved can't be told. */
export const COMMENT_UNSURE = "Couldn't tell whether its comment was posted: check the post before approving";

/** A reason that holds an update for the team until someone decides it, as a Stop does: never scheduled, approved unasked or replaced. */
export const holdsForTeam = (why: string | null | undefined) => Boolean(why?.startsWith("Stopped by") || why === COMMENT_UNSURE);

/**
 * An edit a teammate stopped (Stop says who), or a post's update whose comment may have been posted (held the same
 * way). Not one the runner or Publish now holds while applying it: they claim it the same way (waiting, with whoever
 * applies it), but without those words.
 */
const stopped = (update: { status: string; decidedById: string | null; waitReason: string | null }) =>
  update.status === "PENDING" && update.decidedById !== null && holdsForTeam(update.waitReason);

/**
 * The updates of one article or post (`where`) that go out together: waiting ones go out by themselves together, the
 * hold restarting for all of them, only when every one qualifies (and nobody stopped one, nor `held` says why not);
 * otherwise they all wait for someone, each saying why (`other`: one that would go, held back by another). `keepDue`
 * (one taken out, none landing): those already going out keep their time, and the rest join them. Returns how many
 * are scheduled.
 */
export async function scheduleTogether(
  tx: Prisma.TransactionClient,
  where: Prisma.CodeChangeActionWhereInput,
  project: AutopilotSettings,
  { keepDue = false, held = null, other, leaveClaimed = false }: { keepDue?: boolean; held?: string | null; other: string; leaveClaimed?: boolean },
): Promise<number> {
  const updates = await tx.codeChangeAction.findMany({
    where: { ...where, status: { in: ["PENDING", "SCHEDULED"] } },
    select: { id: true, codeChangeId: true, kind: true, probability: true, payload: true, postId: true, articleId: true, status: true, decidedById: true, waitReason: true, dueAt: true },
  });
  // `leaveClaimed`: one being applied (the runner or Publish now holds it: waiting, with whoever applies it, without a
  // Stop's words) makes all of them theirs; their check under the lock decides, so none is moved meanwhile.
  if (leaveClaimed && updates.some((update) => update.status === "PENDING" && update.decidedById !== null && !stopped(update))) {
    return 0;
  }
  // Each one's own why (`held` holds back those that would otherwise go).
  const reasons = await Promise.all(updates.map((update) => (stopped(update) ? update.waitReason! : waitsBecause(update, project, tx))));
  if (held === null && reasons.every((reason) => reason === null)) {
    await tx.codeChangeAction.updateMany({
      where: { id: { in: updates.map((update) => update.id) } },
      data: { status: "SCHEDULED", dueAt: (keepDue && updates.find((update) => update.status === "SCHEDULED")?.dueAt) || dueAt(updates[0]?.kind ?? "ARTICLE_EDIT", project), waitReason: null, decidedById: null },
    });
    return updates.length;
  }
  for (const [i, update] of updates.entries()) {
    // One that would go by itself says what holds it (one whose apply failed keeps its message; a reason the checks gave
    // before is worked out again); the others say why they wait; a teammate's stop keeps its words.
    if (!stopped(update)) {
      await tx.codeChangeAction.update({
        where: { id: update.id },
        data: { status: "PENDING", dueAt: null, waitReason: reasons[i] ?? (update.status === "PENDING" && update.waitReason && !checksSay(update.waitReason) ? update.waitReason : (held ?? other)) },
      });
    }
  }
  return 0;
}

/** The longest comment a post takes (the app's comments' limit). */
export const POST_COMMENT_MAX = 5000;

/** Why a post's update whose joined comment is longer than that waits: the team shortens it first. */
export const tooLong = (comment: string) =>
  `Its comment is too long to post (${comment.length.toLocaleString("en")} of ${POST_COMMENT_MAX.toLocaleString("en")} characters): shorten it`;

/** A post's status change: completing it, or a progress update. Links aren't one: they're applied by themselves beside it. */
export const POST_UPDATE: CodeChangeActionKind[] = ["RESOLVES", "MOVES_FORWARD"];

/**
 * A post's update waiting (docs/plan.md, V4): one status change with one comment, made of each pull request's part
 * (its update, waiting or going out by itself), the first merged first. It completes the post when a part does (the progress
 * updates' comments folded into it), else it's a progress update. The comment is the parts' joined, a paragraph each;
 * the version, which parts it's made of and which a teammate stopped (what an approval was shown: a part landing,
 * dismissed, analysed again or stopped since changes it).
 */
export async function postUpdate(postId: string, db: Prisma.TransactionClient = prisma) {
  const found = await db.codeChangeAction.findMany({
    where: { postId, kind: { in: POST_UPDATE }, status: { in: ["PENDING", "SCHEDULED"] } },
    // By pull request, the first merged first: one analysed again keeps its place.
    orderBy: [{ codeChange: { mergedAt: "asc" } }, { codeChangeId: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      status: true,
      probability: true,
      payload: true,
      decidedById: true,
      dueAt: true,
      decidedAt: true,
      waitReason: true,
      codeChange: { select: { id: true, repo: true, number: true, url: true, title: true } },
    },
  });
  // A post's parts are pull requests' (only an article edit can be a Verify fix).
  const parts = found.flatMap(({ codeChange, ...part }) => (codeChange ? [{ ...part, codeChange }] : []));
  return {
    parts,
    comment: composeComment(parts),
    completes: parts.some((part) => part.kind === "RESOLVES"),
    // A teammate's Stop changes it too: an approval shown before it does nothing.
    version: postVersion(parts.map((part) => (stopped(part) ? `${part.id}:stopped` : part.id))),
    stopped: parts.some(stopped),
  };
}

/** A post update's comment: its progress updates' comments, a paragraph each. ponytail: a plain join; the writing model if joined ones read badly. */
export const composeComment = (parts: { kind: CodeChangeActionKind; payload: Prisma.JsonValue }[]) =>
  parts
    .flatMap((part) => (part.kind === "MOVES_FORWARD" ? [(((part.payload ?? {}) as { comment?: string }).comment ?? "").trim()] : []))
    .filter(Boolean)
    .join("\n\n");

/** A post update's version: which parts it's made of (whatever their order). */
export const postVersion = (ids: string[]) => createHash("sha256").update(ids.toSorted().join(",")).digest("base64url").slice(0, 16);

/**
 * After a part lands on a post: its update goes out by itself, the hold restarting for every part, only when each
 * qualifies; otherwise all of it waits for someone. Not while someone's applying it (the runner, Publish now): theirs.
 */
export const schedulePost = (tx: Prisma.TransactionClient, postId: string, project: AutopilotSettings, { keepDue = false } = {}) =>
  scheduleTogether(tx, { postId, kind: { in: POST_UPDATE } }, project, { keepDue, other: "Another part of its update waits for you", leaveClaimed: true });

/**
 * After an analysis is saved: each update waiting for the team that may go out by itself is scheduled
 * (drafts at once, the rest after the hold). Returns how many.
 */
export async function scheduleByItself(projectId: string, codeChangeId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: autopilotSettingsSelect });
  if (!project) {
    return 0;
  }
  // Not one the team stopped: that waits for them. Nor an article's edit or a post's update: each goes together (scheduleArticle, schedulePost).
  const waiting = await db.codeChangeAction.findMany({
    where: { codeChangeId, status: "PENDING", decidedById: null, kind: { notIn: ["ARTICLE_EDIT", ...POST_UPDATE] } },
    select: { id: true, codeChangeId: true, kind: true, probability: true, payload: true, postId: true, articleId: true },
  });
  let scheduled = 0;
  for (const action of waiting) {
    if ((await waitsBecause(action, project, db)) === null) {
      // Only while it's still waiting (the team may have decided it meanwhile).
      const { count } = await db.codeChangeAction.updateMany({
        where: { id: action.id, status: "PENDING" },
        data: { status: "SCHEDULED", dueAt: dueAt(action.kind, project), waitReason: null },
      });
      scheduled += count;
    }
  }
  // Its articles' edits, each article's together: the hold restarts for all of them, and only when each qualifies.
  const edits = await db.codeChangeAction.findMany({
    where: { codeChangeId, kind: "ARTICLE_EDIT", status: "PENDING", decidedById: null, revisions: { some: {} } },
    select: { id: true, articleId: true },
  });
  for (const edit of edits) {
    await scheduleArticle(db, edit.articleId!, project);
    scheduled += (await db.codeChangeAction.count({ where: { id: edit.id, status: "SCHEDULED" } }));
  }
  // Its posts' updates, each post's parts together, the same way.
  const parts = await db.codeChangeAction.findMany({
    where: { codeChangeId, kind: { in: POST_UPDATE }, status: "PENDING", decidedById: null, postId: { not: null } },
    select: { id: true, postId: true },
  });
  for (const part of parts) {
    await schedulePost(db, part.postId!, project);
    scheduled += await db.codeChangeAction.count({ where: { id: part.id, status: "SCHEDULED" } });
  }
  return scheduled;
}

/** What the worker sends the web app to run Autopilot's due updates (POST /api/autopilot/due): from the server's secret, never sent anywhere else. */
export function autopilotDueToken(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? createHmac("sha256", secret).update("autopilot-due").digest("hex") : null;
}

/**
 * The worker's minute: asks the web app to apply Autopilot's due updates and send its emails (applying is the web app's:
 * it saves posts, comments and articles as the team does). Nothing to do without the app's address.
 */
export async function autopilotDue(): Promise<{ applied: number; waiting: number; emailed: number } | { skipped: true }> {
  const token = autopilotDueToken();
  if (!process.env.APP_URL || !token) {
    // Said each minute while an update is due, so it's seen: it waits until the worker has both. Nothing due
    // (Autopilot off, or nothing scheduled): nothing to say.
    if ((await prisma.codeChangeAction.count({ where: { status: "SCHEDULED", dueAt: { lte: new Date() } } })) > 0) {
      log.error("Autopilot can't apply its due updates: set APP_URL and BETTER_AUTH_SECRET on the worker (the web app's values)");
    }
    return { skipped: true };
  }
  const response = await fetch(new URL("/api/autopilot/due", process.env.APP_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) {
    throw new Error(`The web app answered ${response.status} to /api/autopilot/due`);
  }
  return (await response.json()) as { applied: number; waiting: number; emailed: number };
}

/** What a button in Autopilot's email does: approve one update, or publish now or stop the scheduled ones it showed (their ids, comma-separated). */
export type AutopilotButton = `approve:${string}` | `publish:${string}` | `stop:${string}`;

/** How long an email's buttons act: a week, then they only open the review page. */
const BUTTON_DAYS = 7;

const signature = (payload: string) => {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? createHmac("sha256", secret).update(`autopilot-act:${payload}`).digest("base64url") : null;
};

/** A button's token: for its recipient, its change and itself, good for a week. Null without the server's secret. */
export function signAutopilotButton(userId: string, codeChangeId: string, button: AutopilotButton, now = new Date()): string | null {
  const payload = Buffer.from(JSON.stringify({ u: userId, c: codeChangeId, b: button, e: now.getTime() + BUTTON_DAYS * 86_400_000 })).toString("base64url");
  const signed = signature(payload);
  return signed ? `${payload}.${signed}` : null;
}

/** A token read back: who it's for, its change and button, and whether it's out of date. Null if it isn't one of ours. */
export function readAutopilotButton(token: string, now = new Date()): { userId: string; codeChangeId: string; button: AutopilotButton; expired: boolean } | null {
  const [payload, sent] = token.split(".");
  const expected = payload ? signature(payload) : null;
  const [given, wanted] = [Buffer.from(sent ?? ""), Buffer.from(expected ?? "")];
  if (!payload || !sent || !expected || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }
  try {
    const { u, c, b, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u: string; c: string; b: AutopilotButton; e: number };
    return { userId: u, codeChangeId: c, button: b, expired: now.getTime() > e };
  } catch {
    return null;
  }
}
