import { createHmac, timingSafeEqual } from "node:crypto";

import { type CodeChangeActionKind, Prisma, prisma } from "@tuti/db";
import { codeChangesEnabled, log, planIncludes } from "@tuti/shared";

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
const AT_ONCE = new Set<CodeChangeActionKind>(["CHANGELOG_LINE", "NEW_ARTICLE"]);

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

type Candidate = {
  codeChangeId: string;
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
  if (!codeChangesEnabled() || !project.analyseCodeChanges || !planIncludes(project.plan, "codeChanges")) {
    return "Autopilot is off";
  }
  const on: Partial<Record<CodeChangeActionKind, boolean>> = {
    CHANGELOG_LINE: project.autopilotDrafts,
    NEW_ARTICLE: project.autopilotDrafts,
    ARTICLE_EDIT: project.autopilotArticleEdits,
    MOVES_FORWARD: project.autopilotProgress,
    RESOLVES: project.autopilotComplete,
  };
  if (!on[action.kind]) {
    return "Autopilot asks first for these";
  }
  const change = await db.codeChange.findUnique({ where: { id: action.codeChangeId }, select: { state: true, url: true, projectId: true } });
  if (change?.state !== "READY") {
    return "Its pull request was analysed again";
  }
  // The line rewrites the pull request's bullet wherever it is in this project: once that entry is published, readers see it.
  if (action.kind === "CHANGELOG_LINE" && (await db.changelogEntryPullRequest.count({ where: { url: change.url, entry: { projectId: change.projectId, publishedAt: { not: null } } } })) > 0) {
    return "Its changelog entry is published";
  }
  // The changelog line is always written as the pull request's; the rest must be sure enough.
  if (action.kind !== "CHANGELOG_LINE" && action.probability * 100 < project.autopilotMinSure) {
    return `Less than ${project.autopilotMinSure}% sure`;
  }
  const payload = (action.payload ?? {}) as { comment?: string; basedOn?: string | null };
  if (action.kind === "MOVES_FORWARD" && !(payload.comment ?? "").trim()) {
    return "No progress update to post";
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
    const article = await db.article.findUnique({
      where: { id: action.articleId },
      select: {
        deletedAt: true,
        publishedAt: true,
        changes: { select: { articleId: true } },
        revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } },
      },
    });
    if (!article || article.deletedAt || !article.publishedAt || article.changes || (article.revisions[0]?.id ?? null) !== (payload.basedOn ?? null)) {
      return "Its article changed since";
    }
    if ((await recentViews(action.articleId, db)) >= project.autopilotMaxViews) {
      return `Its article was read ${project.autopilotMaxViews} times or more in 30 days`;
    }
  }
  return null;
}

/** When an update that may go out by itself goes: drafts now, the rest after the project's hold. */
export const dueAt = (kind: CodeChangeActionKind, project: AutopilotSettings, now = new Date()) =>
  AT_ONCE.has(kind) ? now : new Date(now.getTime() + project.autopilotHoldHours * 3_600_000);

/**
 * After an analysis is saved: each update waiting for the team that may go out by itself is scheduled
 * (drafts at once, the rest after the hold). Returns how many.
 */
export async function scheduleByItself(projectId: string, codeChangeId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: autopilotSettingsSelect });
  if (!project) {
    return 0;
  }
  // Not one the team stopped: that waits for them.
  const waiting = await db.codeChangeAction.findMany({
    where: { codeChangeId, status: "PENDING", decidedById: null },
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
