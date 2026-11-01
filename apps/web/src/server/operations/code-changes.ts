import { fromPlainText, toPlainText } from "@tuti/content";
import { type CodeChangeActionKind, type CodeChangeActionStatus, type CodeChangeState, type PostStatus, Prisma, prisma } from "@tuti/db";
import { autopilotSettingsSelect, changelogLineOf, confidence, emitEvent, enqueue, lockProject, setChangelogLine, tellOwners, THRESHOLDS, undoChangelogLine, waitsBecause } from "@tuti/jobs";
import { codeChangesEnabled, log, planIncludes } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { createComment } from "./create";
import { aiOrRefuse } from "./credits";
import { createArticle, updateArticle } from "./docs";
import { type Actor, defineOperation, OperationError } from "./define";
import { updatePost } from "./manage";
import { requirePlan } from "./plan";
import { postSummarySelect, projectPortal, summary, toApiStatus } from "./read";
import { call } from "./run";

/**
 * Code changes (docs/plan.md): every merged pull request, analysed into proposed actions the team
 * applies or dismisses. Applying is what changes anything customers see.
 */

const STATES: Record<CodeChangeState, string> = { ANALYSING: "analysing", READY: "ready", NOTHING_TO_DO: "nothing_to_do", FAILED: "failed", PAUSED: "paused" };
const KINDS: Record<CodeChangeActionKind, string> = {
  LINKS: "links",
  RESOLVES: "resolves",
  MOVES_FORWARD: "moves_forward",
  ARTICLE_EDIT: "article_edit",
  NEW_ARTICLE: "new_article",
  CHANGELOG_LINE: "changelog_line",
};
const ACTION_STATUSES: Record<CodeChangeActionStatus, string> = { PENDING: "pending", APPLIED: "applied", DISMISSED: "dismissed", STALE: "stale", UNDONE: "undone", SCHEDULED: "scheduled" };

/**
 * An update the review page ticks as it opens: one Autopilot is sure of (above its kind's likely
 * threshold; the changelog line always), and for a progress update, with a comment to post.
 */
export function likelyToApply(action: { kind: CodeChangeActionKind; probability: number; payload: Prisma.JsonValue }): boolean {
  // The changelog line only rewrites a bullet in a draft: always likely.
  if (action.kind === "CHANGELOG_LINE") {
    return true;
  }
  const comment = ((action.payload ?? {}) as { comment?: string }).comment ?? "";
  return action.probability >= THRESHOLDS[action.kind].likely && (action.kind !== "MOVES_FORWARD" || comment.trim() !== "");
}

/**
 * How many people completing each post emails (its author, voters and commenters, past the team,
 * those who turned the project's emails off and those it emailed already), by post id, as postShipped
 * does. ponytail: before its other rules (verified addresses, a private portal's readers): it can count
 * a few it won't email.
 */
export async function emailedOnCompletion(projectId: string, postIds: string[]): Promise<Map<string, number>> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, plan: true } });
  // A private portal on a plan without them is the team's only: postShipped emails nobody.
  if (postIds.length === 0 || (project.portalAccess === "PRIVATE" && !planIncludes(project.plan, "privatePortal"))) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<{ postId: string; people: bigint }[]>`
    SELECT x."postId", COUNT(DISTINCT x."userId") AS people
    FROM (
      SELECT id AS "postId", "authorId" AS "userId" FROM post WHERE id IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "userId" FROM vote WHERE "postId" IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "authorId" FROM comment WHERE "postId" IN (${Prisma.join(postIds)})
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM team_member t WHERE t."projectId" = ${projectId} AND t."userId" = x."userId")
      AND NOT EXISTS (SELECT 1 FROM email_opt_out o WHERE o."projectId" = ${projectId} AND o."userId" = x."userId")
      AND NOT EXISTS (SELECT 1 FROM shipped_email s WHERE s."postId" = x."postId" AND s."userId" = x."userId" AND s."sentAt" IS NOT NULL)
    GROUP BY x."postId"`;
  return new Map(rows.map((row) => [row.postId, Number(row.people)]));
}

const APPLICABLE = new Set<CodeChangeActionKind>(["LINKS", "RESOLVES", "MOVES_FORWARD", "ARTICLE_EDIT", "NEW_ARTICLE", "CHANGELOG_LINE"]);

type DocsPayload = { problem?: "wrong" | "missing"; basedOn?: string | null; title?: string; content?: unknown; body?: string; before?: string; edited?: boolean };

/** An article edit is out of date once the article was saved again since it was written, or has unpublished changes (applying would publish them too). */
const outdated = (payload: DocsPayload, article: { revisions: { id: string }[]; changes: unknown }) =>
  (article.revisions[0]?.id ?? null) !== (payload.basedOn ?? null) || article.changes !== null;

const articleSelect = {
  slug: true,
  title: true,
  publishedAt: true,
  collection: { select: { name: true } },
  changes: { select: { articleId: true } },
  // Newest first, ties by id: the order articles.update checks `revision` in.
  revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } },
} satisfies Prisma.ArticleSelect;

const changeSelect = {
  id: true,
  repo: true,
  number: true,
  url: true,
  title: true,
  author: true,
  mergedAt: true,
  state: true,
  reason: true,
  summary: true,
  _count: { select: { actions: { where: { status: { in: ["PENDING", "STALE"] } } } } },
} satisfies Prisma.CodeChangeSelect;

type ChangeRow = Prisma.CodeChangeGetPayload<{ select: typeof changeSelect }>;

/** Reasons saved before Code changes was Autopilot, as they read now (they stay saved on paused rows). */
const RENAMED_REASONS: Record<string, string> = { "Code changes need the Pro plan.": "Autopilot needs the Pro plan." };

const changeView = (change: ChangeRow) => ({
  id: change.id,
  repo: change.repo,
  number: change.number,
  url: change.url,
  title: change.title,
  author: change.author,
  mergedAt: change.mergedAt.toISOString(),
  state: STATES[change.state],
  /** Why there's nothing to do, or where it failed. */
  reason: change.reason && (RENAMED_REASONS[change.reason] ?? change.reason),
  summary: change.summary,
  /** Proposals waiting for the team. */
  waiting: change._count.actions,
});

export type CodeChangeView = ReturnType<typeof changeView> & {
  /** Updates going out by itself (their ids, for Publish now and Stop), and when the first goes (Home's "Goes out …"). */
  scheduled: string[];
  nextDueAt: string | null;
};

/**
 * The project's code changes: those with proposals waiting first, then newest first (`waiting`: only
 * those, as Home's Catch up lists; `paused`: only those paused for want of AI credits; `toReview`: every
 * one with something for the team, Autopilot's To review: those with proposals waiting, all of them and
 * whatever their state (one the team stopped outlives an analysis that finds nothing to do), and the latest
 * 100 analysing, failed or paused, which pile up while a plan or the credits don't run Autopilot).
 * ponytail: the latest 100 (all those waiting); page when teams need older ones.
 */
export async function codeChangeList(projectId: string, { waiting = false, paused = false, toReview = false } = {}): Promise<CodeChangeView[]> {
  // `take`: null for all of them.
  const latest = (where: Prisma.CodeChangeWhereInput, take: number | null = 100) =>
    prisma.codeChange.findMany({ where: { projectId, ...where }, orderBy: { mergedAt: "desc" }, take: take ?? undefined, select: changeSelect });
  const changes = toReview
    ? await Promise.all([
        latest({ actions: { some: { status: { in: ["PENDING", "STALE"] } } } }, null),
        latest({ state: { in: ["ANALYSING", "FAILED", "PAUSED"] } }),
      ]).then(([queue, unread]) =>
        [...queue, ...unread.filter((change) => !queue.some((other) => other.id === change.id))].sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime()),
      )
    : await latest({
        // Waiting for the team, or going out by itself (Home shows both).
        ...(waiting && { actions: { some: { status: { in: ["PENDING", "STALE", "SCHEDULED"] } } } }),
        ...(paused && { state: "PAUSED" }),
      });
  const scheduled = await prisma.codeChangeAction.findMany({
    where: { codeChangeId: { in: changes.map((change) => change.id) }, status: "SCHEDULED" },
    orderBy: { dueAt: "asc" },
    select: { id: true, codeChangeId: true, dueAt: true },
  });
  const of = (id: string) => scheduled.filter((action) => action.codeChangeId === id);
  return changes
    .map((change) => ({
      ...changeView(change),
      scheduled: of(change.id).map((action) => action.id),
      nextDueAt: of(change.id)[0]?.dueAt?.toISOString() ?? null,
    }))
    .sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0));
}

/** One code change with its proposed actions (most likely first; ties keep one order: by kind, then id), or null if the project has no such code change. */
export async function codeChangeDetail(projectId: string, id: string) {
  const change = await prisma.codeChange.findFirst({
    where: { id, projectId },
    select: {
      ...changeSelect,
      why: true,
      actions: {
        orderBy: [{ probability: "desc" }, { kind: "desc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          status: true,
          probability: true,
          reason: true,
          payload: true,
          decidedAt: true,
          dismissReason: true,
          dueAt: true,
          waitReason: true,
          decidedBy: { select: { name: true } },
          post: { select: { ...postSummarySelect, id: true, duplicateOfId: true } },
          article: { select: articleSelect },
        },
      },
    },
  });
  if (!change) {
    return null;
  }
  // Approving completes (and emails about) only a post not completed yet, nor merged into another.
  const completing = change.actions
    // Waiting for the team, or going out by itself: both email when they go.
    .filter(
      (action) =>
        action.kind === "RESOLVES" && (action.status === "PENDING" || action.status === "SCHEDULED") && action.post && action.post.status !== "COMPLETED" && !action.post.duplicateOfId,
    )
    .map((action) => action.post!.id);
  // For Undo to say first: those already emailed that it shipped, since it was approved (they can't be unemailed).
  const sent = new Map(
    await Promise.all(
      change.actions
        .filter((action) => action.kind === "RESOLVES" && action.status === "APPLIED" && action.post && action.decidedAt)
        .map(async (action) => [action.id, await prisma.shippedEmail.count({ where: { postId: action.post!.id, sentAt: { not: null }, claimedAt: { gte: action.decidedAt! } } })] as const),
    ),
  );
  const [portal, bullet, emails] = await Promise.all([
    projectPortal(projectId),
    prisma.changelogEntryPullRequest.findFirst({ where: { url: change.url, entry: { projectId } }, select: { entry: { select: { number: true, title: true } } } }),
    emailedOnCompletion(projectId, completing),
  ]);
  return {
    ...changeView(change),
    why: change.why,
    /** The changelog entry with the pull request's bullet, if one has it. */
    changelog: bullet?.entry ?? null,
    actions: change.actions.map((action) => {
      const payload = (action.payload ?? {}) as { comment?: string } & DocsPayload;
      const stale = action.kind === "ARTICLE_EDIT" && action.status === "PENDING" && action.article !== null && outdated(payload, action.article);
      return {
        id: action.id,
        kind: KINDS[action.kind],
        status: stale ? "stale" : ACTION_STATUSES[action.status],
        probability: action.probability,
        confidence: action.kind === "CHANGELOG_LINE" ? "likely" : confidence(action.kind, action.probability),
        /** Ticked as the review page opens (see likelyToApply). */
        applyLikely: !stale && action.status === "PENDING" && likelyToApply(action),
        /** For a request it closed: how many it emailed that it shipped (Undo can't take those back). */
        ...(sent.has(action.id) && { emailed: sent.get(action.id)! }),
        /** For a request it closes: how many people completing it emails. */
        ...(action.kind === "RESOLVES" && (action.status === "PENDING" || action.status === "SCHEDULED") && action.post && { emails: emails.get(action.post.id) ?? 0 }),
        reason: action.reason,
        /** The team's comment, for a post it moves forward (as proposed, or as posted once applied). */
        ...(action.kind === "MOVES_FORWARD" && { comment: payload.comment ?? "" }),
        post: action.post ? summary(action.post, portal) : null,
        /** The article it edits (or, for a new article once its draft exists, the draft). */
        article: action.article && { slug: action.article.slug, title: action.article.title, collection: action.article.collection?.name ?? null },
        /** An article edit's text before and after, and a new article's title and text (plain text). */
        ...(action.kind === "ARTICLE_EDIT" && { problem: payload.problem ?? "wrong", before: payload.before ?? "", after: payload.body ?? "" }),
        ...(action.kind === "NEW_ARTICLE" && { title: payload.title ?? "", after: payload.body ?? "" }),
        /** The pull request's line in the changelog (as proposed, or as written once applied). */
        ...(action.kind === "CHANGELOG_LINE" && { line: (payload as { line?: string }).line ?? "" }),
        /** Who applied or dismissed it: "Autopilot" for a link it applied by itself (see AUTO_LINK, and `auto`). */
        decidedBy: action.decidedBy?.name ?? ((payload as { auto?: boolean }).auto ? "Autopilot" : null),
        /** Applied by Autopilot itself, nobody approving it. */
        auto: Boolean((payload as { auto?: boolean }).auto),
        /** Autopilot went to apply it by itself and couldn't tell whether it went out: someone should check. */
        unsure: Boolean((payload as { unsure?: boolean }).unsure),
        /** Approved, with what it changed recorded: Undo can put it back. */
        // An edit kept unpublished is finished (or discarded) in the editor: no Undo for it.
        canUndo: action.status === "APPLIED" && undoOf(action.payload, action.kind) !== null && undoOf(action.payload, action.kind)?.published !== false,
        /** Undo puts the post's status back (applying moved it): a closed request's shipped emails still due won't go. */
        putsBackStatus: Boolean(undoOf(action.payload, action.kind)?.status),
        decidedAt: action.decidedAt?.toISOString() ?? null,
        dismissReason: action.dismissReason,
        /** A scheduled update: when it goes out by itself (Publish now, Stop). */
        dueAt: action.dueAt?.toISOString() ?? null,
        /** Why it waits for the team after all (it stopped qualifying, or someone stopped it). */
        waitReason: action.waitReason,
      };
    }),
  };
}

export type CodeChangeDetail = NonNullable<Awaited<ReturnType<typeof codeChangeDetail>>>;

/**
 * How Autopilot is doing: of its last 50 updates that went out (approved, or applied by itself), how
 * many were kept as it wrote them: not undone since, and not edited (the team's own words before
 * approving; a draft or an edit finished in the editor, saved again since). Those approved before this
 * was recorded aren't counted either way.
 */
export async function autopilotRecord(projectId: string): Promise<{ kept: number; of: number; wentOut: boolean }> {
  const recent = await prisma.codeChangeAction.findMany({
    where: { codeChange: { projectId }, status: { in: ["APPLIED", "UNDONE"] } },
    // By when it was proposed, which Undo doesn't move (it does move decidedAt): an old update undone stays old.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // The last 50 it can count, from a few more (some aren't counted). ponytail: a fixed window, past
    // 200 mostly-uncountable ones it counts fewer than 50.
    take: 200,
    select: { kind: true, status: true, payload: true },
  });
  const known = recent.flatMap((action) => {
    const payload = (action.payload ?? {}) as { edited?: boolean; undo?: Undo; auto?: boolean };
    // What isn't counted when kept isn't counted when undone either.
    if (action.kind === "NEW_ARTICLE" || (action.kind === "ARTICLE_EDIT" && payload.undo?.published === false)) {
      // Finished in the editor: whether it went out as written isn't known (saved again before or after
      // it was published, deleted…), so it isn't counted either way.
      return [];
    }
    if ((action.kind === "MOVES_FORWARD" || action.kind === "CHANGELOG_LINE") && payload.edited === undefined) {
      return [];
    }
    if (action.kind === "ARTICLE_EDIT" && payload.undo === undefined) {
      return [];
    }
    if (action.status === "UNDONE") {
      return [false];
    }
    return [!payload.edited];
  });
  const last = known.slice(0, 50);
  return { kept: last.filter(Boolean).length, of: last.length, wentOut: recent.length > 0 };
}

const id = z.string().min(1).max(100);

export const listCodeChanges = defineOperation({
  name: "codeChanges.list",
  summary: "List code changes (Autopilot): merged pull requests, each with the updates it suggests (those with updates waiting first)",
  method: "GET",
  path: "/code-changes",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ codeChanges: await codeChangeList(projectId) }),
});

export const getCodeChange = defineOperation({
  name: "codeChanges.get",
  summary: "Get a code change with its proposed actions",
  method: "GET",
  path: "/code-changes/{id}",
  scope: "read",
  access: "team",
  input: z.object({ id }),
  run: async ({ projectId }, input) => {
    const change = await codeChangeDetail(projectId, input.id);
    if (!change) {
      throw new OperationError(404, "not_found", "Code change not found");
    }
    return change;
  },
});

export const analyseCodeChange = defineOperation({
  name: "codeChanges.analyse",
  summary:
    "Analyse a code change again; one with nothing to do is analysed past that decision (\"Analyse anyway\"); refused (402) out of AI credits or where the project's plan doesn't include code changes",
  method: "POST",
  path: "/code-changes/{id}/analyse",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async ({ projectId }, input) => {
    const change = await prisma.codeChange.findFirst({
      where: { id: input.id, projectId },
      select: { id: true, state: true, project: { select: { analyseCodeChanges: true } } },
    });
    if (!change) {
      throw new OperationError(404, "not_found", "Code change not found");
    }
    if (!codeChangesEnabled() || !change.project.analyseCodeChanges) {
      throw new OperationError(409, "analysis_off", "Autopilot is off: an owner turns it on in Settings → Autopilot");
    }
    await requirePlan(projectId, "codeChanges");
    // Out of AI credits, the team hears so now, rather than finding it paused again.
    await aiOrRefuse(projectId, "code_changes");
    try {
      await enqueue("codeChange", { codeChangeId: change.id, force: true, pastGate: change.state === "NOTHING_TO_DO", resume: false });
    } catch {
      // Inline, the analysis itself failed (the code change says where); on Hatchet, queueing did.
      throw new OperationError(503, "unavailable", "Couldn't analyse it. Try again in a moment.");
    }
    const after = await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id }, select: changeSelect });
    return changeView(after);
  },
});

export const resumeCodeChanges = defineOperation({
  name: "codeChanges.resume",
  summary:
    "Resume every paused code change, paused because the project was out of AI credits or its plan didn't include code changes (\"Resume all\"): each is analysed again (`resumed`: queued, or where jobs run inline, analysed; `failed`: those whose analysis failed at once, inline); refused (402) while the project is still out, or its plan still doesn't include them",
  method: "POST",
  path: "/code-changes/resume",
  scope: "write",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { analyseCodeChanges: true } });
    if (!codeChangesEnabled() || !project.analyseCodeChanges) {
      throw new OperationError(409, "analysis_off", "Autopilot is off: an owner turns it on in Settings → Autopilot");
    }
    await requirePlan(projectId, "codeChanges");
    await aiOrRefuse(projectId, "code_changes");
    // Nothing is marked before it's queued (the job marks it analysing as it starts, as for one), so
    // one not queued yet, the server stopping meanwhile, stays paused for the next "Resume all".
    // Resumed (`resume`): each run claims its code change as it starts, so a second "Resume all" at once
    // skips the ones already taken.
    const paused = await prisma.codeChange.findMany({
      where: { projectId, state: "PAUSED" },
      orderBy: { mergedAt: "asc" },
      select: { id: true },
    });
    let resumed = 0;
    let failed = 0;
    for (const change of paused) {
      try {
        // Inline, the analysis runs here and says whether it went ahead; on Hatchet, queued is resumed.
        const result = await enqueue("codeChange", { codeChangeId: change.id, force: false, pastGate: false, resume: true });
        if (!result?.skipped) {
          resumed++;
        }
      } catch {
        // Inline, the analysis itself failed (the code change says where): counted, and the rest go on.
        if (process.env.JOBS_DRIVER === "inline") {
          failed++;
          continue;
        }
        // On Hatchet, queueing failed: those not queued are still paused, for the next try.
        throw new OperationError(503, "unavailable", "Couldn't resume them all. Try again in a moment.");
      }
    }
    return { resumed, failed };
  },
});

/** The person behind a call: the user, or the key's creator. */
const actorUser = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** Statuses a post moves on from to In progress when a code change moves it forward. */
const NOT_STARTED = new Set(["OPEN", "UNDER_REVIEW", "PLANNED"]);

/**
 * Puts a claimed action back (waiting again, or out of date) after a failure, then rethrows `error`.
 * If even that fails, nobody can tell what went: rethrown marked `saved: "unknown"` (it stays claimed,
 * so it's never done twice, and the team is told to check).
 */
async function revert(id: string, data: Prisma.CodeChangeActionUncheckedUpdateManyInput, error: unknown): Promise<never> {
  try {
    // Only while it's still the claimed apply's (nobody undid it meanwhile).
    await prisma.codeChangeAction.updateMany({ where: { id, status: "APPLIED" }, data });
  } catch {
    // Not a refusal (an OperationError's message would say "try again" or "out of date"): unknown, the refusal as its cause.
    throw Object.assign(new Error("Couldn't put an Autopilot update back after a failure", { cause: error }), { saved: "unknown" as const });
  }
  throw error;
}

export const applyCodeChangeAction = defineOperation({
  name: "codeChangeActions.apply",
  summary:
    "Apply a proposed action: link the post, complete it (its people get the shipped email) or post the team's comment on it; publish an article's edit (or, with `publish: false`, keep it unpublished to finish in the editor); create a new article's draft; or write the pull request's line in the changelog (its bullet in the entry that has it, else the running draft)",
  method: "POST",
  path: "/code-change-actions/{id}/apply",
  scope: "write",
  access: "team",
  input: z.object({
    id,
    /** For a post it moves forward: the comment to post, if the team changed it. */
    comment: z.string().trim().min(1).max(5_000).optional(),
    /** For an article edit: publish it now (the default), or false to keep it as the article's unpublished changes, to finish in the editor. */
    publish: z.boolean().optional(),
    /** For the changelog line: the line to write, if the team changed it. */
    line: z.string().trim().min(1).max(300).optional(),
  }),
  example: { comment: "Weekly repeats are out today; monthly ones are next." },
  run: async (context, input) => {
    const { projectId } = context;
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: input.id, codeChange: { projectId } },
      select: {
        id: true,
        kind: true,
        status: true,
        payload: true,
        // Who stopped it, if someone did: a failed apply puts that back (it's what keeps it off the schedule).
        decidedById: true,
        codeChange: { select: { id: true, repo: true, number: true, url: true, title: true } },
        post: { select: { id: true, number: true, status: true } },
        article: { select: { ...articleSelect, id: true, deletedAt: true } },
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (!APPLICABLE.has(action.kind)) {
      throw new OperationError(409, "not_applicable", "This kind of action can't be applied yet");
    }
    if (action.kind === "ARTICLE_EDIT" || action.kind === "NEW_ARTICLE") {
      return applyDocs(context, { ...action, article: action.article }, input.publish ?? true);
    }
    if (action.kind === "CHANGELOG_LINE") {
      const line = input.line ?? ((action.payload ?? {}) as { line?: string }).line ?? "";
      // Whether the changelog has the pull request yet: if not, a failed try takes out what it added.
      const before = await changelogLineOf(projectId, action.codeChange.url);
      const undo = { previous: before?.text ?? null, added: before === null ? ("entry" as const) : before.text === null ? ("bullet" as const) : null };
      // Changed by the team before approving (for "how it's doing").
      const edited = line !== (((action.payload ?? {}) as { line?: string }).line ?? "");
      const { count } = await prisma.codeChangeAction.updateMany({
        where: { id: action.id, status: "PENDING" },
        // Applying adds the bullet when no entry has it (and the pull request too, when none has that): Undo takes them out again.
        data: {
          status: "APPLIED",
          decidedById: actorUser(context.actor),
          decidedAt: new Date(),
          // What to undo is recorded once it's done: till then, Undo has nothing to go on.
          payload: { line, edited },
        },
      });
      if (count === 0) {
        throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
      }
      try {
        // What to put back is what the bullet said as it was rewritten (read under the project's lock).
        const { number: entry, previous, added } = await setChangelogLine(projectId, { ...action.codeChange }, line);
        await recordUndo(action.id, { line, edited }, { previous, added });
        return { id: action.id, kind: KINDS[action.kind], status: "applied", changelog: entry };
      } catch (error) {
        // Not done: the pull request it put in a draft comes out again (writing the line is one save: it's
        // done or not), and it's waiting again.
        if (undo.added === "entry") {
          await undoChangelogLine(projectId, action.codeChange.url, { applied: null, previous: "", added: "entry" }).catch((cause: unknown) => unknown(error, cause));
        }
        return revert(action.id, { status: "PENDING", decidedById: action.decidedById, decidedAt: null, payload: action.payload ?? {} }, error);
      }
    }
    if (!action.post) {
      throw new OperationError(409, "not_applicable", "This kind of action can't be applied yet");
    }
    const proposed = ((action.payload ?? {}) as { comment?: string }).comment ?? "";
    const comment = input.comment ?? proposed;
    if (action.kind === "MOVES_FORWARD" && !comment.trim()) {
      throw new OperationError(400, "invalid_input", "Write the comment to post first");
    }
    // Claimed first, so two people applying it at once do it once.
    const claimedAt = new Date();
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: "PENDING" },
      data: {
        status: "APPLIED",
        decidedById: actorUser(context.actor),
        decidedAt: claimedAt,
        ...(action.kind === "MOVES_FORWARD" && { payload: { comment } }),
      },
    });
    if (count === 0) {
      throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
    }
    const { codeChange, post } = action;
    // What it changes, for Undo to put back: the link (if it's new), the entries it joins, the status it moved from, the comment.
    const undo: { linked: boolean; entries: string[]; status: string | null; commentId: string | null } = { linked: false, entries: [], status: null, commentId: null };
    // Once the comment is being posted, it may be saved even if something after it fails: then the
    // action stays applied, so trying again can't post it twice.
    let posting = false;
    try {
      undo.linked = !(await prisma.postLink.findUnique({ where: { postId_url: { postId: post.id, url: codeChange.url } }, select: { postId: true } }));
      // The comment last: once it's being posted, a failure may come after it was saved.
      await prisma.postLink.upsert({
        where: { postId_url: { postId: post.id, url: codeChange.url } },
        create: {
          projectId,
          postId: post.id,
          kind: "PULL_REQUEST",
          repo: codeChange.repo,
          number: codeChange.number,
          url: codeChange.url,
          title: codeChange.title,
          source: "CODE_CHANGE",
          codeChangeId: codeChange.id,
          createdById: actorUser(context.actor),
        },
        update: {},
      });
      if (action.kind === "RESOLVES") {
        // The changelog entry with the pull request's bullet completes the post too.
        const entries = await prisma.changelogEntryPullRequest.findMany({ where: { url: codeChange.url, entry: { projectId } }, select: { entryId: true } });
        const had = await prisma.changelogEntryPost.findMany({ where: { postId: post.id, entryId: { in: entries.map((e) => e.entryId) } }, select: { entryId: true } });
        undo.entries = entries.map((e) => e.entryId).filter((entryId) => !had.some((h) => h.entryId === entryId));
        await prisma.changelogEntryPost.createMany({ data: entries.map(({ entryId }) => ({ entryId, postId: post.id })), skipDuplicates: true });
        if (post.status !== "COMPLETED") {
          undo.status = post.status;
          await call(updatePost, context, { number: post.number, status: toApiStatus("COMPLETED") });
        }
      }
      if (action.kind === "MOVES_FORWARD") {
        if (NOT_STARTED.has(post.status)) {
          undo.status = post.status;
          await call(updatePost, context, { number: post.number, status: toApiStatus("IN_PROGRESS") });
        }
        posting = true;
        undo.commentId = (await call(createComment, context, { number: post.number, body: comment })).id;
      }
    } catch (error) {
      // Refused before saving (an OperationError: the post was merged, say) or failed before the comment: not done.
      // Failed while posting it: done if the comment was saved (it stays applied, so it's never posted twice).
      if (posting && !(error instanceof OperationError)) {
        // Can't tell (the check failed too): it stays applied, so it's never posted twice, but nobody's told it went.
        // This try's comment: by whoever applies it, with its words as a comment keeps them, since the claim.
        const body = toPlainText(fromPlainText(comment));
        const found = await prisma.comment
          .findFirst({ where: { postId: post.id, authorId: actorUser(context.actor), body, createdAt: { gte: claimedAt } }, orderBy: { createdAt: "asc" }, select: { id: true } })
          .catch(() => "unknown" as const);
        const saved = found === "unknown" ? "unknown" : found !== null;
        if (found && found !== "unknown") {
          // Found, Undo can take it all back. Can't tell: no record, so Undo says to change it by hand.
          await recordUndo(action.id, { comment, edited: comment !== proposed }, { ...undo, commentId: found.id });
        }
        if (saved !== false) {
          throw Object.assign(error as Error, { saved });
        }
      }
      // Not done: what this try did is put back, and it's waiting again, for another try.
      await putBackPost(context, action.kind, post, codeChange.url, undo).catch((cause: unknown) => unknown(error, cause));
      return revert(action.id, { status: "PENDING", decidedById: action.decidedById, decidedAt: null, payload: action.payload ?? {} }, error);
    }
    await recordUndo(action.id, action.kind === "MOVES_FORWARD" ? { comment, edited: comment !== proposed } : asObject(action.payload), undo);
    return { id: action.id, kind: KINDS[action.kind], status: "applied", post: post.number };
  },
});

export const applyCodeChangeActions = defineOperation({
  name: "codeChangeActions.applyMany",
  summary:
    "Apply several proposed actions at once (the review page's Approve), each as codeChangeActions.apply does, with its edits (`comment`, `publish`, `line`): in order, each on its own, so one refused (out of date, already decided) doesn't stop the rest. Each is claimed as it's applied, so two people approving the same ones at once apply each once. `results` says, for each, `applied` or why not",
  method: "POST",
  path: "/code-change-actions/apply",
  scope: "write",
  access: "team",
  input: z.object({
    actions: z
      .array(z.object({ id, comment: z.string().trim().min(1).max(5_000).optional(), publish: z.boolean().optional(), line: z.string().trim().min(1).max(300).optional() }))
      .min(1, "Pick at least one")
      .max(50, "Up to 50 at once")
      .refine((actions) => new Set(actions.map((action) => action.id)).size === actions.length, "Each action once"),
  }),
  example: { actions: [{ id: "cm3x9a1b2c3d4e5f6g7h8i9j0" }, { id: "cm3x9a1b2c3d4e5f6g7h8i9j1", comment: "Weekly repeats are out today." }] },
  run: async (context, input) => {
    const results: ({ id: string; status: "applied" } | { id: string; status: "failed"; code: string; message: string })[] = [];
    for (const action of input.actions) {
      try {
        await call(applyCodeChangeAction, context, action);
        results.push({ id: action.id, status: "applied" });
      } catch (error) {
        // Said, and the rest go on, so those already applied (and emailed about) are still reported.
        // First what apply says went (or may have) before the failure, whatever the error: a comment or
        // an article's version saved stays applied, so trying again can't do it twice.
        const { saved } = error as { saved?: boolean | "unknown" };
        if (saved === true) {
          results.push({ id: action.id, status: "applied" });
        } else if (saved === "unknown") {
          log.error("Approving an Autopilot update: couldn't tell whether it went", { error, actionId: action.id });
          results.push({ id: action.id, status: "failed", code: "unknown", message: "Couldn't tell whether it went out: check it before doing it again" });
        } else if (error instanceof OperationError) {
          // Refused (out of date, decided already, not found): nothing went.
          results.push({ id: action.id, status: "failed", code: error.code, message: error.message });
        } else {
          log.error("Approving an Autopilot update failed", { error, actionId: action.id });
          results.push({ id: action.id, status: "failed", code: "internal", message: "Couldn't apply it. Try again in a moment." });
        }
      }
    }
    return { results };
  },
});

/** The article's newest version, as articles.update orders them. */
const newestRevision = async (articleId: string) =>
  (await prisma.articleRevision.findFirst({ where: { articleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }))?.id ?? null;

/**
 * Puts back what applying an update to a post did (`undo`): Undo, or a try that failed part-way. The
 * status goes back only if the post still has the one it was moved to (a teammate's later choice
 * stays), leaving shipped emails still due unsent: they go only while it's Completed.
 */
async function putBackPost(
  context: { actor: Actor; projectId: string },
  kind: CodeChangeActionKind,
  post: { id: string; number: number },
  url: string,
  undo: Pick<Undo, "linked" | "entries" | "status" | "commentId">,
) {
  if (undo.commentId) {
    const commentId = undo.commentId;
    // Together, so a retry after a failure can't leave the count one too high.
    await prisma.$transaction(async (tx) => {
      const { count: deleted } = await tx.comment.deleteMany({ where: { id: commentId, postId: post.id } });
      if (deleted) {
        await tx.post.update({ where: { id: post.id }, data: { commentCount: { decrement: 1 } } });
      }
    });
  }
  if (undo.entries?.length) {
    await prisma.changelogEntryPost.deleteMany({ where: { postId: post.id, entryId: { in: undo.entries } } });
  }
  if (undo.linked) {
    await prisma.postLink.deleteMany({ where: { postId: post.id, url, source: "CODE_CHANGE" } });
  }
  const movedTo = kind === "RESOLVES" ? "COMPLETED" : "IN_PROGRESS";
  const now = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { status: true } });
  if (undo.status && now.status === movedTo) {
    await call(updatePost, context, { number: post.number, status: toApiStatus(undo.status as PostStatus) });
  }
}

/** A failure, and then putting back what it did failed too: whether anything went out is unknown. */
const unknown = (error: unknown, cause: unknown): never => {
  throw Object.assign(new Error("Couldn't put back what a failed Autopilot update did", { cause: error }), { saved: "unknown" as const, putBack: cause });
};

/**
 * Keeps what applying changed (`undo`) with the action's payload, for codeChangeActions.undo. It's
 * applied either way: if this fails, Undo says to change it by hand.
 */
const recordUndo = (id: string, payload: object, undo: object) =>
  prisma.codeChangeAction
    .update({ where: { id }, data: { payload: { ...payload, undo } as Prisma.InputJsonValue } })
    .then(
      () => undefined,
      (error: unknown) => log.error("code change: couldn't record what to undo", { actionId: id, error: String(error) }),
    );

/**
 * An article edit is published as a new version (or kept as unpublished changes to finish in the
 * editor); a new article becomes a draft. Claimed first, and back to waiting if saving fails.
 */
async function applyDocs(
  context: { actor: Actor; projectId: string },
  action: {
    id: string;
    kind: CodeChangeActionKind;
    status: CodeChangeActionStatus;
    payload: Prisma.JsonValue;
    decidedById: string | null;
    article: (Prisma.ArticleGetPayload<{ select: typeof articleSelect }> & { id: string; deletedAt: Date | null }) | null;
  },
  publish: boolean,
) {
  const payload = (action.payload ?? {}) as DocsPayload;
  const { article } = action;
  if (action.kind === "ARTICLE_EDIT") {
    if (!article || article.deletedAt || !article.publishedAt) {
      throw new OperationError(409, "not_published", "The article isn't published any more");
    }
    if (action.status === "PENDING" && outdated(payload, article)) {
      await prisma.codeChangeAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { status: "STALE" } });
      throw new OperationError(409, "stale", "The article changed since this edit was written. Analyse again to write it again, or dismiss it.");
    }
  }
  const claimedAt = new Date();
  // For Undo: the version this save made (by whoever applies it, with the proposal's text, since the
  // claim), not the newest: a teammate's save right after it isn't it, so Undo refuses then.
  const ourRevision = async (articleId: string) =>
    (
      await prisma.articleRevision.findFirst({
        where: { articleId, authorId: actorUser(context.actor), createdAt: { gte: claimedAt }, body: payload.body ?? "" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      })
    )?.id ?? null;
  const { count } = await prisma.codeChangeAction.updateMany({
    where: { id: action.id, status: "PENDING" },
    data: { status: "APPLIED", decidedById: actorUser(context.actor), decidedAt: claimedAt },
  });
  if (count === 0) {
    throw new OperationError(409, "already_decided", "Someone already applied or dismissed this, or it's out of date");
  }
  // What readers saw before it (no unpublished changes are waiting, or it'd be out of date): Undo publishes it again.
  let live: Prisma.JsonValue | undefined;
  try {
    if (action.kind === "ARTICLE_EDIT") {
      // An article written before rich text has only its text: as a document, so Undo can publish it again.
      const current = await prisma.article.findUniqueOrThrow({ where: { id: article!.id }, select: { content: true, body: true } });
      live = current.content ?? (fromPlainText(current.body) as Prisma.JsonValue);
      // Saved only if the article is still the version the edit was written against (checked under the project's lock).
      await call(updateArticle, context, { slug: article!.slug, content: payload.content, publish, ...(payload.basedOn && { revision: payload.basedOn }) });
      // For Undo: the version it published (to tell whether it's been edited since) and the one before it.
      await recordUndo(action.id, payload, { revision: await ourRevision(article!.id), live, published: publish });
      return { id: action.id, kind: KINDS[action.kind], status: "applied", article: article!.slug, published: publish };
    }
    const created = await call(createArticle, context, { title: payload.title ?? "", content: payload.content });
    const draft = await prisma.article.findFirstOrThrow({ where: { projectId: context.projectId, slug: created.slug, deletedAt: null }, select: { id: true } });
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { articleId: draft.id } });
    await recordUndo(action.id, payload, { revision: await ourRevision(draft.id) });
    return { id: action.id, kind: KINDS[action.kind], status: "applied", article: created.slug, published: false };
  } catch (error) {
    // Saved anyway (the failure came after it)? Then it stays applied, so trying again can't save it
    // twice (a second draft, say). Not saved: it's waiting again. This attempt's save is a version of
    // the article (or a new article) by whoever applies it, with the proposal's text, since the claim:
    // a teammate's save meanwhile isn't it.
    const ours = { createdAt: { gte: claimedAt }, body: payload.body ?? "" };
    // Can't tell (the check failed too): it stays applied, and the team is told to check.
    const found = await (action.kind === "ARTICLE_EDIT"
      ? prisma.articleRevision.findFirst({ where: { articleId: article!.id, authorId: actorUser(context.actor), ...ours }, select: { id: true } })
      : prisma.article.findFirst({ where: { projectId: context.projectId, title: payload.title ?? "", createdById: actorUser(context.actor), ...ours }, select: { id: true } })
    ).catch(() => "unknown" as const);
    const saved = found === "unknown" ? "unknown" : found !== null;
    if (saved !== false) {
      // What users see was saved (or may have been): it stays applied, and says so. Found, Undo can take it back.
      if (found && found !== "unknown") {
        await (action.kind === "ARTICLE_EDIT"
          ? recordUndo(action.id, payload, { revision: found.id, live, published: publish })
          : prisma.codeChangeAction
              .update({ where: { id: action.id }, data: { articleId: found.id } })
              .then(async () => recordUndo(action.id, payload, { revision: await ourRevision(found.id) }))
              .catch((cause: unknown) => log.error("code change: couldn't record what to undo", { actionId: action.id, error: String(cause) })));
      }
      throw Object.assign(error as Error, { saved });
    }
    // Saved again since the check above: it's out of date now.
    const changed = error instanceof OperationError && error.code === "changed";
    return revert(
      action.id,
      { status: changed ? "STALE" : "PENDING", decidedById: action.decidedById, decidedAt: null },
      changed ? new OperationError(409, "stale", "The article changed since this edit was written. Analyse again to write it again, or dismiss it.") : error,
    );
  }
}

/** What applying an update changed (its payload's `undo`), for Undo to put back. */
/** A JSON value as an object to spread (anything else: none). */
const asObject = (json: Prisma.JsonValue): Prisma.JsonObject => (json && typeof json === "object" && !Array.isArray(json) ? json : {});

type Undo = {
  linked?: boolean;
  entries?: string[];
  status?: string | null;
  commentId?: string | null;
  /** An article's version once applied (to tell whether it's been edited since), and what readers saw before (its content). */
  revision?: string | null;
  live?: Prisma.JsonValue;
  published?: boolean;
  /** The changelog bullet's text before, and what applying added: the bullet, or the pull request with it ("entry"). */
  previous?: string | null;
  added?: "entry" | "bullet" | null;
};

/** What Undo has to go on: what applying recorded, or for a link Autopilot made by itself, that link. None: approved before Undo was. */
const undoOf = (payload: Prisma.JsonValue, kind: CodeChangeActionKind): Undo | null => {
  const { undo, auto } = (payload ?? {}) as { undo?: Undo; auto?: boolean };
  // A link Autopilot made by itself (linkByItself records no undo): just that link. Anything else without a record has none.
  return undo ?? (auto && kind === "LINKS" ? { linked: true } : null);
};

export const undoCodeChangeAction = defineOperation({
  name: "codeChangeActions.undo",
  summary:
    "Undo an applied action (any team member): a post goes back to the status it had (shipped emails still due are cancelled; ones sent already can't be), a progress update's comment is deleted, the link is removed, an article's previous version is published again (refused if it's been edited since), a new article's draft is deleted (refused once edited or published), the changelog line is put back (refused once its entry is published: edit the entry). It becomes `undone` and isn't proposed again",
  method: "POST",
  path: "/code-change-actions/{id}/undo",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async (context, input) => {
    const { projectId } = context;
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: input.id, codeChange: { projectId } },
      select: {
        id: true,
        kind: true,
        status: true,
        payload: true,
        decidedById: true,
        decidedAt: true,
        codeChange: { select: { repo: true, number: true, url: true, title: true } },
        post: { select: { id: true, number: true, status: true, duplicateOfId: true } },
        article: { select: { id: true, slug: true, publishedAt: true, deletedAt: true, changes: { select: { articleId: true } } } },
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (action.status !== "APPLIED") {
      throw new OperationError(409, "not_applied", "Only an approved update can be undone");
    }
    const undo = undoOf(action.payload, action.kind);
    if (!undo) {
      throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it by hand");
    }
    const { article } = action;

    // Refused before anything changes, saying why.
    if (action.post?.duplicateOfId) {
      throw new OperationError(409, "merged", "The post was merged into another since: change it there");
    }
    if (action.kind === "CHANGELOG_LINE" && (await changelogLineOf(projectId, action.codeChange.url))?.published) {
      throw new OperationError(409, "published", "Its changelog entry is published: edit the entry instead");
    }
    if (action.kind === "ARTICLE_EDIT" || action.kind === "NEW_ARTICLE") {
      if (!article || article.deletedAt) {
        throw new OperationError(409, "gone", "The article was deleted since");
      }
      if (action.kind === "ARTICLE_EDIT" && undo.published === false) {
        throw new OperationError(409, "in_editor", "Its edit is waiting in the editor: discard the changes there");
      }
      if ((await newestRevision(article.id)) !== (undo.revision ?? null) || article.changes) {
        throw new OperationError(409, "edited", "The article was edited since: change it in the editor instead");
      }
      if (action.kind === "NEW_ARTICLE" && article.publishedAt) {
        throw new OperationError(409, "published", "The article is published now: unpublish or delete it in Docs");
      }
    }

    // Claimed first, so two people undoing it at once do it once.
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: "APPLIED" },
      data: { status: "UNDONE", decidedById: actorUser(context.actor), decidedAt: new Date() },
    });
    if (count === 0) {
      throw new OperationError(409, "already_decided", "Someone already undid this");
    }
    try {
      if (action.kind === "CHANGELOG_LINE") {
        // Back to what the bullet said; one applying added goes again.
        // Published meanwhile (the check above ran before the project's lock), or the bullet rewritten since: refused, unchanged.
        const result = await undoChangelogLine(projectId, action.codeChange.url, {
          applied: ((action.payload ?? {}) as { line?: string }).line ?? "",
          previous: undo.previous ?? `${action.codeChange.title} (${action.codeChange.repo}#${action.codeChange.number})`,
          added: undo.added ?? null,
        });
        if (result === "published") {
          throw new OperationError(409, "published", "Its changelog entry is published: edit the entry instead");
        }
        if (result === "edited") {
          throw new OperationError(409, "edited", "The changelog line was edited since: change it in the entry instead");
        }
      } else if (action.kind === "ARTICLE_EDIT") {
        if (undo.live === undefined || undo.live === null) {
          throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it in the editor");
        }
        // What readers saw before, published again in one save, only if the article is still the version it published.
        await call(updateArticle, context, { slug: article!.slug, content: undo.live, publish: true, ...(undo.revision && { revision: undo.revision }) });
      } else if (action.kind === "NEW_ARTICLE") {
        // Checked again under the project's lock (as articles.delete takes it): a draft published or saved meanwhile stays.
        const deleted = await prisma.$transaction(async (tx) => {
          await lockProject(tx, projectId);
          const draft = await tx.article.findUniqueOrThrow({ where: { id: article!.id }, select: { publishedAt: true, deletedAt: true, changes: { select: { articleId: true } } } });
          const newest = await tx.articleRevision.findFirst({ where: { articleId: article!.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
          if (draft.publishedAt || draft.deletedAt || draft.changes || (newest?.id ?? null) !== (undo.revision ?? null)) {
            return false;
          }
          await tx.article.update({ where: { id: article!.id }, data: { deletedAt: new Date() } });
          await tx.articleChunk.deleteMany({ where: { articleId: article!.id } });
          return true;
        });
        if (!deleted) {
          throw new OperationError(409, "edited", "The draft was edited or published since: change it in Docs");
        }
      } else if (action.post) {
        await putBackPost(context, action.kind, action.post, action.codeChange.url, undo);
      }
    } catch (error) {
      // Not done: it's applied again, for another try.
      await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", decidedById: action.decidedById, decidedAt: action.decidedAt } });
      throw error;
    }
    return { id: action.id, status: "undone" };
  },
});

export const publishCodeChangeActionNow = defineOperation({
  name: "codeChangeActions.publishNow",
  summary: "Publish now: a scheduled action (going out by itself after the hold) is applied at once, as codeChangeActions.apply does, by whoever asks",
  method: "POST",
  path: "/code-change-actions/{id}/publish-now",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async (context, input) => {
    const action = await prisma.codeChangeAction.findFirst({ where: { id: input.id, codeChange: { projectId: context.projectId } }, select: { id: true } });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    // Taken off the schedule first, so the runner can't apply it too; apply then claims it as anyone's approval does.
    // Held as theirs meanwhile, so an analysis at that moment leaves it alone (it replaces only what nobody decided).
    const by = actorUser(context.actor);
    const { count } = await prisma.codeChangeAction.updateMany({ where: { id: action.id, status: "SCHEDULED" }, data: { status: "PENDING", dueAt: null, decidedById: by } });
    if (count === 0) {
      throw new OperationError(409, "not_scheduled", "It isn't scheduled any more: it went out, or someone stopped it");
    }
    try {
      return await call(applyCodeChangeAction, context, { id: action.id });
    } catch (error) {
      // Not applied (back to waiting, or out of date): nobody's again, not looking stopped.
      await prisma.codeChangeAction.updateMany({ where: { id: action.id, status: { in: ["PENDING", "STALE"] }, decidedById: by }, data: { decidedById: null } });
      throw error;
    }
  },
});

export const stopCodeChangeAction = defineOperation({
  name: "codeChangeActions.stop",
  summary: "Stop: a scheduled action doesn't go out by itself; it waits for the team instead (to approve, edit or dismiss)",
  method: "POST",
  path: "/code-change-actions/{id}/stop",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async (context, input) => {
    const action = await prisma.codeChangeAction.findFirst({ where: { id: input.id, codeChange: { projectId: context.projectId } }, select: { id: true } });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    const who = await prisma.user.findUnique({ where: { id: actorUser(context.actor) }, select: { name: true } });
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: "SCHEDULED" },
      // Who stopped it and when: analysed again, a stopped update stays as it is; the next person who tries is told ("stopped by Alice, just now").
      data: { status: "PENDING", dueAt: null, waitReason: `Stopped by ${who?.name ?? "the team"}`, decidedById: actorUser(context.actor), decidedAt: new Date() },
    });
    if (count === 0) {
      throw new OperationError(409, "not_scheduled", "It isn't scheduled any more: it went out, or someone stopped it");
    }
    return { id: action.id, status: "pending" };
  },
});

/**
 * Autopilot's runner: each scheduled update that's due is checked again (waitsBecause) and applied as
 * Tuti (by the project's first owner, marked as Autopilot's own), or put back to waiting with why. Run
 * every minute (the worker's autopilot-due, or a timer where jobs run inline). Returns how many of each.
 */
export async function runDueAutopilot(now = new Date()): Promise<{ applied: number; waiting: number }> {
  const due = await prisma.codeChangeAction.findMany({
    where: { status: "SCHEDULED", dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: 100,
    select: {
      id: true,
      codeChangeId: true,
      kind: true,
      probability: true,
      payload: true,
      postId: true,
      articleId: true,
      createdAt: true,
      codeChange: { select: { projectId: true, project: { select: autopilotSettingsSelect } } },
    },
  });
  let applied = 0;
  let waiting = 0;
  // Changes with an update that now waits for the team: told about, as an analysis is (code_change.ready).
  const nowWaiting = new Set<string>();
  // Only one still scheduled (a teammate may have stopped it meanwhile: their reason stays). After the
  // runner's own claim (`claimed`), the one its failed apply put back: waiting, or out of date (an article
  // changed since), as it is, now nobody's (an analysis may replace it again).
  const wait = async (action: { id: string; codeChangeId: string }, waitReason: string, claimed = false) => {
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: claimed ? { in: ["PENDING", "STALE"] } : "SCHEDULED" },
      data: claimed ? { dueAt: null, waitReason, decidedById: null } : { status: "PENDING", dueAt: null, waitReason },
    });
    waiting += count;
    if (count > 0) {
      nowWaiting.add(action.codeChangeId);
    }
  };
  for (const action of due) {
    const { projectId, project } = action.codeChange;
    const reason = await waitsBecause(action, project);
    if (reason) {
      await wait(action, reason);
      continue;
    }
    const owner = await prisma.teamMember.findFirst({ where: { projectId, role: "OWNER" }, orderBy: { createdAt: "asc" }, select: { userId: true } });
    if (!owner) {
      await wait(action, "The project has no owner to apply it as");
      continue;
    }
    // Taken off the schedule first, so two runners (or a Publish now) apply it once; held as the owner's while
    // it's applied, so an analysis at the same moment leaves it alone (it replaces only what nobody decided).
    // When the runner takes it: an email read from then on can't show it as going out, nor as gone (tellOwners).
    const takenAt = new Date();
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: "SCHEDULED", dueAt: { lte: now } },
      data: { status: "PENDING", dueAt: null, decidedById: owner.userId },
    });
    if (count === 0) {
      continue;
    }
    try {
      await call(applyCodeChangeAction, { actor: { kind: "user", userId: owner.userId }, projectId }, { id: action.id });
    } catch (error) {
      log.error("Autopilot couldn't apply a due update", { error, actionId: action.id });
      const saved = (error as { saved?: boolean | "unknown" }).saved;
      // Saved before the failure: it went. Not: it waits for the team, saying why.
      if (!saved) {
        await wait(action, error instanceof OperationError ? error.message : "Couldn't apply it", true);
        continue;
      }
      // Can't tell whether it went: it stays applied (never twice), credited to nobody, and the page says to check it.
      // ponytail: only its card and the error log say so (Home and the list count it as done); a "checked" step
      // that keeps it on Home till someone clears it, if this ever shows up outside a database outage.
      if (saved === "unknown") {
        const after = await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { payload: true } });
        await prisma.codeChangeAction.update({ where: { id: action.id }, data: { decidedById: null, payload: { ...((after.payload ?? {}) as Prisma.JsonObject), unsure: true } } });
        continue;
      }
    }
    // Autopilot's own: nobody approved it.
    const after = await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { payload: true } });
    // Marked Autopilot's own once it's done (a request emails its voters first): when (`autoAt`) says what's news to an email.
    const markedAt = new Date();
    await prisma.codeChangeAction.update({
      where: { id: action.id },
      data: { decidedById: null, payload: { ...((after.payload ?? {}) as Prisma.JsonObject), auto: true, autoAt: markedAt.toISOString() } },
    });
    applied++;
    // What customers see went out: its owners hear of it (Autopilot's email), whenever its notices were queued.
    // Told now, so a later update failing can't keep this one from them.
    if (action.kind === "RESOLVES" || action.kind === "MOVES_FORWARD" || action.kind === "ARTICLE_EDIT") {
      await tellOwners(action.codeChangeId, action.createdAt, { from: takenAt, to: new Date() });
    }
  }
  for (const codeChangeId of nowWaiting) {
    await announceWaiting(codeChangeId);
  }
  return { applied, waiting };
}

/** `code_change.ready` for a change whose update went back to waiting for the team (as saving its analysis says it), with how many wait now. */
async function announceWaiting(codeChangeId: string) {
  const change = await prisma.codeChange.findUniqueOrThrow({
    where: { id: codeChangeId },
    select: { id: true, projectId: true, repo: true, number: true, url: true, title: true, summary: true, project: { select: { slug: true } } },
  });
  const count = await prisma.codeChangeAction.count({ where: { codeChangeId, status: { in: ["PENDING", "STALE"] } } });
  const { projectId, project, ...pullRequest } = change;
  await emitEvent(projectId, "code_change.ready", {
    codeChange: { ...pullRequest, waiting: count, page: `${appUrl().origin}/app/${project.slug}/autopilot/${change.id}` },
  });
}

export const dismissCodeChangeAction = defineOperation({
  name: "codeChangeActions.dismiss",
  summary: "Dismiss a proposed action, with an optional reason (it isn't proposed again for this code change)",
  method: "POST",
  path: "/code-change-actions/{id}/dismiss",
  scope: "write",
  access: "team",
  input: z.object({ id, reason: z.string().trim().max(500).optional() }),
  example: { reason: "Only part of it; we'll say so when it's all out" },
  run: async (context, input) => {
    const action = await prisma.codeChangeAction.findFirst({ where: { id: input.id, codeChange: { projectId: context.projectId } }, select: { id: true } });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: { in: ["PENDING", "STALE"] } },
      data: { status: "DISMISSED", decidedById: actorUser(context.actor), decidedAt: new Date(), dismissReason: input.reason ?? "" },
    });
    if (count === 0) {
      throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
    }
    return { id: action.id, status: "dismissed" };
  },
});
