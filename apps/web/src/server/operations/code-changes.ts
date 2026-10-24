import { type CodeChangeActionKind, type CodeChangeActionStatus, type CodeChangeState, type Prisma, prisma } from "@tuti/db";
import { confidence, enqueue, setChangelogLine, THRESHOLDS } from "@tuti/jobs";
import { codeChangesEnabled } from "@tuti/shared";
import { z } from "zod";

import { createComment } from "./create";
import { aiOrRefuse } from "./credits";
import { createArticle, updateArticle } from "./docs";
import { type Actor, defineOperation, OperationError } from "./define";
import { updatePost } from "./manage";
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
const ACTION_STATUSES: Record<CodeChangeActionStatus, string> = { PENDING: "pending", APPLIED: "applied", DISMISSED: "dismissed", STALE: "stale" };

/** A feedback proposal "Apply likely" takes: above its kind's likely threshold, and for a post it moves forward, with a comment to post. */
export function likelyToApply(action: { kind: CodeChangeActionKind; probability: number; payload: Prisma.JsonValue }): boolean {
  // The changelog line only rewrites a bullet in a draft: always likely.
  if (action.kind === "CHANGELOG_LINE") {
    return true;
  }
  if (action.kind !== "RESOLVES" && action.kind !== "MOVES_FORWARD" && action.kind !== "LINKS") {
    return false;
  }
  const comment = ((action.payload ?? {}) as { comment?: string }).comment ?? "";
  return action.probability >= THRESHOLDS[action.kind].likely && (action.kind !== "MOVES_FORWARD" || comment.trim() !== "");
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
  reason: change.reason,
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

/** One code change with its proposed actions (most likely first), or null if the project has no such code change. */
export async function codeChangeDetail(projectId: string, id: string) {
  const change = await prisma.codeChange.findFirst({
    where: { id, projectId },
    select: {
      ...changeSelect,
      why: true,
      actions: {
        orderBy: { probability: "desc" },
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
          post: { select: { ...postSummarySelect, id: true } },
          article: { select: articleSelect },
        },
      },
    },
  });
  if (!change) {
    return null;
  }
  const [portal, bullet] = await Promise.all([
    projectPortal(projectId),
    prisma.changelogEntryPullRequest.findFirst({ where: { url: change.url, entry: { projectId } }, select: { entry: { select: { number: true, title: true } } } }),
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
        /** "Apply likely" applies it (see likelyToApply). */
        applyLikely: action.status === "PENDING" && likelyToApply(action),
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
        /** Who applied or dismissed it: "Tuti" for a link it applied by itself (see AUTO_LINK). */
        decidedBy: action.decidedBy?.name ?? ((payload as { auto?: boolean }).auto ? "Tuti" : null),
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
  summary: "List code changes: merged pull requests, each with what Tuti proposes (those with proposals waiting first)",
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
  summary: "Analyse a code change again; one with nothing to do is analysed past that decision (\"Analyse anyway\")",
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
      throw new OperationError(409, "analysis_off", "Code changes are off: turn them on in Settings → Integrations → GitHub");
    }
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
    "Resume every code change paused because the project was out of AI credits (\"Resume all\"): each is analysed again (`resumed`: queued, or where jobs run inline, analysed; `failed`: those whose analysis failed at once, inline); refused (402) while the project is still out",
  method: "POST",
  path: "/code-changes/resume",
  scope: "write",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { analyseCodeChanges: true } });
    if (!codeChangesEnabled() || !project.analyseCodeChanges) {
      throw new OperationError(409, "analysis_off", "Code changes are off: turn them on in Settings → Integrations → GitHub");
    }
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
      const { count } = await prisma.codeChangeAction.updateMany({
        where: { id: action.id, status: "PENDING" },
        data: { status: "APPLIED", decidedById: actorUser(context.actor), decidedAt: new Date(), payload: { line } },
      });
      if (count === 0) {
        throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
      }
      try {
        const entry = await setChangelogLine(projectId, { ...action.codeChange }, line);
        return { id: action.id, kind: KINDS[action.kind], status: "applied", changelog: entry };
      } catch (error) {
        await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "PENDING", decidedById: null, decidedAt: null, payload: (action.payload ?? {}) as Prisma.InputJsonValue } });
        throw error;
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
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: action.id, status: "PENDING" },
      data: {
        status: "APPLIED",
        decidedById: actorUser(context.actor),
        decidedAt: new Date(),
        ...(action.kind === "MOVES_FORWARD" && { payload: { comment } }),
      },
    });
    if (count === 0) {
      throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
    }
    const { codeChange, post } = action;
    // Once the comment is being posted, it may be saved even if something after it fails: then the
    // action stays applied, so trying again can't post it twice.
    let posting = false;
    try {
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
        await prisma.changelogEntryPost.createMany({ data: entries.map(({ entryId }) => ({ entryId, postId: post.id })), skipDuplicates: true });
        if (post.status !== "COMPLETED") {
          await call(updatePost, context, { number: post.number, status: toApiStatus("COMPLETED") });
        }
      }
      if (action.kind === "MOVES_FORWARD") {
        if (NOT_STARTED.has(post.status)) {
          await call(updatePost, context, { number: post.number, status: toApiStatus("IN_PROGRESS") });
        }
        posting = true;
        await call(createComment, context, { number: post.number, body: comment });
      }
    } catch (error) {
      // Refused before saving (an OperationError: the post was merged, say) or failed before the comment: not done.
      if (posting && !(error instanceof OperationError)) {
        throw error;
      }
      // Not done: it's waiting again, for another try.
      await prisma.codeChangeAction.update({
        where: { id: action.id },
        data: { status: "PENDING", decidedById: null, decidedAt: null, payload: (action.payload ?? {}) as Prisma.InputJsonValue },
      });
      throw error;
    }
    return { id: action.id, kind: KINDS[action.kind], status: "applied", post: post.number };
  },
});

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
  try {
    if (action.kind === "ARTICLE_EDIT") {
      // Saved only if the article is still the version the edit was written against (checked under the project's lock).
      await call(updateArticle, context, { slug: article!.slug, content: payload.content, publish, ...(payload.basedOn && { revision: payload.basedOn }) });
      return { id: action.id, kind: KINDS[action.kind], status: "applied", article: article!.slug, published: publish };
    }
    const created = await call(createArticle, context, { title: payload.title ?? "", content: payload.content });
    const draft = await prisma.article.findFirstOrThrow({ where: { projectId: context.projectId, slug: created.slug, deletedAt: null }, select: { id: true } });
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { articleId: draft.id } });
    return { id: action.id, kind: KINDS[action.kind], status: "applied", article: created.slug, published: false };
  } catch (error) {
    // Saved anyway (the failure came after it)? Then it stays applied, so trying again can't save it
    // twice (a second draft, say). Not saved: it's waiting again. This attempt's save is a version of
    // the article (or a new article) by whoever applies it, with the proposal's text, since the claim:
    // a teammate's save meanwhile isn't it.
    const ours = { createdAt: { gte: claimedAt }, body: payload.body ?? "" };
    const saved =
      action.kind === "ARTICLE_EDIT"
        ? (await prisma.articleRevision.count({ where: { articleId: article!.id, authorId: actorUser(context.actor), ...ours } })) > 0
        : (await prisma.article.count({ where: { projectId: context.projectId, title: payload.title ?? "", createdById: actorUser(context.actor), ...ours } })) > 0;
    if (!saved) {
      // Saved again since the check above: it's out of date now.
      const changed = error instanceof OperationError && error.code === "changed";
      await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: changed ? "STALE" : "PENDING", decidedById: null, decidedAt: null } });
      if (changed) {
        throw new OperationError(409, "stale", "The article changed since this edit was written. Analyse again to write it again, or dismiss it.");
      }
    }
    throw error;
  }
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
