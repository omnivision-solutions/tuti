import { type CodeChangeActionKind, type CodeChangeActionStatus, type CodeChangeState, type Prisma, prisma } from "@tuti/db";
import { confidence, enqueue, THRESHOLDS } from "@tuti/jobs";
import { codeChangesEnabled } from "@tuti/shared";
import { z } from "zod";

import { createComment } from "./create";
import { type Actor, defineOperation, OperationError } from "./define";
import { updatePost } from "./manage";
import { postSummarySelect, projectPortal, summary, toApiStatus } from "./read";
import { call } from "./run";

/**
 * Code changes (docs/plan.md): every merged pull request, analysed into proposed actions the team
 * applies or dismisses. Applying is what changes anything customers see.
 */

const STATES: Record<CodeChangeState, string> = { ANALYSING: "analysing", READY: "ready", NOTHING_TO_DO: "nothing_to_do", FAILED: "failed" };
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
  if (action.kind !== "RESOLVES" && action.kind !== "MOVES_FORWARD" && action.kind !== "LINKS") {
    return false;
  }
  const comment = ((action.payload ?? {}) as { comment?: string }).comment ?? "";
  return action.probability >= THRESHOLDS[action.kind].likely && (action.kind !== "MOVES_FORWARD" || comment.trim() !== "");
}

/** The kinds applying can do (the rest come with their pages, docs/plan.md). */
const APPLICABLE = new Set<CodeChangeActionKind>(["LINKS", "RESOLVES", "MOVES_FORWARD"]);

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

/** The project's code changes: those with proposals waiting first, then newest first. ponytail: the latest 100; page when teams need older ones. */
export async function codeChangeList(projectId: string): Promise<CodeChangeView[]> {
  const changes = await prisma.codeChange.findMany({ where: { projectId }, orderBy: { mergedAt: "desc" }, take: 100, select: changeSelect });
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
        },
      },
    },
  });
  if (!change) {
    return null;
  }
  const portal = await projectPortal(projectId);
  return {
    ...changeView(change),
    why: change.why,
    actions: change.actions.map((action) => {
      const payload = (action.payload ?? {}) as { comment?: string };
      return {
        id: action.id,
        kind: KINDS[action.kind],
        status: ACTION_STATUSES[action.status],
        probability: action.probability,
        confidence: action.kind === "CHANGELOG_LINE" ? "likely" : confidence(action.kind, action.probability),
        /** "Apply likely" applies it (see likelyToApply). */
        applyLikely: action.status === "PENDING" && likelyToApply(action),
        reason: action.reason,
        /** The team's comment, for a post it moves forward (as proposed, or as posted once applied). */
        ...(action.kind === "MOVES_FORWARD" && { comment: payload.comment ?? "" }),
        post: action.post ? summary(action.post, portal) : null,
        decidedBy: action.decidedBy?.name ?? null,
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
    try {
      await enqueue("codeChange", { codeChangeId: change.id, force: true, pastGate: change.state === "NOTHING_TO_DO" });
    } catch {
      // Inline, the analysis itself failed (the code change says where); on Hatchet, queueing did.
      throw new OperationError(503, "unavailable", "Couldn't analyse it. Try again in a moment.");
    }
    const after = await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id }, select: changeSelect });
    return changeView(after);
  },
});

/** The person behind a call: the user, or the key's creator. */
const actorUser = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** Statuses a post moves on from to In progress when a code change moves it forward. */
const NOT_STARTED = new Set(["OPEN", "UNDER_REVIEW", "PLANNED"]);

export const applyCodeChangeAction = defineOperation({
  name: "codeChangeActions.apply",
  summary: "Apply a proposed action: link the post, complete it (its people get the shipped email), or post the team's comment on it",
  method: "POST",
  path: "/code-change-actions/{id}/apply",
  scope: "write",
  access: "team",
  input: z.object({
    id,
    /** For a post it moves forward: the comment to post, if the team changed it. */
    comment: z.string().trim().min(1).max(5_000).optional(),
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
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (!APPLICABLE.has(action.kind) || !action.post) {
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
