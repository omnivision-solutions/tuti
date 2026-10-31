import { createHmac } from "node:crypto";

import { type CodeChangeActionKind, Prisma, prisma } from "@tuti/db";
import { codeChangesEnabled, planIncludes } from "@tuti/shared";

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

/** How many people a post reaches: its author, voters and commenters. */
export async function postReach(postId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ people: bigint }[]>`
    SELECT COUNT(DISTINCT x."userId") AS people FROM (
      SELECT "authorId" AS "userId" FROM post WHERE id = ${postId}
      UNION SELECT "userId" FROM vote WHERE "postId" = ${postId}
      UNION SELECT "authorId" FROM comment WHERE "postId" = ${postId}
    ) x`;
  return Number(row?.people ?? 0);
}

/** How often an article was read on the portal in the last 30 days. */
export async function recentViews(articleId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const { _sum } = await prisma.articleViewDay.aggregate({ where: { articleId, day: { gte: since } }, _sum: { views: true } });
  return _sum.views ?? 0;
}

type Candidate = {
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
export async function waitsBecause(action: Candidate, project: AutopilotSettings): Promise<string | null> {
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
  // The changelog line is always written as the pull request's; the rest must be sure enough.
  if (action.kind !== "CHANGELOG_LINE" && action.probability * 100 < project.autopilotMinSure) {
    return `Less than ${project.autopilotMinSure}% sure`;
  }
  const payload = (action.payload ?? {}) as { comment?: string; basedOn?: string | null };
  if (action.kind === "MOVES_FORWARD" && !(payload.comment ?? "").trim()) {
    return "No progress update to post";
  }
  if (action.postId) {
    const post = await prisma.post.findUnique({ where: { id: action.postId }, select: { status: true, duplicateOfId: true } });
    if (!post || post.duplicateOfId || post.status === "COMPLETED" || post.status === "CLOSED") {
      return "Its post changed since";
    }
    if ((await postReach(action.postId)) >= project.autopilotMaxReach) {
      return `Its post reaches ${project.autopilotMaxReach} people or more`;
    }
  }
  if (action.kind === "ARTICLE_EDIT" && action.articleId) {
    const article = await prisma.article.findUnique({
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
    if ((await recentViews(action.articleId)) >= project.autopilotMaxViews) {
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
export async function scheduleByItself(projectId: string, codeChangeId: string): Promise<number> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: autopilotSettingsSelect });
  if (!project) {
    return 0;
  }
  const waiting = await prisma.codeChangeAction.findMany({
    where: { codeChangeId, status: "PENDING" },
    select: { id: true, kind: true, probability: true, payload: true, postId: true, articleId: true },
  });
  let scheduled = 0;
  for (const action of waiting) {
    if ((await waitsBecause(action, project)) === null) {
      // Only while it's still waiting (the team may have decided it meanwhile).
      const { count } = await prisma.codeChangeAction.updateMany({
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
 * The worker's minute: asks the web app to apply Autopilot's due updates (applying is the web app's:
 * it saves posts, comments and articles as the team does). Nothing to do without the app's address.
 */
export async function autopilotDue(): Promise<{ applied: number; waiting: number } | { skipped: true }> {
  const token = autopilotDueToken();
  if (!process.env.APP_URL || !token) {
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
  return (await response.json()) as { applied: number; waiting: number };
}
