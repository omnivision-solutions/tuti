import { type CodeChangeActionKind, type CodeChangeActionStatus, type CodeChangeState, type PostStatus, Prisma, prisma } from "@tuti/db";
import { changelogLineOf, confidence, enqueue, setChangelogLine, THRESHOLDS, undoChangelogLine } from "@tuti/jobs";
import { codeChangesEnabled, log, planIncludes } from "@tuti/shared";
import { z } from "zod";

import { createComment } from "./create";
import { aiOrRefuse } from "./credits";
import { createArticle, deleteArticle, updateArticle } from "./docs";
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
const ACTION_STATUSES: Record<CodeChangeActionStatus, string> = { PENDING: "pending", APPLIED: "applied", DISMISSED: "dismissed", STALE: "stale", UNDONE: "undone" };

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
async function emailedOnCompletion(projectId: string, postIds: string[]): Promise<Map<string, number>> {
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

type DocsPayload = { problem?: "wrong" | "missing"; basedOn?: string | null; title?: string; content?: unknown; body?: string; before?: string };

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

export type CodeChangeView = ReturnType<typeof changeView>;

/**
 * The project's code changes: those with proposals waiting first, then newest first (`waiting`: only
 * those, as Home's Catch up lists; `paused`: only those paused for want of AI credits). ponytail: the
 * latest 100; page when teams need older ones.
 */
export async function codeChangeList(projectId: string, { waiting = false, paused = false } = {}): Promise<CodeChangeView[]> {
  const changes = await prisma.codeChange.findMany({
    where: {
      projectId,
      ...(waiting && { actions: { some: { status: { in: ["PENDING", "STALE"] } } } }),
      ...(paused && { state: "PAUSED" as const }),
    },
    orderBy: { mergedAt: "desc" },
    take: 100,
    select: changeSelect,
  });
  return changes.map(changeView).sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0));
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
    .filter((action) => action.kind === "RESOLVES" && action.status === "PENDING" && action.post && action.post.status !== "COMPLETED" && !action.post.duplicateOfId)
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
        ...(action.kind === "RESOLVES" && action.status === "PENDING" && action.post && { emails: emails.get(action.post.id) ?? 0 }),
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
        /** Approved, with what it changed recorded: Undo can put it back. */
        canUndo: action.status === "APPLIED" && undoOf(action.payload) !== null,
        decidedAt: action.decidedAt?.toISOString() ?? null,
        dismissReason: action.dismissReason,
      };
    }),
  };
}

export type CodeChangeDetail = NonNullable<Awaited<ReturnType<typeof codeChangeDetail>>>;

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
      throw new OperationError(409, "analysis_off", "Autopilot is off: turn it on in Settings → Integrations → GitHub");
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
      throw new OperationError(409, "analysis_off", "Autopilot is off: turn it on in Settings → Integrations → GitHub");
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
      // What the bullet said, for Undo to put back: as a failed try found it, if one did (it may have added the pull request since).
      const before = await changelogLineOf(projectId, action.codeChange.url);
      const tried = triedOf(action.payload);
      const undo = tried ?? { previous: before?.text ?? null, added: before === null ? ("entry" as const) : before.text === null ? ("bullet" as const) : null };
      const { count } = await prisma.codeChangeAction.updateMany({
        where: { id: action.id, status: "PENDING" },
        // Applying adds the bullet when no entry has it (and the pull request too, when none has that): Undo takes them out again.
        data: {
          status: "APPLIED",
          decidedById: actorUser(context.actor),
          decidedAt: new Date(),
          // What to undo is recorded once it's done: till then, Undo has nothing to go on.
          payload: { line, tried: undo },
        },
      });
      if (count === 0) {
        throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
      }
      try {
        const entry = await setChangelogLine(projectId, { ...action.codeChange }, line);
        await recordUndo(action.id, { line }, undo);
        return { id: action.id, kind: KINDS[action.kind], status: "applied", changelog: entry };
      } catch (error) {
        return revert(action.id, { status: "PENDING", decidedById: null, decidedAt: null, payload: { ...asObject(action.payload), tried: undo } }, error);
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
    // A failed try may have done some of it: what it recorded counts too.
    const tried = triedOf(action.payload);
    const undo: { linked: boolean; entries: string[]; status: string | null; commentId: string | null } = {
      linked: tried?.linked ?? false,
      entries: tried?.entries ?? [],
      status: tried?.status ?? null,
      commentId: null,
    };
    // Once the comment is being posted, it may be saved even if something after it fails: then the
    // action stays applied, so trying again can't post it twice.
    let posting = false;
    try {
      undo.linked ||= !(await prisma.postLink.findUnique({ where: { postId_url: { postId: post.id, url: codeChange.url } }, select: { postId: true } }));
      // Each step can run again after a failure: the link once per post, the status only from earlier ones, the comment last.
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
        undo.entries = [...new Set([...undo.entries, ...entries.map((e) => e.entryId).filter((entryId) => !had.some((h) => h.entryId === entryId))])];
        await prisma.changelogEntryPost.createMany({ data: entries.map(({ entryId }) => ({ entryId, postId: post.id })), skipDuplicates: true });
        if (post.status !== "COMPLETED") {
          undo.status ??= post.status;
          await call(updatePost, context, { number: post.number, status: toApiStatus("COMPLETED") });
        }
      }
      if (action.kind === "MOVES_FORWARD") {
        if (NOT_STARTED.has(post.status)) {
          undo.status ??= post.status;
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
        const found = await prisma.comment
          .findFirst({ where: { postId: post.id, authorId: actorUser(context.actor), createdAt: { gte: claimedAt } }, orderBy: { createdAt: "desc" }, select: { id: true } })
          .catch(() => "unknown" as const);
        const saved = found === "unknown" ? "unknown" : found !== null;
        if (saved !== false) {
          // What's known, for Undo: what came before the comment, and the comment if it was found.
          await recordUndo(action.id, { comment }, { ...undo, commentId: found === "unknown" ? null : found!.id });
          throw Object.assign(error as Error, { saved });
        }
      }
      // Not done: it's waiting again, for another try, with what this one did for Undo.
      return revert(action.id, { status: "PENDING", decidedById: null, decidedAt: null, payload: { ...asObject(action.payload), tried: undo } }, error);
    }
    // What it did is recorded as done now, not as a try.
    const done: Prisma.JsonObject = action.kind === "MOVES_FORWARD" ? { comment } : asObject(action.payload);
    delete done.tried;
    await recordUndo(action.id, done, undo);
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
      ({ content: live } = await prisma.article.findUniqueOrThrow({ where: { id: article!.id }, select: { content: true } }));
      // Saved only if the article is still the version the edit was written against (checked under the project's lock).
      await call(updateArticle, context, { slug: article!.slug, content: payload.content, publish, ...(payload.basedOn && { revision: payload.basedOn }) });
      // For Undo: the version it published (to tell whether it's been edited since) and the one before it.
      await recordUndo(action.id, payload, { revision: await newestRevision(article!.id), live, published: publish });
      return { id: action.id, kind: KINDS[action.kind], status: "applied", article: article!.slug, published: publish };
    }
    const created = await call(createArticle, context, { title: payload.title ?? "", content: payload.content });
    const draft = await prisma.article.findFirstOrThrow({ where: { projectId: context.projectId, slug: created.slug, deletedAt: null }, select: { id: true } });
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { articleId: draft.id } });
    await recordUndo(action.id, payload, { revision: await newestRevision(draft.id) });
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
              .then(async () => recordUndo(action.id, payload, { revision: await newestRevision(found.id) }))
              .catch((cause: unknown) => log.error("code change: couldn't record what to undo", { actionId: action.id, error: String(cause) })));
      }
      throw Object.assign(error as Error, { saved });
    }
    // Saved again since the check above: it's out of date now.
    const changed = error instanceof OperationError && error.code === "changed";
    return revert(
      action.id,
      { status: changed ? "STALE" : "PENDING", decidedById: null, decidedAt: null },
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
/** What a failed try did (kept while it waits again, and across an analysis again; see finish in packages/jobs): its next try records it too. */
const triedOf = (payload: Prisma.JsonValue): Undo | null => ((payload ?? {}) as { tried?: Undo }).tried ?? null;

const undoOf = (payload: Prisma.JsonValue): Undo | null => {
  const { undo, auto } = (payload ?? {}) as { undo?: Undo; auto?: boolean };
  return undo ?? (auto ? { linked: true } : null);
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
        post: { select: { id: true, number: true, status: true } },
        article: { select: { id: true, slug: true, publishedAt: true, deletedAt: true, changes: { select: { articleId: true } } } },
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (action.status !== "APPLIED") {
      throw new OperationError(409, "not_applied", "Only an approved update can be undone");
    }
    const undo = undoOf(action.payload);
    if (!undo) {
      throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it by hand");
    }
    const { article } = action;

    // Refused before anything changes, saying why.
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
        await call(deleteArticle, context, { slug: article!.slug });
      } else if (action.post) {
        const { post, codeChange } = action;
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
          await prisma.postLink.deleteMany({ where: { postId: post.id, url: codeChange.url, source: "CODE_CHANGE" } });
        }
        // Back to the status it had, if it still has the one it was moved to (leaving the shipped
        // emails still due unsent: they go only while it's Completed).
        const movedTo = action.kind === "RESOLVES" ? "COMPLETED" : "IN_PROGRESS";
        if (undo.status && post.status === movedTo) {
          await call(updatePost, context, { number: post.number, status: toApiStatus(undo.status as PostStatus) });
        }
      }
    } catch (error) {
      // Not done: it's applied again, for another try.
      await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", decidedById: action.decidedById, decidedAt: action.decidedAt } });
      throw error;
    }
    return { id: action.id, status: "undone" };
  },
});

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
