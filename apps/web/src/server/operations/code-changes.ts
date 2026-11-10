import { type Doc, fromPlainText, sameDoc, toPlainText } from "@tuti/content";
import { type CodeChangeActionKind, type CodeChangeActionStatus, type CodeChangeState, type PostStatus, Prisma, prisma } from "@tuti/db";
import {
  type ArticlePlace,
  articlesViews,
  autopilotSettingsSelect,
  docOf,
  draftPlace,
  hasTeammateEdit,
  holdsForTeam,
  LIVE_EDIT,
  POST_UPDATE,
  POST_COMMENT_MAX,
  postUpdate,
  tooLong,
  schedulePost,
  newestRevision,
  scheduleArticle,
  settleWaitingEdits,
  takeOut,
  taggedEdits,
  changelogLineOf,
  COMMENT_UNSURE,
  confidence,
  emitEvent,
  enqueue,
  historySince,
  inReview,
  RUN_STALE_MS,
  lockProject,
  postsReach,
  projectEmailWaits,
  reviewPath,
  setChangelogLine,
  tellOwners,
  thresholds,
  undoChangelogLine,
  visibleConversations,
  waitsBecause,
} from "@tuti/jobs";
import { ARTICLES_FULL_WAIT, codeChangesEnabled, log, planIncludes } from "@tuti/shared";
import { z } from "zod";

import { inArticleOrder } from "@/lib/article-order";
import { outcomeOf, targetBadge } from "@/lib/autopilot-words";
import { appUrl } from "@/lib/hosts";
import { lucideIcon } from "@/lib/lucide-icons";

import { createComment } from "./create";
import { linkEntryPosts } from "./changelog";
import { aiOrRefuse } from "./credits";
import { collectionNamed, createArticle, indexArticle, keepText, publishArticleChanges, recordRevision, reorderArticle, saveArticle, updateArticle } from "./docs";
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
  return action.probability >= thresholds()[action.kind].likely && (action.kind !== "MOVES_FORWARD" || comment.trim() !== "");
}

/**
 * How many people completing each post emails (its author, voters, commenters and subscribers, past the team,
 * those who turned the project's emails off and those it emailed already; none for sample posts), by post id, as
 * postShipped does. ponytail: before its other rules (verified addresses, a private portal's readers): it can count
 * a few it won't email.
 */
export async function emailedOnCompletion(projectId: string, postIds: string[]): Promise<Map<string, number>> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, plan: true } });
  // A private portal on a plan without them is the team's only: postShipped emails nobody.
  // Nor while the project's email is paused: the resume lets what it held go.
  if (postIds.length === 0 || (project.portalAccess === "PRIVATE" && !planIncludes(project.plan, "privatePortal")) || (await projectEmailWaits(projectId))) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<{ postId: string; people: bigint }[]>`
    SELECT x."postId", COUNT(DISTINCT x."userId") AS people
    FROM (
      SELECT id AS "postId", "authorId" AS "userId" FROM post WHERE id IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "userId" FROM vote WHERE "postId" IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "authorId" FROM comment WHERE "postId" IN (${Prisma.join(postIds)})
      UNION SELECT "postId", "userId" FROM post_subscription WHERE "postId" IN (${Prisma.join(postIds)})
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM post p WHERE p.id = x."postId" AND p.sample)
      -- Only people who may see the post (postAudience): a private one's author, nobody about a Team only one or one on a
      -- board turned off.
      AND EXISTS (SELECT 1 FROM post p JOIN board b ON b.id = p."boardId" WHERE p.id = x."postId" AND NOT b.off
        AND (p.visibility = 'PUBLIC' OR (p.visibility = 'PRIVATE' AND p."authorId" = x."userId")))
      AND NOT EXISTS (SELECT 1 FROM team_member t WHERE t."projectId" = ${projectId} AND t."userId" = x."userId")
      AND NOT EXISTS (SELECT 1 FROM email_opt_out o WHERE o."projectId" = ${projectId} AND o."userId" = x."userId")
      -- Turned off in their Account: its author by "Posts I wrote", everyone else by "Posts I voted on or follow" (as postAudience).
      AND NOT EXISTS (SELECT 1 FROM email_preference ep JOIN post p ON p.id = x."postId"
        WHERE ep."projectId" = ${projectId} AND ep."userId" = x."userId"
          AND NOT (CASE WHEN p."authorId" = x."userId" THEN ep."ownPosts" ELSE ep."followedPosts" END))
      AND NOT EXISTS (SELECT 1 FROM shipped_email s WHERE s."postId" = x."postId" AND s."userId" = x."userId" AND s."sentAt" IS NOT NULL)
    GROUP BY x."postId"`;
  return new Map(rows.map((row) => [row.postId, Number(row.people)]));
}

const APPLICABLE = new Set<CodeChangeActionKind>(["LINKS", "RESOLVES", "MOVES_FORWARD", "ARTICLE_EDIT", "NEW_ARTICLE", "CHANGELOG_LINE"]);

type DocsPayload = {
  problem?: "wrong" | "missing";
  title?: string;
  content?: unknown;
  body?: string;
  before?: string;
  edited?: boolean;
  overview?: string;
  /** The edits already waiting when the overview was written (it describes them too). */
  overviewOf?: string[];
  /** A new article's: where its draft goes (NewArticlePayload). */
  place?: ArticlePlace;
};

/**
 * An article edit is saved into the article's unpublished changes as its tagged revision (`revisions`); one the
 * previous release wrote (a whole new article, not saved there) is out of date: "Write it again" writes it on top.
 */
const outdated = (action: { revisions: unknown[] }) => action.revisions.length === 0;
const STALE_EDIT = "The article changed since this edit was written. Analyse again to write it again, or dismiss it.";

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
  settings: true,
  _count: { select: { actions: { where: { ...inReview, status: { in: ["PENDING", "STALE"] } } } } },
} satisfies Prisma.CodeChangeSelect;

type ChangeRow = Prisma.CodeChangeGetPayload<{ select: typeof changeSelect }>;

/**
 * Reasons saved on paused rows that read differently now: paused for the plan while Autopilot was Pro and up (before
 * and after Code changes was renamed Autopilot); since 2026-11-01 every plan has it, and the team can resume them.
 */
const PAID_ONLY = "Autopilot was on paid plans only then.";
const RENAMED_REASONS: Record<string, string> = { "Code changes need the Pro plan.": PAID_ONLY, "Autopilot needs the Pro plan.": PAID_ONLY };

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
  /** The Advanced tuning values its analysis ran with that the project changed (by path; none before them). */
  tuned: tunedPaths(change.settings),
});

const tunedPaths = (settings: Prisma.JsonValue): string[] => {
  const tuned = (settings as { tuned?: unknown } | null)?.tuned;
  return Array.isArray(tuned) ? tuned.filter((path): path is string => typeof path === "string") : [];
};

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
        latest({ actions: { some: { ...inReview, status: { in: ["PENDING", "STALE"] } } } }, null),
        latest({ state: { in: ["ANALYSING", "FAILED", "PAUSED"] } }),
      ]).then(([queue, unread]) =>
        [...queue, ...unread.filter((change) => !queue.some((other) => other.id === change.id))].sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime()),
      )
    : await latest({
        // Waiting for the team, or going out by itself (Home shows both).
        ...(waiting && { actions: { some: { ...inReview, status: { in: ["PENDING", "STALE", "SCHEDULED"] } } } }),
        ...(paused && { state: "PAUSED" }),
      });
  const scheduled = await prisma.codeChangeAction.findMany({
    where: { codeChangeId: { in: changes.map((change) => change.id) }, ...inReview, status: "SCHEDULED" },
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

export type WaitingUpdates = {
  /** Each update waiting (out of date ones too), most likely first: the list's chips, each opening its first. */
  updates: { id: string; kind: string }[];
  /** How sure Autopilot is of them on average (the changelog line isn't a guess), likely by their kinds' thresholds on average. */
  sure: { percent: number; likely: boolean } | null;
  /** What approving the change from the list approves: those its page ticks as it opens, with how many people each emails. */
  likely: { id: string; kind: string; emails?: number }[];
};

/** For Autopilot's Activity, the updates waiting on each of the project's changes (`changeIds`), by change id. */
export async function waitingUpdates(projectId: string, changeIds: string[]): Promise<Map<string, WaitingUpdates>> {
  const byChange = await groupWaiting(projectId, { codeChangeId: { in: changeIds } }, (action) => action.codeChangeId);
  return new Map(changeIds.map((id) => [id, byChange.get(id) ?? { updates: [], sure: null, likely: [] }]));
}

/** The updates waiting for the team (`where`), grouped by `keyOf` (a change, a post or an article): what the list shows of each. */
async function groupWaiting(
  projectId: string,
  where: Prisma.CodeChangeActionWhereInput,
  keyOf: (action: { id: string; codeChangeId: string | null; kind: CodeChangeActionKind; postId: string | null; articleId: string | null }) => string | null,
): Promise<Map<string, WaitingUpdates>> {
  const actions = await prisma.codeChangeAction.findMany({
    where: { ...where, ...inReview, ...ofProject(projectId), status: { in: ["PENDING", "STALE"] } },
    orderBy: [{ probability: "desc" }, { kind: "desc" }, { id: "asc" }],
    select: {
      id: true,
      codeChangeId: true,
      kind: true,
      status: true,
      probability: true,
      payload: true,
      waitReason: true,
      postId: true,
      articleId: true,
      post: { select: { id: true, status: true, duplicateOfId: true } },
      article: { select: articleSelect },
      revisions: { select: { id: true }, take: 1 },
    },
  });
  // As the page ticks them (actionViews' applyLikely), less one a teammate stopped (its page doesn't tick it either).
  // An article's edits once (approving one publishes them all), and none where a teammate's edit would go out with
  // them: only its page, which asks first, approves those. Nor one on a draft: only its review approves those
  // (`reviewedAs: "draft"`), never the list.
  const sure = actions.filter(
    (action) =>
      action.status === "PENDING" &&
      !(action.kind === "ARTICLE_EDIT" && (outdated(action) || (action.article && !action.article.publishedAt))) &&
      !holdsForTeam(action.waitReason) &&
      likelyToApply(action),
  );
  // The version each publishes, read before checking it for a teammate's edit: a save after the check moves it, and the
  // approval pinned to it does nothing.
  const versions = new Map(await Promise.all([...new Set(sure.flatMap((action) => (action.kind === "ARTICLE_EDIT" ? [action.articleId!] : [])))].map(async (id) => [id, await newestRevision(id)] as const)));
  const held = new Set(
    (
      await Promise.all(
        [...new Set(sure.flatMap((action) => (action.kind === "ARTICLE_EDIT" && action.articleId ? [action.articleId] : [])))].map(async (id) =>
          (await hasTeammateEdit(id)) ? [id] : [],
        ),
      )
    ).flat(),
  );
  // And only when every edit waiting on it is one of them (approving publishes them all): pinned to the version listed.
  // Read again after the versions, so one that landed between the list and them (in the version, not listed) counts.
  const sureIds = new Set(sure.map((action) => action.id));
  const unsure = new Set(
    (
      await prisma.codeChangeAction.findMany({
        where: { articleId: { in: [...versions.keys()] }, kind: "ARTICLE_EDIT", status: { in: ["PENDING", "STALE"] }, ...ofProject(projectId) },
        select: { id: true, articleId: true },
      })
    ).flatMap((action) => (sureIds.has(action.id) ? [] : [action.articleId])),
  );
  // A post's update once too (approving a part approves all of it), only when each part waiting is one of them: pinned
  // to its version, read before the parts are checked.
  const posts = new Map(
    await Promise.all([...new Set(sure.flatMap((action) => (POST_UPDATE.includes(action.kind) ? [action.postId!] : [])))].map(async (id) => [id, await postUpdate(id)] as const)),
  );
  const likely = sure.filter((action, i) =>
    action.kind === "ARTICLE_EDIT"
      ? !held.has(action.articleId!) && !unsure.has(action.articleId) && sure.findIndex((other) => other.kind === "ARTICLE_EDIT" && other.articleId === action.articleId) === i
      : !POST_UPDATE.includes(action.kind) ||
        (posts.get(action.postId!)!.parts.every((part) => part.status === "SCHEDULED" || sureIds.has(part.id)) &&
          // Not one that can't be approved as it is (its comment too long to post), as its page doesn't tick it.
          posts.get(action.postId!)!.comment.length <= POST_COMMENT_MAX &&
          sure.findIndex((other) => POST_UPDATE.includes(other.kind) && other.postId === action.postId) === i),
  );
  // Completing: a post's update with a completion in it.
  const completes = (action: (typeof actions)[number]) => action.kind === "RESOLVES" || (POST_UPDATE.includes(action.kind) && Boolean(posts.get(action.postId!)?.completes));
  const emails = await emailedOnCompletion(
    projectId,
    likely.flatMap((action) => (completes(action) && action.post && action.post.status !== "COMPLETED" && !action.post.duplicateOfId ? [action.post.id] : [])),
  );
  const groups = new Map<string, typeof actions>();
  for (const action of actions) {
    const key = keyOf(action);
    if (key !== null) {
      groups.set(key, [...(groups.get(key) ?? []), action]);
    }
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return new Map(
    [...groups].map(([key, mine]) => {
      const guesses = mine.flatMap((action) => (action.kind === "CHANGELOG_LINE" ? [] : [{ kind: action.kind, probability: action.probability }]));
      return [
        key,
        {
          updates: mine.map((action) => ({ id: action.id, kind: KINDS[action.kind] })),
          sure:
            guesses.length === 0
              ? null
              : {
                  // Rounded down, as each update's (see sureness).
                  percent: Math.floor(mean(guesses.map((guess) => guess.probability)) * 100 + 1e-9),
                  likely: mean(guesses.map((guess) => guess.probability)) >= mean(guesses.map((guess) => thresholds()[guess.kind].likely)),
                },
          likely: likely
            .filter((action) => mine.includes(action))
            .map((action) => ({
              id: action.id,
              // A post's part: its post's update (completing, or a progress update), for the version listed.
              kind: KINDS[POST_UPDATE.includes(action.kind) ? (completes(action) ? "RESOLVES" : "MOVES_FORWARD") : action.kind],
              ...(POST_UPDATE.includes(action.kind) && { revision: posts.get(action.postId!)!.version }),
              ...(completes(action) && action.post && { emails: emails.get(action.post.id) ?? 0 }),
              // An article's: the version it publishes (a save since refuses it).
              ...(action.kind === "ARTICLE_EDIT" && versions.get(action.articleId!) && { revision: versions.get(action.articleId!)! }),
            })),
        },
      ];
    }),
  );
}

/** The project's updates: its pull requests', and its Verify runs' fixes (which have no pull request). */
export const ofProject = (projectId: string) =>
  ({ AND: [{ OR: [{ codeChange: { projectId } }, { verification: { projectId } }] }] }) satisfies Prisma.CodeChangeActionWhereInput;

/** An update as the review pages read it (with its pull request's id). */
const actionSelect = {
  id: true,
  codeChangeId: true,
  createdAt: true,
  kind: true,
  status: true,
  probability: true,
  reason: true,
  payload: true,
  decidedAt: true,
  dismissReason: true,
  dueAt: true,
  waitReason: true,
  postId: true,
  articleId: true,
  decidedBy: { select: { name: true } },
  post: { select: { ...postSummarySelect, id: true, duplicateOfId: true } },
  article: { select: articleSelect },
  // An article edit's tagged revision (none: the previous release wrote it).
  revisions: { select: { id: true, basedOnId: true }, take: 1 },
} satisfies Prisma.CodeChangeActionSelect;

type ActionRow = Prisma.CodeChangeActionGetPayload<{ select: typeof actionSelect }>;

/** Most likely first; ties keep one order: by kind, then id. */
const actionOrder = [{ probability: "desc" }, { kind: "desc" }, { id: "asc" }] satisfies Prisma.CodeChangeActionOrderByWithRelationInput[];

/** Updates as a review page shows them: what each does, how many it emails, whether Undo can put it back. */
async function actionViews(projectId: string, actions: ActionRow[]) {
  // Approving completes (and emails about) only a post not completed yet, nor merged into another.
  const completing = actions
    // Waiting for the team, or going out by itself: both email when they go.
    .filter(
      (action) =>
        action.kind === "RESOLVES" && (action.status === "PENDING" || action.status === "SCHEDULED") && action.post && action.post.status !== "COMPLETED" && !action.post.duplicateOfId,
    )
    .map((action) => action.post!.id);
  // For Undo to say first: those already emailed that it shipped, since it was approved (they can't be unemailed).
  const sent = new Map(
    await Promise.all(
      actions
        .filter((action) => action.kind === "RESOLVES" && action.status === "APPLIED" && action.post && action.decidedAt)
        .map(async (action) => [action.id, await prisma.shippedEmail.count({ where: { postId: action.post!.id, sentAt: { not: null }, claimedAt: { gte: action.decidedAt! } } })] as const),
    ),
  );
  const [portal, emails, made, places] = await Promise.all([
    projectPortal(projectId),
    emailedOnCompletion(projectId, completing),
    // Approved new articles' drafts: the collection approving made, which Undo removes with it (as it was made, with
    // nothing else in it), by name.
    Promise.all(
      actions.map(async (action) => {
        const undo = action.kind === "NEW_ARTICLE" && action.status === "APPLIED" ? undoOf(action.payload, action.kind) : null;
        return undo?.collection && undo.collectionAt
          ? ((await prisma.collection.findFirst({ where: asMade(undo.collection, undo.collectionAt, action.articleId ?? undefined), select: { name: true } }))?.name ?? null)
          : null;
      }),
    ),
    // Where each new article's draft goes, as it stands now.
    Promise.all(actions.map((action) => (action.kind === "NEW_ARTICLE" && action.status !== "APPLIED" ? draftPlace(projectId, ((action.payload ?? {}) as DocsPayload).place) : null))),
  ]);
  return actions.map((action, i) => {
    const place = places[i];
    const payload = (action.payload ?? {}) as { comment?: string } & DocsPayload;
    const stale = action.kind === "ARTICLE_EDIT" && action.status === "PENDING" && outdated(action);
    const tagged = action.revisions[0] ?? null;
    return {
      id: action.id,
      /** The pull request it's from. */
      codeChangeId: action.codeChangeId,
      /** When it was proposed (an article's edits are layered in this order). */
      createdAt: action.createdAt.toISOString(),
      /** Where it's reviewed under Autopilot (`feedback/<post id>`, `articles/<id>`). */
      reviewPath: reviewPath(action),
      kind: KINDS[action.kind],
      status: stale ? "stale" : ACTION_STATUSES[action.status],
      probability: action.probability,
      confidence: action.kind === "CHANGELOG_LINE" ? "likely" : confidence(action.kind, action.probability),
      /** Ticked as the review page opens (see likelyToApply). */
      applyLikely: !stale && action.status === "PENDING" && likelyToApply(action),
      /** For a post it completed: how many it emailed that it shipped (Undo can't take those back). */
      ...(sent.has(action.id) && { emailed: sent.get(action.id)! }),
      /** For a post it completes: how many people completing it emails. */
      ...(action.kind === "RESOLVES" && (action.status === "PENDING" || action.status === "SCHEDULED") && action.post && { emails: emails.get(action.post.id) ?? 0 }),
      reason: action.reason,
      /** The team's comment, for a post it moves forward (as proposed, or as posted once applied; one completing it posted with it too). */
      ...((action.kind === "MOVES_FORWARD" || (action.kind === "RESOLVES" && payload.comment !== undefined)) && { comment: payload.comment ?? "" }),
      post: action.post ? summary(action.post, portal) : null,
      /** The article it edits (or, for a new article once its draft exists, the draft). */
      article: action.article && {
        slug: action.article.slug,
        title: action.article.title,
        collection: action.article.collection?.name ?? null,
        /** A draft: approving an edit keeps it in the draft, which the team publishes from Docs. */
        draft: !action.article.publishedAt,
      },
      /** An article edit's text before and after, and a new article's title and text (plain text). */
      ...(action.kind === "ARTICLE_EDIT" && { problem: payload.problem ?? "wrong", before: payload.before ?? "", after: payload.body ?? "" }),
      /** An article edit's own change: its tagged revision and the one it was written on. */
      ...(tagged && { revision: tagged.id, basedOn: tagged.basedOnId }),
      ...(action.kind === "NEW_ARTICLE" && {
        title: payload.title ?? "",
        after: payload.body ?? "",
        /**
         * Where approving saves its draft (null: in no collection): an existing `collection`, or a `newCollection`
         * approving makes (hidden from readers until an article in it is published); in it, after the article
         * `afterArticle`, or `first`, else last. A collection deleted since is none; an article deleted or moved since, last.
         */
        place: place && {
          collection: place.collection && { slug: place.collection.slug, name: place.collection.name, icon: place.collection.icon },
          // The icon as approving sets it: one Lucide doesn't have is dropped.
          newCollection: place.newCollection && { ...place.newCollection, icon: lucideIcon(place.newCollection.icon) ? place.newCollection.icon : null },
          afterArticle: place.after && { slug: place.after.slug, title: place.after.title },
          first: place.first,
        },
      }),
      /** The pull request's line in the changelog (as proposed, or as written once applied). */
      ...(action.kind === "CHANGELOG_LINE" && { line: (payload as { line?: string }).line ?? "" }),
      /** Who applied or dismissed it: "Autopilot" for a link it applied by itself (see `decisions.autoLink`, and `auto`). */
      // Autopilot's only while what it applied stands: undone (its flag stays), whoever undid it, or nobody known.
      decidedBy: action.decidedBy?.name ?? ((payload as { auto?: boolean }).auto && action.status === "APPLIED" ? "Autopilot" : null),
      /** Applied by Autopilot itself, nobody approving it. */
      auto: Boolean((payload as { auto?: boolean }).auto),
      /** Autopilot went to apply it by itself and couldn't tell whether it went out: someone should check. */
      unsure: Boolean((payload as { unsure?: boolean }).unsure),
      /** An article edit approved into the article's unpublished changes, not published (the previous release could). */
      unpublished: undoOf(action.payload, action.kind)?.published === false,
      /** Approved, with what it changed recorded: Undo can put it back. */
      // An edit kept unpublished is finished (or discarded) in the editor: no Undo for it.
      // A tagged edit is taken out by section.
      canUndo: action.status === "APPLIED" && (tagged !== null || (undoOf(action.payload, action.kind) !== null && undoOf(action.payload, action.kind)?.published !== false)),
      /** A new article's draft: the collection approving made, by name, which Undo removes too (as it was made, nothing else in it). */
      ...(made[i] && { undoRemovesCollection: made[i] }),
      /** Undo puts the post's status back (applying moved it): a completed post's shipped emails still due won't go. */
      putsBackStatus: Boolean(undoOf(action.payload, action.kind)?.status),
      /** A post's update applied as one, from several pull requests: its parts (this one among them), which Undo puts back together. */
      ...(undoOf(action.payload, action.kind)?.together && { together: undoOf(action.payload, action.kind)!.together! }),
      decidedAt: action.decidedAt?.toISOString() ?? null,
      dismissReason: action.dismissReason,
      /** A scheduled update: when it goes out by itself (Publish now, Stop). */
      dueAt: action.status === "SCHEDULED" ? (action.dueAt?.toISOString() ?? null) : null,
      /** One someone stopped (waiting, "Stopped by …"): when it would have gone out by itself. */
      wouldHaveGoneOutAt: action.status === "PENDING" && action.waitReason?.startsWith("Stopped by") ? (action.dueAt?.toISOString() ?? null) : null,
      /** Why it waits for the team after all (it stopped qualifying, or someone stopped it). */
      waitReason: action.waitReason,
    };
  });
}

/** One code change with its proposed actions (most likely first; ties keep one order: by kind, then id), or null if the project has no such code change. */
export async function codeChangeDetail(projectId: string, id: string) {
  const change = await prisma.codeChange.findFirst({
    where: { id, projectId },
    select: { ...changeSelect, why: true, actions: { orderBy: actionOrder, select: actionSelect } },
  });
  if (!change) {
    return null;
  }
  const [bullet, actions] = await Promise.all([
    prisma.changelogEntryPullRequest.findFirst({ where: { url: change.url, entry: { projectId } }, select: { entry: { select: { number: true, title: true } } } }),
    actionViews(projectId, change.actions),
  ]);
  return {
    ...changeView(change),
    why: change.why,
    /** The changelog entry with the pull request's bullet, if one has it. */
    changelog: bullet?.entry ?? null,
    actions,
  };
}

export type CodeChangeDetail = NonNullable<Awaited<ReturnType<typeof codeChangeDetail>>>;

/** Updates waiting for the team or going out by themselves (Autopilot's To review), and those decided (Reviewed). */
const WAITS: CodeChangeActionStatus[] = ["PENDING", "STALE", "SCHEDULED"];
const DECIDED: CodeChangeActionStatus[] = ["APPLIED", "DISMISSED", "UNDONE"];

/**
 * How many posts and articles each project has to review (Autopilot's To review: those with updates waiting for the
 * team or going out by themselves, by reviewPath), sample content left out as Home leaves it out: the sidebar's count,
 * and Home's. Counted in the database: the sidebar asks on every page.
 */
export async function toReviewCounts(projectIds: string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  // Each update's project through its pull request or its Verify run, each half from that table's project index.
  // inReview: no changelog line, nor a link still waiting.
  const waits = Prisma.sql`a.status IN ('PENDING', 'STALE', 'SCHEDULED') AND a.kind NOT IN ('CHANGELOG_LINE', 'LINKS')`;
  const path = Prisma.sql`CASE WHEN a."postId" IS NOT NULL THEN 'feedback/' || a."postId"
    WHEN a."articleId" IS NOT NULL THEN 'articles/' || a."articleId"
    WHEN a.kind = 'NEW_ARTICLE' THEN 'articles/' || a.id END`;
  const notSample = Prisma.sql`LEFT JOIN post p ON p.id = a."postId" LEFT JOIN article r ON r.id = a."articleId"`;
  const ids = Prisma.join(projectIds);
  const rows = await prisma.$queryRaw<{ projectId: string; count: number }[]>`
    SELECT x."projectId", COUNT(DISTINCT x.path)::int AS count FROM (
      SELECT c."projectId", ${path} AS path FROM code_change c JOIN code_change_action a ON a."codeChangeId" = c.id ${notSample}
      WHERE c."projectId" IN (${ids}) AND ${waits} AND NOT COALESCE(p.sample, r.sample, false)
      UNION ALL
      SELECT v."projectId", ${path} AS path FROM article_verification v JOIN code_change_action a ON a."verificationId" = v.id ${notSample}
      WHERE v."projectId" IN (${ids}) AND ${waits} AND NOT COALESCE(p.sample, r.sample, false)
    ) x
    WHERE x.path IS NOT NULL
    GROUP BY x."projectId"`;
  return new Map(rows.map((row) => [row.projectId, row.count]));
}

/** A pull request as its chip shows it. */
const pullRequestSelect = { id: true, repo: true, number: true, url: true, title: true, author: true, mergedAt: true } satisfies Prisma.CodeChangeSelect;
const pullRequestView = (pr: Prisma.CodeChangeGetPayload<{ select: typeof pullRequestSelect }>) => ({ ...pr, mergedAt: pr.mergedAt.toISOString() });
export type PullRequestView = ReturnType<typeof pullRequestView>;

/** Each pull request once, the latest merged first (a Verify fix has none). */
const pullRequestsOf = (rows: { codeChange: Prisma.CodeChangeGetPayload<{ select: typeof pullRequestSelect }> | null }[]) =>
  [...new Map(rows.flatMap((row) => (row.codeChange ? [[row.codeChange.id, row.codeChange] as const] : []))).values()].sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime()).map(pullRequestView);

/** How the analysis named what a new article's update drafts, before its draft exists. */
const titleOf = (row: { post: { title: string } | null; article: { title: string } | null; payload: Prisma.JsonValue }) =>
  row.post?.title ?? row.article?.title ?? ((row.payload ?? {}) as { title?: string }).title ?? "";

/**
 * Autopilot's list by what it updates: the posts (Feedback) and articles (Help center: edits, and new articles' drafts)
 * with updates waiting for the team or going out by themselves, the ones that reach the most people first (a post's
 * author, voters, commenters and subscribers; an article's views in 30 days). `decided`: those whose updates were all
 * decided, the latest first. ponytail: the latest 100 decided; page when teams need older ones.
 */
export async function autopilotTargets(projectId: string, { decided = false } = {}) {
  const rows = await prisma.codeChangeAction.findMany({
    where: { ...inReview, ...ofProject(projectId), status: { in: decided ? DECIDED : WAITS } },
    orderBy: decided ? [{ decidedAt: "desc" }, { id: "asc" }] : [{ dueAt: "asc" }, { id: "asc" }],
    // Enough for the latest 100 decided posts and articles, most with an update or two.
    ...(decided && { take: 500 }),
    select: {
      id: true,
      kind: true,
      status: true,
      createdAt: true,
      dueAt: true,
      waitReason: true,
      payload: true,
      postId: true,
      articleId: true,
      decidedAt: true,
      decidedBy: { select: { name: true } },
      post: { select: { title: true, sample: true, board: { select: { id: true, name: true } } } },
      article: { select: { title: true, sample: true, collection: { select: { id: true, name: true, icon: true } } } },
      codeChange: { select: pullRequestSelect },
    },
  });
  // Decided, those with something waiting too are under To review.
  const waitingPaths = decided
    ? new Set(
        (
          await prisma.codeChangeAction.findMany({
            where: { ...inReview, ...ofProject(projectId), status: { in: WAITS } },
            select: { id: true, kind: true, postId: true, articleId: true },
          })
        ).map(reviewPath),
      )
    : new Set<string | null>();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const path = reviewPath(row);
    if (path && !waitingPaths.has(path)) {
      groups.set(path, [...(groups.get(path) ?? []), row]);
    }
  }
  const listed = [...groups].slice(0, decided ? 100 : undefined);
  const [reach, views, picks] = await Promise.all([
    postsReach([...new Set(listed.flatMap(([, mine]) => (mine[0]!.postId ? [mine[0]!.postId] : [])))]),
    articlesViews([...new Set(listed.flatMap(([, mine]) => (mine[0]!.articleId && !mine[0]!.postId ? [mine[0]!.articleId] : [])))]),
    decided ? new Map<string, WaitingUpdates>() : groupWaiting(projectId, { id: { in: rows.map((row) => row.id) } }, reviewPath),
  ]);
  const targets = listed.map(([path, mine]) => {
    const first = mine[0]!;
    const scheduled = mine.filter((row) => row.status === "SCHEDULED");
    return {
      /** Its review's path under Autopilot: `feedback/<post id>`, or `articles/<article id>` (a new article's update id until its draft exists). */
      path,
      section: first.postId ? ("feedback" as const) : ("help_center" as const),
      title: titleOf(first),
      /** Where it is: a post's board, an article's collection (none for one in no collection, or a new article's draft). */
      group: first.post ? { ...first.post.board, icon: null } : (mine.find((row) => row.article)?.article?.collection ?? null),
      // What it does: what waits or was applied, not what the team dismissed or undid (none, when that's all).
      badge: targetBadge(mine.filter((row) => row.status !== "DISMISSED" && row.status !== "UNDONE").map((row) => KINDS[row.kind])),
      /**
       * Decided: what became of it (`completed`, `in_progress`, `published`, `drafted`, `linked`, `dismissed` or
       * `undone`), who decided it ("Approved by Olive", "Published by Autopilot") and when. Null while something waits.
       */
      outcome: decided
        ? (() => {
            const decision = outcomeOf(
              mine.map((row) => ({
                kind: KINDS[row.kind],
                status: ACTION_STATUSES[row.status],
                auto: Boolean((row.payload as { auto?: boolean } | null)?.auto),
                unpublished: undoOf(row.payload, row.kind)?.published === false,
                unsure: Boolean((row.payload as { unsure?: boolean } | null)?.unsure),
                decidedBy: row.decidedBy?.name ?? null,
                decidedAt: row.decidedAt?.toISOString() ?? null,
              })),
            );
            return decision && { outcome: decision.outcome, line: decision.line, at: decision.by.decidedAt };
          })()
        : null,
      pullRequests: pullRequestsOf(mine),
      /** On sample content (Home leaves it out). */
      sample: Boolean(first.post?.sample ?? mine.find((row) => row.article)?.article?.sample),
      /** When its first update still here was suggested (Home's rows say how long it's waited). */
      since: new Date(Math.min(...mine.map((row) => row.createdAt.getTime()))).toISOString(),
      /** How many people it reaches: a post's people, an article's views in 30 days. */
      reach: first.postId ? (reach.get(first.postId) ?? 0) : first.articleId ? (views.get(first.articleId) ?? 0) : 0,
      /** Updates on it waiting for the team (not those going out by themselves). */
      waiting: mine.filter((row) => row.status === "PENDING" || row.status === "STALE").length,
      /** Who stopped one going out by itself ("Stopped by Olive"), so it waits: none when nobody did. */
      stopped: mine.find((row) => row.status === "PENDING" && row.waitReason?.startsWith("Stopped by"))?.waitReason ?? null,
      /** Updates going out by themselves (Publish now, Stop), and when the first goes. */
      scheduled: scheduled.map((row) => row.id),
      nextDueAt: scheduled[0]?.dueAt?.toISOString() ?? null,
      /** How sure Autopilot is of those waiting, on average, and what approving it from the list approves. */
      sure: picks.get(path)?.sure ?? null,
      likely: picks.get(path)?.likely ?? [],
    };
  });
  // Waiting: the ones that reach the most first (ties, the oldest update first). Decided: the latest first, as read.
  const ordered = decided ? targets : targets.map((target, i) => ({ target, i })).sort((a, b) => b.target.reach - a.target.reach || a.i - b.i).map(({ target }) => target);
  return { feedback: ordered.filter((target) => target.section === "feedback"), helpCenter: ordered.filter((target) => target.section === "help_center") };
}

/**
 * Whether an article's unpublished changes change it as readers see it (its title or text; all of it, unpublished).
 * A draft's edits are in its text: they show.
 */
async function changesReaders(articleId: string) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { title: true, body: true, content: true, publishedAt: true, changes: { select: { title: true, body: true, content: true } } },
  });
  const doc = (version: { body: string; content: unknown }) => (version.content as Doc | null) ?? fromPlainText(version.body);
  return !!article && (!article.publishedAt || (!!article.changes && (article.changes.title !== article.title || !sameDoc(doc(article.changes), doc(article)))));
}

export type AutopilotTarget = Awaited<ReturnType<typeof autopilotTargets>>["feedback"][number];

/**
 * A post's or an article's review (`type`: feedback or articles; `id`: the post's, or the article's, or a new article's
 * update's until its draft exists): every update of every pull request on it, waiting or decided, and the pull requests
 * behind those waiting (all of them, once none waits). Null if the project has none on it.
 */
export async function targetReview(projectId: string, type: "feedback" | "articles", id: string) {
  // The version Approve publishes, read before what's shown: an edit landing after it moves it, so the approval does
  // nothing (never one that publishes an edit the page didn't show). A new article's draft has none yet.
  const pinned = type === "articles" ? await newestRevision(id) : null;
  // A post's update, likewise: what Approve applies, read before its parts are shown.
  const whole = type === "feedback" ? await postUpdate(id) : null;
  const rows = await prisma.codeChangeAction.findMany({
    where: { ...inReview, ...ofProject(projectId), ...(type === "feedback" ? { postId: id } : { OR: [{ articleId: id }, { id, kind: "NEW_ARTICLE" }] }) },
    orderBy: actionOrder,
    select: {
      ...actionSelect,
      codeChange: { select: { ...pullRequestSelect, summary: true, why: true, state: true, reason: true, updatedAt: true } },
      verification: { select: { id: true, repo: true, commit: true, createdAt: true } },
    },
  });
  if (rows.length === 0) {
    return null;
  }
  const waiting = rows.filter((row) => WAITS.includes(row.status));
  const actions = await actionViews(projectId, rows);
  const articleId = rows.find((row) => row.articleId)?.articleId ?? null;
  const [asked, also] = await Promise.all([type === "feedback" ? whatTheyAsked(projectId, id) : null, alsoFrom(`${type}/${id}`, waiting)]);
  // The edits saved into its changes, the newest last: the overview is the newest one's (written knowing those before it).
  const edits = waiting.filter((row) => row.kind === "ARTICLE_EDIT" && row.revisions.length > 0).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    type,
    title: titleOf(rows[0]!),
    /** An article's: its newest revision (what Approve publishes: `revision` in codeChangeActions.apply), whether its unpublished changes hold a teammate's edit too, and what its waiting edits change. */
    ...(type === "articles" &&
      articleId && {
        articleId,
        revision: articleId === id ? pinned : await newestRevision(articleId),
        teammateEdit: await hasTeammateEdit(articleId),
        changesReaders: await changesReaders(articleId),
        /** Its waiting edits that are out of date (written on an earlier version, so not in its unpublished changes): nothing of them shows until they're written again. */
        outOfDate: actions.filter((action) => action.status === "stale").map((action) => action.id),
        /**
         * Those of them being written again: their pull request analysed again (queued, or under way), not for longer
         * than a run can take (RUN_STALE_MS, as Verify's): one whose job died is offered to write again.
         */
        writing: actions
          .filter((action, i) => action.status === "stale" && rows[i]!.codeChange?.state === "ANALYSING" && Date.now() - rows[i]!.codeChange!.updatedAt.getTime() < RUN_STALE_MS)
          .map((action) => action.id),
        /** Why their pull request's last analysis failed, each once: one written again that failed says so. */
        writeFailed: [...new Set(rows.flatMap((row, i) => (actions[i]!.status === "stale" && row.codeChange?.state === "FAILED" && row.codeChange.reason ? [row.codeChange.reason] : [])))],
        // The newest edit's, while the edits under it are exactly those it was written with; else none (each edit's
        // reason is in its chip, never joined here).
        overview: (() => {
          const newest = edits.at(-1);
          const { overview = "", overviewOf } = (newest?.payload ?? {}) as DocsPayload;
          const under = edits.slice(0, -1).map((edit) => edit.id);
          const covers = overviewOf === undefined || (overviewOf.length === under.length && overviewOf.every((other) => under.includes(other)));
          // One an earlier release stored as the reasons joined (a Verify fix's, or with none from the model) isn't one.
          const joined = newest?.verification || overview === edits.map((edit) => edit.reason).filter(Boolean).join(" ");
          return covers && !joined ? overview : "";
        })(),
      }),
    /**
     * A post's update waiting (docs/plan.md, V4): its parts (each pull request's update, the first merged first), one status
     * change (`kind`: resolves or moves_forward) with one comment (theirs joined), and its version (`revision` in
     * codeChangeActions.apply: approving any part approves all of it, only as reviewed). Waiting for the team while a
     * part does; ticked as the page opens when each part would be.
     */
    update:
      whole && whole.parts.length > 0
        ? (() => {
            const parts = actions.filter((action) => whole.parts.some((part) => part.id === action.id));
            return {
              parts: whole.parts.map((part) => part.id),
              revision: whole.version,
              kind: whole.completes ? ("resolves" as const) : ("moves_forward" as const),
              comment: whole.comment,
              status: whole.parts.some((part) => part.status === "PENDING") ? ("pending" as const) : ("scheduled" as const),
              // Not one that can't be approved as it is (its comment too long to post): it opens unticked.
              applyLikely:
                parts.every((part) => part.status === "scheduled" || part.applyLikely) &&
                (whole.completes || whole.comment.trim() !== "") &&
                whole.comment.length <= POST_COMMENT_MAX,
              emails: parts.find((part) => part.kind === "resolves")?.emails ?? 0,
              /** Why it waits for the team as it is, whatever its parts say: its comment too long to post. */
              waitReason: whole.comment.length > POST_COMMENT_MAX ? tooLong(whole.comment) : null,
            };
          })()
        : null,
    /** How many it reaches now: a post's people (author, voters, commenters, subscribers), an article's views in 30 days. */
    reach:
      type === "feedback"
        ? ((await postsReach([id])).get(id) ?? 0)
        : articleId
          ? ((await articlesViews([articleId])).get(articleId) ?? 0)
          : null,
    /** A post's: what its users asked (its description's first lines), its first voters, and its Inbox conversations. */
    asked,
    /** What else the pull requests behind its waiting updates update that still waits: each with its review's `path`. */
    also,
    /** The post (feedback), or the article (or nothing yet, for a new article's draft not written). */
    post: actions[0]!.post,
    article: actions.find((action) => action.article)?.article ?? null,
    pullRequests: pullRequestsOf(waiting.length > 0 ? waiting : rows),
    /** What each pull request changed for users, and why Autopilot suggests its updates. */
    changes: pullRequestsOf(rows).map((pr) => {
      const change = rows.find((row) => row.codeChange?.id === pr.id)!.codeChange!;
      return { ...pr, summary: change.summary, why: change.why };
    }),
    /** Each with its pull request's number, or for a Verify fix (`number` null) the run that wrote it. */
    actions: actions.map((action, i) => ({
      ...action,
      number: rows[i]!.codeChange?.number ?? null,
      verification: rows[i]!.verification && { ...rows[i]!.verification!, createdAt: rows[i]!.verification!.createdAt.toISOString() },
    })),
  };
}

export type TargetReview = NonNullable<Awaited<ReturnType<typeof targetReview>>>;

/** How much of a post's description its review quotes: its first lines, cut short. */
const ASKED_LINES = 3;
const ASKED_CHARS = 280;

/** How many of a post's Inbox conversations its review links (it says how many in all). */
const ASKED_CONVERSATIONS = 3;

/**
 * What a post's users asked, for its review: its description's first lines, its first voters (of how many) and its
 * Inbox conversations, as the post's page lists them (no spam, nothing past the plan's history), the latest first.
 */
async function whatTheyAsked(projectId: string, postId: string) {
  const linked = { spam: false, AND: [visibleConversations(await historySince(projectId))] };
  // Scoped to the project itself, not only through the review's own lookup.
  const post = await prisma.post.findFirst({
    where: { id: postId, projectId },
    select: {
      body: true,
      voteCount: true,
      votes: { orderBy: [{ createdAt: "asc" }, { userId: "asc" }], take: 4, select: { user: { select: { id: true, name: true, image: true } } } },
      _count: { select: { conversations: { where: { conversation: linked } } } },
      conversations: { where: { conversation: linked }, orderBy: { createdAt: "desc" }, take: ASKED_CONVERSATIONS, select: { conversation: { select: { number: true, subject: true } } } },
    },
  });
  if (!post) {
    return null;
  }
  const lines = post.body.split("\n").map((line) => line.trim()).filter(Boolean);
  const text = lines.slice(0, ASKED_LINES).join("\n");
  return {
    excerpt: text.length > ASKED_CHARS ? `${text.slice(0, ASKED_CHARS).trimEnd()}…` : `${text}${lines.length > ASKED_LINES ? "…" : ""}`,
    voters: post.votes.map((vote) => vote.user),
    voteCount: post.voteCount,
    conversations: post.conversations.map((link) => link.conversation),
    conversationCount: post._count.conversations,
  };
}

/** The updates still waiting elsewhere from the pull requests behind `waiting` (on the review at `path`), each review once per pull request. */
async function alsoFrom(path: string, waiting: { codeChange: { id: string } | null }[]) {
  const ids = [...new Set(waiting.flatMap((row) => (row.codeChange ? [row.codeChange.id] : [])))];
  if (ids.length === 0) {
    return [];
  }
  const rows = await prisma.codeChangeAction.findMany({
    where: { ...inReview, codeChangeId: { in: ids }, status: { in: WAITS } },
    orderBy: actionOrder,
    select: {
      id: true,
      kind: true,
      status: true,
      postId: true,
      articleId: true,
      payload: true,
      post: { select: { title: true } },
      article: { select: { title: true } },
      codeChange: { select: { id: true, number: true } },
      revisions: { select: { id: true }, take: 1 },
    },
  });
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const other = reviewPath(row);
    const key = `${row.codeChange!.id} ${other}`;
    if (!other || other === path || seen.has(key)) {
      return [];
    }
    seen.add(key);
    // `stale`: out of date (written on an earlier version of its article), so it can't go out until written again.
    // (Or one the previous release wrote, with no tagged revision: out of date too, as its review shows it.)
    const stale = row.status === "STALE" || (row.kind === "ARTICLE_EDIT" && row.status === "PENDING" && outdated(row));
    return [{ codeChangeId: row.codeChange!.id, number: row.codeChange!.number, path: other, title: titleOf(row), kind: KINDS[row.kind], stale }];
  });
}

/**
 * What an article's applied edits changed, once nothing on it waits (its Reviewed page): the version the first of the
 * latest chain was written on and the chain's newest version, each edit written on the one before it. By when each
 * version was written, not when its edit was suggested (one written again keeps that). Null when they're gone.
 */
export async function editedRange(articleId: string, updates: { kind: string; status: string; revision?: string; basedOn?: string | null }[]) {
  const edits = updates.filter((update) => update.kind === "article_edit" && update.status === "applied" && update.revision);
  if (edits.length === 0) {
    return null;
  }
  const newest = await prisma.articleRevision.findFirst({
    where: { articleId, id: { in: edits.map((edit) => edit.revision!) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const last = edits.find((edit) => edit.revision === newest?.id);
  if (!last) {
    return null;
  }
  let first = last;
  for (let under = edits.find((edit) => edit.revision === first.basedOn); under; under = edits.find((edit) => edit.revision === first.basedOn)) {
    first = under;
  }
  const versions = await prisma.articleRevision.findMany({ where: { articleId, id: { in: [first.basedOn ?? "", last.revision!] } }, select: { id: true, body: true, content: true } });
  const [from, to] = [versions.find((one) => one.id === first.basedOn), versions.find((one) => one.id === last.revision)];
  return from && to ? { from, to } : null;
}

/**
 * How Autopilot is doing: of its last 50 updates that went out (approved, or applied by itself), how
 * many were kept as it wrote them: not undone since, and not edited (the team's own words before
 * approving; a draft or an edit finished in the editor, saved again since). Those approved before this
 * was recorded aren't counted either way.
 */
export async function autopilotRecord(projectId: string): Promise<{ kept: number; of: number; wentOut: boolean }> {
  const recent = await prisma.codeChangeAction.findMany({
    // Not the changelog line: the analysis writes it for every pull request, nobody approving it.
    where: { ...inReview, codeChange: { projectId }, status: { in: ["APPLIED", "UNDONE"] } },
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

/**
 * `publish` is gone (an article's edit is already in its unpublished changes, and approving publishes them): a caller
 * still sending it is refused (400), not ignored, so `publish: false` can't publish everything waiting.
 */
const noPublish = z
  .never({ error: "`publish` is gone: an article's edit is in its unpublished changes already; approve it to publish them, or open the article to finish it in the editor" })
  .optional()
  .describe("Gone: refused if sent");

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

export const listCodeChangeTargets = defineOperation({
  name: "codeChanges.targets",
  summary:
    "Autopilot's review by what it updates: the posts (`feedback`) and articles (`helpCenter`: edits, and new articles' drafts) with updates waiting for the team or going out by themselves, the ones that reach the most people first (`reach`: a post's author, voters, commenters and subscribers; an article's views in 30 days). With `view: decided`, those whose updates were all decided, the latest first, each with its `outcome` (what became of it: `completed`, `in_progress`, `published`, `approved` (an edit kept unpublished), `drafted`, `linked`, `dismissed` or `undone`; who decided it, as `line`; and `at`, when). Each has its `badge` (`completing`, `in_progress`, `updated`, `new`, from its updates waiting or applied; null once all were dismissed or undone), the pull requests behind it, its `group` (where it is: a post's board, an article's collection with its `icon`; null for an article in none or a new article's draft), and its `path` for codeChanges.target. The changelog line isn't here: it's written into the running draft by itself",
  method: "GET",
  path: "/code-change-targets",
  scope: "read",
  access: "team",
  input: z.object({ view: z.enum(["waiting", "decided"]).default("waiting") }),
  example: { view: "waiting" },
  run: async ({ projectId }, input) => autopilotTargets(projectId, { decided: input.view === "decided" }),
});

export const getCodeChangeTarget = defineOperation({
  name: "codeChanges.target",
  summary:
    "Get a post's or an article's review in Autopilot (`type`: feedback or articles; `id`: the post's id, or the article's, or for a new article's draft not written yet, its update's id): the pull requests behind it and every update on it, waiting or decided; for a post, its `update` waiting: each pull request's part as one status change with one comment, and `asked`: what its users asked (its description's first lines as `excerpt`, its first voters of `voteCount`, its Inbox `conversations`); for a new article's draft, its `place`: where approving saves it (an existing `collection`, or a `newCollection` approving makes, readers seeing it once an article in it is published; after `afterArticle`, or `first`, else last; null: in no collection); and `also`: what the pull requests behind its waiting updates update elsewhere that still waits (each with its pull request's `number`, its review's `path`, its `title`, `kind`, and `stale` when it's out of date)",
  method: "GET",
  path: "/code-change-targets/{type}/{id}",
  scope: "read",
  access: "team",
  input: z.object({ type: z.enum(["feedback", "articles"]), id }),
  run: async ({ projectId }, input) => {
    const review = await targetReview(projectId, input.type, input.id);
    if (!review) {
      throw new OperationError(404, "not_found", "Nothing from Autopilot on it");
    }
    return review;
  },
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
    "Analyse a code change again; one with nothing to do is analysed past that decision (\"Analyse anyway\"); one already being analysed (`state` analysing, for up to 30 minutes) isn't queued again; refused (402) out of AI credits or where the project's plan doesn't include code changes",
  method: "POST",
  path: "/code-changes/{id}/analyse",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async ({ projectId }, input) => {
    const change = await prisma.codeChange.findFirst({
      where: { id: input.id, projectId },
      select: { id: true, state: true, reason: true, project: { select: { analyseCodeChanges: true } } },
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
    // Analysing from now: queued (on Hatchet the job runs later), its pages say so until it's done. Claimed, so two asking
    // at once queue it once: already being analysed (while a run could still be going), nothing more is queued.
    const { count } = await prisma.codeChange.updateMany({
      where: { id: change.id, OR: [{ state: { not: "ANALYSING" } }, { updatedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }] },
      data: { state: "ANALYSING", reason: "" },
    });
    if (count === 0) {
      return changeView(await prisma.codeChange.findUniqueOrThrow({ where: { id: change.id }, select: changeSelect }));
    }
    try {
      await enqueue("codeChange", { codeChangeId: change.id, force: true, pastGate: change.state === "NOTHING_TO_DO", resume: false });
    } catch {
      // Inline, the analysis itself failed (the code change says where); on Hatchet, queueing did: as it was. Not one
      // whose run had stopped (analysing, past the window): put back, it would look under way again, so it's failed.
      if (process.env.JOBS_DRIVER !== "inline") {
        const stopped = change.state === "ANALYSING";
        await prisma.codeChange.updateMany({
          where: { id: change.id, state: "ANALYSING" },
          data: stopped ? { state: "FAILED", reason: "Its analysis couldn't be queued. Try again in a moment." } : { state: change.state, reason: change.reason },
        });
      }
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
async function revert(rows: [string, Prisma.CodeChangeActionUncheckedUpdateManyInput][], error: unknown): Promise<never> {
  try {
    // Only while it's still the claimed apply's (nobody undid it meanwhile). All of them or none, so a post's update is
    // never left part applied, part waiting.
    await prisma.$transaction(rows.map(([id, data]) => prisma.codeChangeAction.updateMany({ where: { id, status: "APPLIED" }, data })));
  } catch {
    // Not a refusal (an OperationError's message would say "try again" or "out of date"): unknown, the refusal as its cause.
    throw Object.assign(new Error("Couldn't put an Autopilot update back after a failure", { cause: error }), { saved: "unknown" as const });
  }
  throw error;
}

/** The team's comment for a post's update: one longer than a comment can be is refused saying so (its length), to shorten. */
/** Empty: none (a completion then posts no comment; a progress update needs one, refused saying so). */
const postComment = z
  .string()
  .trim()
  .max(POST_COMMENT_MAX, { error: (issue) => tooLong(String(issue.input ?? "")) })
  .optional();

/**
 * Applying as Autopilot (the runner, Publish now): nobody reviewed the update, so a post's goes out only while every
 * part of it is still going out by itself (a teammate's Stop, or a part nobody checked, landing meanwhile refuses it).
 */
const byItself = (context: { actor: Actor; projectId: string }) => ({ ...context, byItself: true as const });

export const applyCodeChangeAction = defineOperation({
  name: "codeChangeActions.apply",
  summary:
    "Apply a proposed action: link the post, complete it (its people get the shipped email) or post the team's comment on it (a post's update is every pull request's part waiting on it, applied as one: one status change, one comment theirs joined (`comment` replaces it), each pull request linked; `revision`: only if it's still the update reviewed, codeChanges.target's `update.revision`); approve an article's edit, which publishes the article's unpublished changes with every edit waiting in them (`revision`: only if it's still the version reviewed; on a draft, its edits are approved and stay in the draft, unpublished, `published: false`, and only with `reviewedAs: \"draft\"` and its `revision`, else a 409 `draft`); create a new article's draft (in its `place`, a new collection made for it, readers seeing that only once an article in it is published; `collection` puts it in another, or none); or write the pull request's line in the changelog (its bullet in the entry that has it, else the running draft)",
  method: "POST",
  path: "/code-change-actions/{id}/apply",
  scope: "write",
  access: "team",
  input: z.object({
    id,
    /** For a post's update: the comment to post, if the team changed it (a progress update's; for a completion, one to post with it, or empty for none). */
    comment: postComment,
    /** For the changelog line: the line to write, if the team changed it. */
    line: z.string().trim().min(1).max(300).optional(),
    /** For an article edit: only if the article's newest version (from articles.revisions) is still this one, the one reviewed. Otherwise it's a 409. */
    revision: z.string().min(1).max(100).optional(),
    /**
     * For an article edit: whether the article was published or a draft when reviewed (approving publishes the one,
     * keeps the edit in the other). Published since, it's a 409 `changed`; a draft now, approving needs `draft` (else 409 `draft`).
     */
    reviewedAs: z.enum(["published", "draft"]).optional(),
    /** For a new article's draft: the collection to save it in instead of its `place` (its slug: last there; null: none). */
    collection: z.string().trim().min(1).max(80).nullable().optional(),
    publish: noPublish,
  }),
  example: { comment: "Weekly repeats are out today; monthly ones are next." },
  run: async (context, input) => {
    const { projectId } = context;
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: input.id, ...ofProject(projectId) },
      select: {
        id: true,
        kind: true,
        status: true,
        payload: true,
        // Who stopped it, if someone did: a failed apply puts that back (it's what keeps it off the schedule).
        decidedById: true,
        waitReason: true,
        codeChange: { select: { id: true, repo: true, number: true, url: true, title: true } },
        post: { select: { id: true, number: true, status: true } },
        article: { select: { ...articleSelect, id: true, deletedAt: true } },
        revisions: { select: { id: true }, take: 1 },
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (!APPLICABLE.has(action.kind)) {
      throw new OperationError(409, "not_applicable", "This kind of action can't be applied yet");
    }
    if (action.kind === "ARTICLE_EDIT") {
      return approveArticle(context, action, input.revision, input.reviewedAs);
    }
    if (action.kind === "NEW_ARTICLE") {
      return applyDocs(context, action, input.collection);
    }
    // Only an article edit can be a Verify fix (no pull request): what's below is a pull request's.
    if (!action.codeChange) {
      throw new OperationError(409, "not_applicable", "This kind of action can't be applied yet");
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
        // (Never null: without `unlessPublished` it always writes.)
        const { number: entry, previous, added } = (await setChangelogLine(projectId, { ...action.codeChange }, line))!;
        await recordUndo(action.id, { line, edited }, { previous, added });
        return { id: action.id, kind: KINDS[action.kind], status: "applied", changelog: entry };
      } catch (error) {
        // Not done: the pull request it put in a draft comes out again (writing the line is one save: it's
        // done or not), and it's waiting again.
        if (undo.added === "entry") {
          await undoChangelogLine(projectId, action.codeChange.url, { applied: null, previous: "", added: "entry" }).catch((cause: unknown) => unknown(error, cause));
        }
        return revert([[action.id, { status: "PENDING", decidedById: action.decidedById, decidedAt: null, payload: action.payload ?? {} }]], error);
      }
    }
    if (!action.post) {
      throw new OperationError(409, "not_applicable", "This kind of action can't be applied yet");
    }
    const { post } = action;
    // A post's status change is its update (docs/plan.md, V4): every pull request's part waiting on it goes out as one,
    // with one comment. A link is only itself.
    const whole = POST_UPDATE.includes(action.kind) ? await postUpdate(post.id) : null;
    if (whole && !whole.parts.some((part) => part.id === action.id && part.status === "PENDING")) {
      throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
    }
    // Its comment may already be on the post: approved only with the comment named (its review sends what's in its
    // box, empty for none), never as proposed (an email's Approve, the API without one), which could post it twice.
    if (whole && input.comment === undefined && whole.parts.some((part) => part.waitReason === COMMENT_UNSURE)) {
      throw new OperationError(409, "check_comment", COMMENT_UNSURE);
    }
    // Held so: the comment the held try posted, if it's on the post (by whoever applied it, in its words, since). Approved
    // with the box emptied or as it was, that one is the update's comment (quoted in the email, taken out by Undo), never
    // a second copy.
    const held = whole?.parts.find((part) => part.waitReason === COMMENT_UNSURE);
    const tried = held && typeof asObject(held.payload).heldComment === "string" ? String(asObject(held.payload).heldComment) : null;
    const posted =
      held && tried && held.decidedById && held.decidedAt && (input.comment === "" || input.comment?.trim() === tried.trim())
        ? await prisma.comment.findFirst({ where: { postId: post.id, authorId: held.decidedById, body: toPlainText(fromPlainText(tried)), createdAt: { gte: held.decidedAt } }, select: { id: true } })
        : null;
    const reuse = posted?.id ?? null;
    // Only the update reviewed (`revision`): a part landing, dismissed or analysed again since refuses it.
    const changed = new OperationError(409, "changed", "The post's update changed since you reviewed it: review it again before approving");
    if (whole && input.revision !== undefined && input.revision !== whole.version) {
      throw changed;
    }
    const parts = whole?.parts ?? [{ ...action, codeChange: action.codeChange, dueAt: null, decidedAt: null, waitReason: null }];
    // What a failure puts back: the parts as they were when claimed, read under the lock (a Stop just before it stays).
    let claimedFrom: { id: string; status: CodeChangeActionStatus; decidedById: string | null; decidedAt: Date | null; dueAt: Date | null; payload: Prisma.JsonValue }[] = parts;
    const progress = parts.some((part) => part.kind === "MOVES_FORWARD");
    // A comment posted with it: a progress update's (theirs joined, or the team's), or one the team wrote for a completion.
    const commenting = progress || (whole !== null && input.comment !== undefined);
    const proposed = whole?.comment ?? "";
    const comment = reuse ? tried! : (input.comment ?? proposed);
    if (progress && !whole?.completes && !comment.trim()) {
      throw new OperationError(400, "invalid_input", "Write the comment to post first");
    }
    // Every part's comment joined, as it is: too long to post, it's shortened first (a comment's limit).
    if (progress && input.comment === undefined && comment.length > POST_COMMENT_MAX) {
      throw new OperationError(400, "too_long", tooLong(comment));
    }
    // Claimed first, so two people applying it at once do it once: this one (waiting), then the other parts (waiting or
    // going out by themselves), all or none.
    const claimedAt = new Date();
    const claimed = { status: "APPLIED" as const, decidedById: actorUser(context.actor), decidedAt: claimedAt, dueAt: null };
    const others = parts.filter((part) => part.id !== action.id).map((part) => part.id);
    await prisma.$transaction(async (tx) => {
      // A post's update is read again under the project's lock (an analysis saves its parts under it): a part landing,
      // dismissed or analysed again since it was read refuses it, never applying what's left of it beside a new part.
      if (whole) {
        await lockProject(tx, projectId);
        const now = await postUpdate(post.id, tx);
        claimedFrom = now.parts;
        if (!now.parts.some((part) => part.id === action.id && part.status === "PENDING")) {
          throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
        }
        if (now.version !== whole.version) {
          throw changed;
        }
        if ("byItself" in context && now.parts.some((part) => part.id !== action.id && part.status !== "SCHEDULED")) {
          throw new OperationError(409, "waits", "Another part of its post's update waits for you: review it on its page");
        }
      }
      if ((await tx.codeChangeAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: claimed })).count === 0) {
        throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
      }
      if (others.length > 0 && (await tx.codeChangeAction.updateMany({ where: { id: { in: others }, status: { in: ["PENDING", "SCHEDULED"] } }, data: claimed })).count !== others.length) {
        throw changed;
      }
    });
    // What it changes, for Undo to put back: each pull request's link (if it's new) and the entries it joins; the status
    // it moved the post from, and the comment.
    const own = new Map(parts.map((part) => [part.id, { linked: false, entries: [] as string[] }]));
    const shared: { status: string | null; commentId: string | null } = { status: null, commentId: null };
    const record = (commentId: string | null) =>
      Promise.all(
        parts.map((part) =>
          // A comment the team adds to a completion Autopilot proposed none for changes nothing it wrote: no `edited`
          // (How it's doing counts it as kept). A progress update's always says whether it was edited.
          recordUndo(part.id, { ...asObject(part.payload), ...(commenting && { comment, ...(!(whole?.completes && !proposed.trim()) && { edited: comment !== proposed }) }), ...((first || reuse) && commentId && { note: commentId }) }, {
            ...own.get(part.id),
            ...shared,
            commentId,
            // Applied as one: Undo puts all of it back.
            ...(parts.length > 1 && { together: parts.map((one) => one.id) }),
          }),
        ),
      );
    // Once the comment is being posted, it may be saved even if something after it fails: then the
    // action stays applied, so trying again can't post it twice.
    let posting = false;
    // The comment posted before the completion (see below), and whether it can't be told it was saved.
    let first = false;
    let unsureComment = false;
    try {
      if (reuse) {
        // Before completing it: the email it sends quotes that comment (postShipped reads `note`).
        shared.commentId = reuse;
        await Promise.all(parts.map((part) => prisma.codeChangeAction.updateMany({ where: { id: part.id, status: "APPLIED" }, data: { payload: { ...asObject(part.payload), note: reuse } } })));
      }
      for (const part of parts) {
        const { codeChange } = part;
        const mine = own.get(part.id)!;
        mine.linked = !(await prisma.postLink.findUnique({ where: { postId_url: { postId: post.id, url: codeChange.url } }, select: { postId: true } }));
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
        if (part.kind === "RESOLVES") {
          // The changelog entry with the pull request's bullet completes the post too.
          const entries = await prisma.changelogEntryPullRequest.findMany({ where: { url: codeChange.url, entry: { projectId } }, select: { entryId: true } });
          const had = await prisma.changelogEntryPost.findMany({ where: { postId: post.id, entryId: { in: entries.map((e) => e.entryId) } }, select: { entryId: true } });
          mine.entries = entries.map((e) => e.entryId).filter((entryId) => !had.some((h) => h.entryId === entryId));
          await linkEntryPosts(prisma, entries.map(({ entryId }) => ({ entryId, postId: post.id })), { skipDuplicates: true });
        }
      }
      // Completing it with the team's comment: the comment first, so the email the completion sends has it (postShipped
      // quotes it); a failure after it takes it out again. Else the comment last: once it's being posted, a failure may
      // come after it was saved.
      first = !!whole?.completes && post.status !== "COMPLETED" && commenting && !!comment.trim() && !reuse;
      if (first) {
        posting = true;
        shared.commentId = (await call(createComment, context, { number: post.number, body: comment })).id;
        posting = false;
        // The email completing it sends quotes this comment and no other (postShipped reads `note`).
        const note = shared.commentId;
        await Promise.all(parts.map((part) => prisma.codeChangeAction.updateMany({ where: { id: part.id, status: "APPLIED" }, data: { payload: { ...asObject(part.payload), note } } })));
      }
      if (whole?.completes) {
        if (post.status !== "COMPLETED") {
          shared.status = post.status;
          await call(updatePost, context, { number: post.number, status: toApiStatus("COMPLETED") });
        }
      } else if (progress && NOT_STARTED.has(post.status)) {
        shared.status = post.status;
        await call(updatePost, context, { number: post.number, status: toApiStatus("IN_PROGRESS") });
      }
      if (commenting && comment.trim() && !first && !reuse) {
        posting = true;
        shared.commentId = (await call(createComment, context, { number: post.number, body: comment })).id;
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
        if (first && found && found !== "unknown") {
          // Posted before the completion, which didn't happen: taken out with the rest below.
          shared.commentId = found.id;
        } else if (found && found !== "unknown") {
          // Found, Undo can take it all back. Can't tell: no record, so Undo says to change it by hand.
          await record(found.id);
        }
        // Posted before the completion, the post isn't completed whatever became of the comment: it waits again. One
        // that can't be found may be on the post: said (`saved: unknown`), to check it before approving again. Else,
        // saved or maybe: it stays applied.
        if (!first && saved !== false) {
          throw Object.assign(error as Error, { saved });
        }
        if (first && saved === "unknown") {
          Object.assign(error as Error, { saved });
          unsureComment = true;
        }
      }
      // Not done: what this try did is put back, and it's waiting again (going out by itself again), for another try.
      // (Not a comment it reused: the held try posted that, and it stays on the post for the next approval to reuse.)
      await putBackUpdate(context, post, parts, (id) => ({ ...own.get(id)!, ...shared, ...(reuse && shared.commentId === reuse && { commentId: null }) })).catch((cause: unknown) =>
        unknown(error, cause),
      );
      return revert(
        // (`decidedAt` too: a teammate's Stop keeps when it was.) Its comment maybe posted: every part waits for the
        // team, saying so, held as a Stop holds (whoever applied it), never going out by itself again (which could post
        // it twice) nor replaced by an analysis.
        claimedFrom.map((part) => [
          part.id,
          unsureComment
            ? { status: "PENDING", decidedById: actorUser(context.actor), decidedAt: claimedAt, dueAt: null, waitReason: COMMENT_UNSURE, payload: { ...asObject(part.payload), heldComment: comment } }
            : { status: part.status, decidedById: part.decidedById, decidedAt: part.decidedAt, dueAt: part.dueAt, payload: part.payload ?? {} },
        ]),
        error,
      );
    }
    await record(shared.commentId);
    return { id: action.id, kind: KINDS[action.kind], status: "applied", post: post.number };
  },
});

export const applyCodeChangeActions = defineOperation({
  name: "codeChangeActions.applyMany",
  summary:
    "Apply several proposed actions at once (the review page's Approve), each as codeChangeActions.apply does, with its edits (`comment`, `line`) and the version reviewed (`revision`): in order, each on its own, so one refused (out of date, already decided) doesn't stop the rest. Each is claimed as it's applied, so two people approving the same ones at once apply each once. `results` says, for each, `applied` or why not",
  method: "POST",
  path: "/code-change-actions/apply",
  scope: "write",
  access: "team",
  input: z.object({
    actions: z
      .array(
        z.object({
          id,
          comment: postComment,
          line: z.string().trim().min(1).max(300).optional(),
          revision: z.string().min(1).max(100).optional(),
          publish: noPublish,
        }),
      )
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
    // Together, so a retry after a failure can't leave the count one too high. The post locked first, as every writer of
    // its comments takes it (a reply or a like holds the comment through its foreign key, then wants the post): deleting
    // the comment first and updating the post after could deadlock with one.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
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

/**
 * Puts back what applying a post's update did, part by part (`undoOf`: what each recorded): each pull request's link and
 * entries, then the status and the comment once (recorded on each part alike: they're the update's).
 */
async function putBackUpdate(
  context: { actor: Actor; projectId: string },
  post: { id: string; number: number },
  parts: { id: string; kind: CodeChangeActionKind; codeChange: { url: string } }[],
  undoOf: (id: string) => Pick<Undo, "linked" | "entries" | "status" | "commentId">,
) {
  const kind = parts.some((part) => part.kind === "RESOLVES") ? "RESOLVES" : parts.some((part) => part.kind === "MOVES_FORWARD") ? "MOVES_FORWARD" : "LINKS";
  for (const [i, part] of parts.entries()) {
    const { linked, entries, status, commentId } = undoOf(part.id);
    await putBackPost(context, kind, post, part.codeChange.url, { linked, entries, ...(i === parts.length - 1 && { status, commentId }) });
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
 * Approving an article edit publishes the article's unpublished changes (articles.publishChanges), which approves
 * every edit waiting in them: its update is the article's, not one pull request's. Only for the version reviewed
 * (`revision`: its newest revision then), and only the changes as they are now (a save in between refuses it).
 * On a draft it approves the edits in its text, which stays a draft (published from Docs, never by Autopilot), only
 * when reviewed as one (`reviewedAs`): reviewed for publishing, it's a 409 `changed` (unpublished since); not reviewed
 * (Autopilot by itself, the email's one click), a 409 `draft`, and it waits.
 * One the previous release wrote, as a whole new article, is out of date.
 */
async function approveArticle(
  context: { actor: Actor; projectId: string },
  action: {
    id: string;
    kind: CodeChangeActionKind;
    status: CodeChangeActionStatus;
    decidedById: string | null;
    waitReason: string | null;
    revisions: { id: string }[];
    article: (Prisma.ArticleGetPayload<{ select: typeof articleSelect }> & { id: string; deletedAt: Date | null }) | null;
  },
  revision: string | undefined,
  reviewedAs?: "published" | "draft",
) {
  const { article } = action;
  if (!article || article.deletedAt) {
    throw new OperationError(409, "gone", "The article was deleted since");
  }
  if (action.status === "PENDING" && outdated(action)) {
    await prisma.codeChangeAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { status: "STALE" } });
    throw new OperationError(409, "stale", STALE_EDIT);
  }
  if (action.status !== "PENDING") {
    throw new OperationError(409, "already_decided", "Someone already applied or dismissed this, or it's out of date");
  }
  const changed = new OperationError(409, "changed", "The article changed since you reviewed it: review it again before approving");
  // The version reviewed, or with none given the newest now, checked under the lock that publishes it (an edit landing
  // or a save in between refuses it): published in one save, or not at all.
  const pinned = revision ?? (await newestRevision(article.id));
  // Without a version reviewed (Publish now, an API call), never with a teammate's edit in it: that's the page's to
  // approve, which shows it and asks first. Checked after the pin, so a save after the check moves the newest version.
  if (revision === undefined && (await hasTeammateEdit(article.id))) {
    throw new OperationError(409, "teammate_edit", "Its article has a teammate's unpublished edit: review it on its page to publish them together");
  }
  // Held by the runner or Publish now (claimed, not stopped): it goes out by itself, so only while nothing else in the
  // changes waits for someone, checked under the lock a Stop takes too (one landing as it publishes holds it).
  const claimed = action.decidedById !== null && !action.waitReason?.startsWith("Stopped by");
  const alone = async (tx: Prisma.TransactionClient, articleId: string) => {
    // Another the runner or Publish now holds as it goes isn't waiting for someone: a stopped one, or one nobody holds, is.
    const others = await tx.codeChangeAction.count({
      where: {
        articleId,
        kind: "ARTICLE_EDIT",
        id: { not: action.id },
        revisions: { some: {} },
        OR: [{ status: "STALE" }, { status: "PENDING", OR: [{ decidedById: null }, { waitReason: { startsWith: "Stopped by" } }] }],
      },
    });
    if (others > 0) {
      throw new OperationError(409, "held", "Another edit to its article waits for you");
    }
  };
  if (!article.publishedAt) {
    // Only as its review shows a draft (Approve keeps it there): never by itself (the runner, Publish now, the email's
    // one click), as an edit approved for publishing whose article was unpublished since. It waits, saying why.
    if (reviewedAs === "published") {
      throw changed;
    }
    if (reviewedAs !== "draft") {
      throw new OperationError(409, "draft", 'Its article is a draft: approve it on its review');
    }
    // As reviewed: the version its review showed (it sends it).
    if (revision === undefined) {
      throw new OperationError(409, "revision_required", "Approving an edit to a draft needs the version reviewed (`revision`, from codeChanges.target)");
    }
    // Under the lock a save and an edit landing take: the version reviewed, still a draft (published meanwhile, its
    // edits were approved with it).
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, context.projectId);
      const now = await tx.article.findUniqueOrThrow({ where: { id: article.id }, select: { publishedAt: true, deletedAt: true } });
      // Published since: not this.
      if (now.deletedAt || now.publishedAt || (pinned !== null && (await newestRevision(article.id, tx)) !== pinned)) {
        throw changed;
      }
      await (claimed ? alone(tx, article.id) : undefined);
      const kept = await tx.codeChangeAction.findMany({ where: { articleId: article.id, kind: "ARTICLE_EDIT", status: { in: ["PENDING", "STALE", "SCHEDULED"] }, revisions: { some: {} } }, select: { id: true, payload: true } });
      await settleWaitingEdits(tx, article.id, "APPLIED", actorUser(context.actor));
      // Approved, not published: said so where it's shown ("Approved", not "Published"), as one kept unpublished is.
      for (const edit of kept) {
        await tx.codeChangeAction.update({ where: { id: edit.id }, data: { payload: { ...asObject(edit.payload), undo: { published: false } } } });
      }
    });
  } else {
    // Reviewed as a draft (Approve keeps it there): published since, approving would publish what wasn't asked.
    if (reviewedAs === "draft") {
      throw changed;
    }
    try {
      await publishArticleChanges(context, { slug: article.slug, ...(pinned && { revision: pinned }) }, claimed ? alone : undefined);
    } catch (error) {
      throw error instanceof OperationError && error.code === "changed" ? changed : error;
    }
  }
  const after = await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { status: true } });
  if (after.status !== "APPLIED") {
    throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
  }
  return { id: action.id, kind: KINDS[action.kind], status: "applied", article: article.slug, published: Boolean(article.publishedAt) };
}

/** A new article becomes a draft. Claimed first, and back to waiting if saving fails. */
async function applyDocs(
  context: { actor: Actor; projectId: string },
  action: { id: string; kind: CodeChangeActionKind; payload: Prisma.JsonValue; decidedById: string | null },
  picked: string | null | undefined,
) {
  const payload = (action.payload ?? {}) as DocsPayload;
  // The team's pick, checked before anything changes (one it can't have meant is refused, not left out).
  const chosen = picked
    ? await prisma.collection.findUnique({ where: { projectId_slug: { projectId: context.projectId, slug: picked } }, select: { id: true, slug: true } })
    : null;
  if (picked && !chosen) {
    throw new OperationError(400, "invalid_input", `There's no collection “${picked}”`);
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
  let place: Awaited<ReturnType<typeof placeFor>> = null;
  try {
    // Where it goes: the team's pick (last there), else its place.
    place = picked !== undefined ? chosen && { ...chosen, created: false, at: null, after: undefined } : await placeFor(context, payload.place);
    const save = () => call(createArticle, context, { title: payload.title ?? "", content: payload.content, collection: place?.slug ?? null });
    const created = await save().catch(async (error: unknown) => {
      // Its place's collection deleted or renamed since it was found (a teammate in Docs, another draft's failed
      // approval taking out the one it made): found again (a renamed one by its id; a new one made again; one deleted,
      // none), and saved once more. Not for the team's pick: that one is refused, as they named it.
      if (picked !== undefined || !place || !(error instanceof OperationError && error.message.startsWith("There's no collection"))) {
        throw error;
      }
      place = await placeFor(context, payload.place);
      return save();
    });
    const draft = await prisma.article.findFirstOrThrow({ where: { projectId: context.projectId, slug: created.slug, deletedAt: null }, select: { id: true } });
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { articleId: draft.id } });
    await recordUndo(action.id, payload, { revision: await ourRevision(draft.id), ...madeCollection(place) });
    // After the article it follows (it went last): its order only, no new version. Not done, it stays last.
    if (place && place.after !== undefined) {
      const { id: collectionId, after } = place;
      const siblings = inArticleOrder(
        await prisma.article.findMany({ where: { collectionId, deletedAt: null, id: { not: draft.id } }, select: { id: true, order: true, title: true } }),
      );
      const position = after === null ? 0 : siblings.findIndex((sibling) => sibling.id === after) + 1;
      if (position > 0 || after === null) {
        await call(reorderArticle, context, { slug: created.slug, position }).catch((error: unknown) =>
          log.error("code change: couldn't place the new article", { actionId: action.id, error: String(error) }),
        );
      }
    }
    return { id: action.id, kind: KINDS[action.kind], status: "applied", article: created.slug, published: false };
  } catch (error) {
    // Saved anyway (the failure came after it)? Then it stays applied, so trying again can't save a
    // second draft. Not saved: it's waiting again. This attempt's save is an article by whoever applies
    // it, with the proposal's text, since the claim: a teammate's article meanwhile isn't it.
    // Can't tell (the check failed too): it stays applied, and the team is told to check.
    const found = await prisma.article
      .findFirst({ where: { projectId: context.projectId, title: payload.title ?? "", createdById: actorUser(context.actor), createdAt: { gte: claimedAt }, body: payload.body ?? "" }, select: { id: true } })
      .catch(() => "unknown" as const);
    const saved = found === "unknown" ? "unknown" : found !== null;
    if (saved !== false) {
      // What was saved stays applied, and says so. Found, Undo can take it back.
      if (found && found !== "unknown") {
        await prisma.codeChangeAction
          .update({ where: { id: action.id }, data: { articleId: found.id } })
          .then(async () => recordUndo(action.id, payload, { revision: await ourRevision(found.id), ...madeCollection(place) }))
          .catch((cause: unknown) => log.error("code change: couldn't record what to undo", { actionId: action.id, error: String(cause) }));
      }
      throw Object.assign(error as Error, { saved });
    }
    // The collection made for it goes too, while nothing else is in it.
    // Under the project's lock, as Undo's: another draft's approval saving into it meanwhile lands first, and it stays.
    if (place?.created) {
      const made = place.id;
      await prisma
        .$transaction(async (tx) => {
          await lockProject(tx, context.projectId);
          await dropIfEmpty(tx, made);
        })
        .catch((cause: unknown) => unknown(error, cause));
    }
    return revert([[action.id, { status: "PENDING", decidedById: action.decidedById, decidedAt: null }]], error);
  }
}

/**
 * The collection a new article's draft goes into, from its place as it stands (deleted since: none), with the article
 * it follows (`after`: null first, undefined last; deleted or moved out since: last). A new collection is made, at the
 * end of the docs (of the first tab), or one with its name made since is used (collectionNamed); readers don't see it
 * until an article in it is published (docsContents leaves out collections with nothing to read). A name collections
 * can't have: none.
 */
async function placeFor(context: { actor: Actor; projectId: string }, place: ArticlePlace | undefined) {
  const now = await draftPlace(context.projectId, place);
  if (!now) {
    return null;
  }
  if (now.collection) {
    return { id: now.collection.id, slug: now.collection.slug, created: false, at: null, after: now.after?.id ?? (now.first ? null : undefined) };
  }
  // Made in one transaction, under the project's lock: a failure leaves nothing, and the update waits again.
  const made = await collectionNamed(context.projectId, now.newCollection!.name, now.newCollection!.icon);
  return made && { id: made.id, slug: made.slug, created: made.created, at: made.updatedAt, after: undefined };
}

/**
 * Collection `id` while it's as Approve made it: nothing in it (no live article but `except`, the draft; none whose
 * unpublished changes move it there; no collection), nothing pointing at it from elsewhere (a tab's landing page, a
 * reader group, a redirect), and, with `at` (its `updatedAt` then), not changed since (renamed, described, its access
 * or icon set). Undo removes only that one: it keeps one when unsure.
 */
const asMade = (id: string, at?: string, except?: string): Prisma.CollectionWhereInput => ({
  id,
  ...(at && { updatedAt: new Date(at) }),
  articles: { none: { deletedAt: null, ...(except && { id: { not: except } }) } },
  changes: { none: {} },
  children: { none: {} },
  landingOf: { none: {} },
  groups: { none: {} },
  redirects: { none: {} },
});

/** Removes collection `id` while it's as Approve made it (asMade). */
const dropIfEmpty = (tx: Prisma.TransactionClient, id: string, at?: string) => tx.collection.deleteMany({ where: asMade(id, at) });

/** For Undo: the collection approving made, and when (its `updatedAt`): Undo removes it only as it was. */
const madeCollection = (place: { id: string; created: boolean; at: Date | null } | null) =>
  place?.created && place.at ? { collection: place.id, collectionAt: place.at.toISOString() } : {};

/**
 * Takes an article edit (its tagged revision's sections) out of the article: out of its unpublished changes (`from`:
 * "changes", a waiting edit's Dismiss), or out of those and the published version too, published again without
 * anything unpublished (`from`: "both", Undo). Refused, saying why, when an edit on top of it changed the same
 * sections. Everything else (a teammate's draft, other edits) stays. Under the project's lock, with `claim` (the
 * update's own status change) in the same transaction.
 */
async function takeOutEdit(
  context: { actor: Actor; projectId: string },
  articleId: string,
  actionId: string,
  from: "changes" | "both",
  claim: (tx: Prisma.TransactionClient) => Promise<number>,
) {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, context.projectId);
    const article = await tx.article.findUniqueOrThrow({
      where: { id: articleId },
      select: { title: true, body: true, content: true, deletedAt: true, publishedAt: true, changes: { select: { body: true, content: true } } },
    });
    // Deleted since: an applied one can't be undone. A waiting one is dismissed with its sections out of the text the
    // article keeps (its changes went into it), so restoring it doesn't bring them back; refused, as on a live article,
    // when a pull request's edit on top changed the same sections (take that out first). Otherwise (no record of its
    // text, or a teammate's change on top, which the editor can't reach now) just dismissed.
    if (article.deletedAt) {
      if (from === "both") {
        throw new OperationError(409, "gone", "The article was deleted since");
      }
      const all = await taggedEdits(articleId, LIVE_EDIT, tx);
      const mine = all.find((one) => one.actionId === actionId);
      const kept = mine ? takeOut(mine, docOf(article), all) : null;
      if (kept && "refused" in kept && kept.refused.includes("'s edit changed the same section since")) {
        throw new OperationError(409, "edited", kept.refused);
      }
      if ((await claim(tx)) === 0) {
        throw new OperationError(409, "already_decided", "Someone already decided this");
      }
      if (kept && "doc" in kept) {
        await tx.article.update({ where: { id: articleId }, data: { body: toPlainText(kept.doc), content: kept.doc as Prisma.InputJsonValue } });
        await recordRevision(tx, articleId, actorUser(context.actor));
      }
      return;
    }
    // Unpublished since, its changes are the draft's text now: out of that.
    const draft = !article.publishedAt;
    const edits = await taggedEdits(articleId, LIVE_EDIT, tx);
    const edit = edits.find((one) => one.actionId === actionId);
    if (!edit) {
      throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it in the editor");
    }
    const live = from === "both" || draft ? takeOut(edit, docOf(article), edits) : null;
    const changes = article.changes ? takeOut(edit, docOf(article.changes), edits) : null;
    for (const result of [live, changes]) {
      if (result && "refused" in result) {
        throw new OperationError(409, "edited", result.refused);
      }
    }
    if ((await claim(tx)) === 0) {
      throw new OperationError(409, "already_decided", "Someone already decided this");
    }
    if (live && "doc" in live) {
      await tx.article.update({
        where: { id: articleId },
        data: { body: toPlainText(live.doc), content: live.doc as Prisma.InputJsonValue, ...(!draft && { revisedAt: new Date() }) },
      });
    }
    if (changes && "doc" in changes) {
      await keepText(tx, articleId, changes.doc, actorUser(context.actor));
    } else {
      await recordRevision(tx, articleId, actorUser(context.actor));
    }
  });
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
  /** A post's update applied as one: its parts (each pull request's update), undone together. */
  together?: string[];
  /** A new article's: the collection approving it made, removed with it while nothing else is in it. */
  collection?: string;
  /** Its `updatedAt` then: changed since, Undo keeps it. */
  collectionAt?: string;
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
    "Undo an applied action (any team member): a post goes back to the status it had (shipped emails still due are cancelled; ones sent already can't be), a progress update's comment is deleted, the link is removed (a post's update applied as one, from several pull requests, is undone whole: every part's links too), an article's edit is taken out by section, of the published version (published again) and of its unpublished changes (of a draft's text, on a draft), everything else staying (refused when an edit on top of it changed the same sections; one approved before edits were saved as revisions publishes the previous version again, refused if it's been edited since), a new article's draft is deleted (refused once edited or published), the changelog line is put back (refused once its entry is published: edit the entry). It becomes `undone` and isn't proposed again",
  method: "POST",
  path: "/code-change-actions/{id}/undo",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async (context, input) => {
    const { projectId } = context;
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: input.id, ...ofProject(projectId) },
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
        revisions: { select: { id: true }, take: 1 },
      },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    if (action.status !== "APPLIED") {
      throw new OperationError(409, "not_applied", "Only an approved update can be undone");
    }
    // An edit saved as a tagged revision: only its sections come out, of the published version and the unpublished changes.
    if (action.kind === "ARTICLE_EDIT" && action.revisions.length > 0 && action.article) {
      await takeOutEdit(context, action.article.id, action.id, "both", async (tx) =>
        (
          await tx.codeChangeAction.updateMany({
            where: { id: action.id, status: "APPLIED" },
            data: { status: "UNDONE", decidedById: actorUser(context.actor), decidedAt: new Date() },
          })
        ).count,
      );
      if (action.article.publishedAt) {
        await indexArticle(action.article.id);
      }
      return { id: action.id, status: "undone" };
    }
    const undo = undoOf(action.payload, action.kind);
    if (!undo) {
      throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it by hand");
    }
    const { article } = action;
    // A Verify fix (no pull request) is a tagged edit, undone above.
    if (!action.codeChange) {
      throw new OperationError(409, "not_undoable", "There's no record of what it changed: change it in the editor");
    }

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

    // A post's update applied as one is undone whole: every pull request's part in it (docs/plan.md, V4).
    const together = POST_UPDATE.includes(action.kind) ? (undo.together ?? [action.id]) : [action.id];
    // Claimed first, so two people undoing it at once do it once.
    const { count } = await prisma.codeChangeAction.updateMany({
      where: { id: { in: together }, status: "APPLIED" },
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
        // What readers saw before, published again in one save, only if the article is still the version it published (and
        // past the plan's limit on published articles too: it puts back what was live).
        await saveArticle(context, updateArticle.input.parse({ slug: article!.slug, content: undo.live, publish: true, ...(undo.revision && { revision: undo.revision }) }), { restoring: true });
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
          // The collection approving it made goes with it, while nothing else is in it.
          if (undo.collection && undo.collectionAt) {
            await dropIfEmpty(tx, undo.collection, undo.collectionAt);
          }
          return true;
        });
        if (!deleted) {
          throw new OperationError(409, "edited", "The draft was edited or published since: change it in Docs");
        }
      } else if (action.post) {
        const parts = (
          await prisma.codeChangeAction.findMany({ where: { id: { in: together } }, select: { id: true, kind: true, payload: true, codeChange: { select: { url: true } } } })
        ).flatMap(({ codeChange, ...part }) => (codeChange ? [{ ...part, codeChange }] : []));
        await putBackUpdate(context, action.post, parts, (id) => undoOf(parts.find((part) => part.id === id)!.payload, action.kind) ?? {});
      }
    } catch (error) {
      // Not done: it's applied again, for another try.
      await prisma.codeChangeAction.updateMany({ where: { id: { in: together } }, data: { status: "APPLIED", decidedById: action.decidedById, decidedAt: action.decidedAt } });
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
    const action = await prisma.codeChangeAction.findFirst({ where: { id: input.id, codeChange: { projectId: context.projectId } }, select: { id: true, kind: true, postId: true } });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    // A post's part goes out with the rest of its update: only while none of it waits for someone (a teammate's Stop, one
    // not sure enough), and only the parts checked here (`revision`: one landing meanwhile refuses it).
    const whole = POST_UPDATE.includes(action.kind) && action.postId ? await postUpdate(action.postId) : null;
    if (whole?.parts.some((part) => part.id === action.id && part.status === "SCHEDULED") && whole.parts.some((part) => part.id !== action.id && part.status === "PENDING")) {
      throw new OperationError(409, "waits", "Another part of its post's update waits for you: review it on its page");
    }
    // Taken off the schedule first, so the runner can't apply it too; apply then claims it as anyone's approval does.
    // Held as theirs meanwhile, so an analysis at that moment leaves it alone (it replaces only what nobody decided).
    const by = actorUser(context.actor);
    const { count } = await prisma.codeChangeAction.updateMany({ where: { id: action.id, status: "SCHEDULED" }, data: { status: "PENDING", dueAt: null, decidedById: by } });
    if (count === 0) {
      throw new OperationError(409, "not_scheduled", "It isn't scheduled any more: it went out, or someone stopped it");
    }
    try {
      return await call(applyCodeChangeAction, byItself(context), { id: action.id, ...(whole && { revision: whole.version }) });
    } catch (error) {
      // A post's update that changed as it went (a part landed, or one stopped): back under the schedule's rules, all of
      // it, as the runner does (an analysis meanwhile left it to this claim).
      if (whole && error instanceof OperationError && (error.code === "changed" || error.code === "waits")) {
        await prisma.$transaction(async (tx) => {
          await lockProject(tx, context.projectId);
          // At its time as it was, so the rest keep theirs (`keepDue` takes the first one going out's), unless a part landed
          // since: then the hold restarts for all of it, as it does whenever one lands.
          const was = whole.parts.find((part) => part.id === action.id)?.dueAt ?? null;
          await tx.codeChangeAction.updateMany({ where: { id: action.id, status: "PENDING", decidedById: by }, data: { status: "SCHEDULED", dueAt: was, decidedById: null, waitReason: null } });
          const landed = (await postUpdate(action.postId!, tx)).parts.some((part) => !whole.parts.some((read) => read.id === part.id));
          await schedulePost(tx, action.postId!, await tx.project.findUniqueOrThrow({ where: { id: context.projectId }, select: autopilotSettingsSelect }), { keepDue: !landed });
        });
        throw error;
      }
      // A post's update that failed (and didn't go, as far as anyone can tell): all of it waits, this part saying why, as
      // the runner's does, never half of it going out by itself.
      if (whole && !(error as { saved?: unknown }).saved) {
        const why = error instanceof OperationError ? error.message : "Couldn't apply it";
        await prisma.$transaction(async (tx) => {
          await lockProject(tx, context.projectId);
          const { count } = await tx.codeChangeAction.updateMany({ where: { id: action.id, status: { in: ["PENDING", "STALE"] }, decidedById: by }, data: { decidedById: null, waitReason: why } });
          if (count > 0) {
            await tx.codeChangeAction.updateMany({
              where: { postId: action.postId, kind: { in: POST_UPDATE }, status: "SCHEDULED" },
              data: { status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" },
            });
          }
        });
        throw error;
      }
      // Not applied (back to waiting, or out of date): nobody's again, not looking stopped. Past the plan's published
      // articles, or held by another edit to its article that waits, it waits for the team saying so, as the runner's does.
      const waits = error instanceof OperationError && (error.code === "article_limit" || error.code === "held" || error.code === "draft");
      await prisma.codeChangeAction.updateMany({
        // Not one apply held because its comment may already be on the post: that stays held, as a Stop holds.
        where: { id: action.id, status: { in: ["PENDING", "STALE"] }, decidedById: by, OR: [{ waitReason: null }, { waitReason: { not: COMMENT_UNSURE } }] },
        data: { decidedById: null, ...(waits && { waitReason: waitReasonOf(error) }) },
      });
      throw error;
    }
  },
});

export const stopCodeChangeAction = defineOperation({
  name: "codeChangeActions.stop",
  summary:
    "Stop: a scheduled action doesn't go out by itself; it waits for the team instead (to approve, edit or dismiss). A post's part stops all of its post's update (it goes out as one)",
  method: "POST",
  path: "/code-change-actions/{id}/stop",
  scope: "write",
  access: "team",
  input: z.object({ id }),
  run: async (context, input) => {
    const action = await prisma.codeChangeAction.findFirst({ where: { id: input.id, codeChange: { projectId: context.projectId } }, select: { id: true, kind: true, postId: true } });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    const who = await prisma.user.findUnique({ where: { id: actorUser(context.actor) }, select: { name: true } });
    // Who stopped it and when: analysed again, a stopped update stays as it is; the next person who tries is told ("stopped by Alice, just now").
    // Its time kept (`dueAt`): its review says when it would have gone out.
    const stopped = { status: "PENDING" as const, waitReason: `Stopped by ${who?.name ?? "the team"}`, decidedById: actorUser(context.actor), decidedAt: new Date() };
    // Under the project's lock, as an approval claims a post's update (one checking its parts sees all of them stopped, or
    // none) and as an article's publish checks its other edits (a Stop lands before it, holding it, or after: too late).
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, context.projectId);
      const { count } = await tx.codeChangeAction.updateMany({ where: { id: action.id, status: "SCHEDULED" }, data: stopped });
      if (count === 0) {
        throw new OperationError(409, "not_scheduled", "It isn't scheduled any more: it went out, or someone stopped it");
      }
      // A post's part: the rest of its update stops with it (one update, never half of it going out).
      if (POST_UPDATE.includes(action.kind) && action.postId) {
        await tx.codeChangeAction.updateMany({ where: { postId: action.postId, kind: { in: POST_UPDATE }, status: "SCHEDULED" }, data: stopped });
      }
    });
    return { id: action.id, status: "pending" };
  },
});

/** What an update that couldn't be applied waits with: the error's message, but past the plan's published articles one that stays true. */
const waitReasonOf = (error: OperationError) => (error.code === "article_limit" ? ARTICLES_FULL_WAIT : error.code === "draft" ? "Its article is a draft" : error.message);

/**
 * Autopilot's runner: each scheduled update that's due is checked again (waitsBecause) and applied as
 * Tuti (by the project's first owner, marked as Autopilot's own), or put back to waiting with why. Run
 * every minute (the worker's autopilot-due, or a timer where jobs run inline). Returns how many of each.
 */
export async function runDueAutopilot(now = new Date()): Promise<{ applied: number; waiting: number }> {
  const scheduled = await prisma.codeChangeAction.findMany({
    // A pull request's (a Verify fix is never scheduled).
    where: { status: "SCHEDULED", dueAt: { lte: now }, codeChangeId: { not: null } },
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
  const due = scheduled.flatMap(({ codeChangeId, codeChange, ...action }) => (codeChangeId && codeChange ? [{ ...action, codeChangeId, codeChange }] : []));
  let applied = 0;
  let waiting = 0;
  // Changes with an update that now waits for the team: told about, as an analysis is (code_change.ready).
  // (Null: a Verify fix, which has no pull request to tell about.)
  const nowWaiting = new Set<string | null>();
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
    // An article's edit publishes the version checked here, or nothing (a save after it is checked again next time).
    let revision = action.kind === "ARTICLE_EDIT" && action.articleId ? await newestRevision(action.articleId) : null;
    // An article's edits go out together: not while another one on it waits for someone (unsure, stopped or out of date).
    // A post's update too, every part of it qualifying still (applying one applies them all).
    const whole = POST_UPDATE.includes(action.kind) && action.postId ? await postUpdate(action.postId) : null;
    const others = whole ? whole.parts.filter((part) => part.id !== action.id) : [];
    const reason =
      (await waitsBecause(action, project)) ??
      (action.kind === "ARTICLE_EDIT" &&
      (await prisma.codeChangeAction.count({ where: { articleId: action.articleId, kind: "ARTICLE_EDIT", status: { in: ["PENDING", "STALE"] }, id: { not: action.id }, revisions: { some: {} } } })) > 0
        ? "Another edit to its article waits for you"
        : null) ??
      (others.some((part) => part.status === "PENDING")
        ? "Another part of its update waits for you"
        : ((await Promise.all(others.map((part) => waitsBecause({ ...part, codeChangeId: part.codeChange.id, postId: action.postId, articleId: null }, project)))).find(Boolean) ?? null));
    // A post's part that can't go, or whose update has a part that can't: all of it back under the schedule's rules, each
    // part saying why (a teammate's Stop keeping its words).
    if (reason && POST_UPDATE.includes(action.kind) && action.postId) {
      // Those going out by itself as the lock is taken (one held already this minute, with the rest, isn't counted twice).
      const held = await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const going = await tx.codeChangeAction.findMany({ where: { postId: action.postId, kind: { in: POST_UPDATE }, status: "SCHEDULED" }, select: { id: true } });
        if (going.length === 0) {
          return [];
        }
        await schedulePost(tx, action.postId!, await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: autopilotSettingsSelect }));
        return tx.codeChangeAction.findMany({ where: { id: { in: going.map((part) => part.id) }, status: "PENDING" }, select: { codeChangeId: true } });
      });
      for (const part of held) {
        waiting++;
        nowWaiting.add(part.codeChangeId);
      }
      continue;
    }
    if (reason) {
      await wait(action, reason);
      continue;
    }
    // A post's update goes out as the parts checked here, or not at all (one landing meanwhile is checked next time).
    if (POST_UPDATE.includes(action.kind) && action.postId) {
      // Its version as read (which parts, and which a teammate stopped: none, or it waited above).
      revision = whole!.version;
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
      await call(applyCodeChangeAction, byItself({ actor: { kind: "user", userId: owner.userId }, projectId }), { id: action.id, ...(revision && { revision }) });
    } catch (error) {
      log.error("Autopilot couldn't apply a due update", { error, actionId: action.id });
      const saved = (error as { saved?: boolean | "unknown" }).saved;
      // Saved before the failure: it went. Not: it waits for the team, saying why.
      if (!saved) {
        // An article's edit whose article changed as it went (an edit landed, a teammate saved): nobody reviewed anything,
        // so it's checked again by the schedule's rules (all of its edits going out together after a fresh hold, or waiting).
        // A post's update that changed as it went (another part landed, or a teammate stopped one): the same, all its parts together.
        if (
          (action.kind === "ARTICLE_EDIT" ? action.articleId : POST_UPDATE.includes(action.kind) && action.postId) &&
          error instanceof OperationError &&
          (error.code === "changed" || error.code === "waits")
        ) {
          await prisma.$transaction(async (tx) => {
            await lockProject(tx, projectId);
            // Back on the schedule it was taken from, so the rules say why it stops, if it does.
            await tx.codeChangeAction.updateMany({ where: { id: action.id, status: "PENDING", decidedById: owner.userId }, data: { status: "SCHEDULED", decidedById: null, waitReason: null } });
            const settings = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: autopilotSettingsSelect });
            await (action.kind === "ARTICLE_EDIT" ? scheduleArticle(tx, action.articleId!, settings) : schedulePost(tx, action.postId!, settings));
          });
          if ((await prisma.codeChangeAction.count({ where: { id: action.id, status: "PENDING" } })) > 0) {
            waiting++;
            nowWaiting.add(action.codeChangeId);
          }
          continue;
        }
        // A post's part that failed: all of its update waits, this part saying why (the others, that it waits), so the rest
        // of it due this minute doesn't put it back on a fresh hold and lose the failure.
        if (POST_UPDATE.includes(action.kind) && action.postId) {
          const why = error instanceof OperationError ? error.message : "Couldn't apply it";
          const held = await prisma.$transaction(async (tx) => {
            await lockProject(tx, projectId);
            const mine = await tx.codeChangeAction.updateMany({ where: { id: action.id, status: { in: ["PENDING", "STALE"] } }, data: { dueAt: null, waitReason: why, decidedById: null } });
            // Decided meanwhile (dismissed, say): it holds nothing back, and the rest goes on as it was.
            if (mine.count === 0) {
              return [];
            }
            const rest = await tx.codeChangeAction.findMany({ where: { postId: action.postId, kind: { in: POST_UPDATE }, status: "SCHEDULED" }, select: { id: true, codeChangeId: true } });
            await tx.codeChangeAction.updateMany({
              where: { id: { in: rest.map((part) => part.id) } },
              data: { status: "PENDING", dueAt: null, waitReason: "Another part of its update waits for you" },
            });
            return [action.codeChangeId, ...rest.map((part) => part.codeChangeId)];
          });
          for (const codeChangeId of held) {
            waiting++;
            nowWaiting.add(codeChangeId);
          }
          continue;
        }
        await wait(action, error instanceof OperationError ? waitReasonOf(error) : "Couldn't apply it", true);
        continue;
      }
      // Can't tell whether it went: it stays applied (never twice), credited to nobody, and the page says to check it.
      // ponytail: only its card and the error log say so (Home and the list count it as done); a "checked" step
      // that keeps it on Home till someone clears it, if this ever shows up outside a database outage.
      if (saved === "unknown") {
        const after = await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { payload: true, status: true } });
        // Put back to wait for the team by apply itself (its comment maybe posted, said in its reason): left as it is,
        // and told about, as every update that waits after all is.
        if (after.status !== "APPLIED") {
          const held = await prisma.codeChangeAction.findMany({ where: { postId: action.postId ?? "", status: "PENDING", waitReason: COMMENT_UNSURE }, select: { codeChangeId: true } });
          waiting += held.length;
          for (const part of held) {
            nowWaiting.add(part.codeChangeId);
          }
          continue;
        }
        await prisma.codeChangeAction.update({ where: { id: action.id }, data: { decidedById: null, payload: { ...((after.payload ?? {}) as Prisma.JsonObject), unsure: true } } });
        continue;
      }
    }
    // Autopilot's own: nobody approved it. An article's edit went out with every other edit in its changes, and a post's
    // part with the rest of its update: those too, the parts its own claim took (decided at the same moment as it; not
    // one approved by hand meanwhile).
    const claimedAt = POST_UPDATE.includes(action.kind) ? (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { decidedAt: true } })).decidedAt : null;
    const went =
      (action.kind === "ARTICLE_EDIT" && action.articleId) || (POST_UPDATE.includes(action.kind) && action.postId)
        ? await prisma.codeChangeAction.findMany({
            where: {
              ...(action.kind === "ARTICLE_EDIT" ? { articleId: action.articleId, kind: "ARTICLE_EDIT" } : { postId: action.postId, kind: { in: POST_UPDATE } }),
              status: "APPLIED",
              decidedById: owner.userId,
              decidedAt: claimedAt ?? { gte: takenAt },
            },
            select: { id: true, codeChangeId: true, createdAt: true, payload: true },
          })
        : [await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: action.id }, select: { id: true, codeChangeId: true, createdAt: true, payload: true } })];
    for (const one of went) {
      // Marked Autopilot's own once it's done (a request emails its voters first): when (`autoAt`) says what's news to an email.
      const markedAt = new Date();
      await prisma.codeChangeAction.update({
        where: { id: one.id },
        data: { decidedById: null, payload: { ...((one.payload ?? {}) as Prisma.JsonObject), auto: true, autoAt: markedAt.toISOString() } },
      });
      applied++;
      // What customers see went out: its owners hear of it (Autopilot's email), whenever its notices were queued.
      // Told now, so a later update failing can't keep this one from them.
      if (action.kind === "RESOLVES" || action.kind === "MOVES_FORWARD" || action.kind === "ARTICLE_EDIT") {
        if (one.codeChangeId) {
          await tellOwners(one.codeChangeId, one.createdAt, { from: takenAt, to: new Date() });
        }
      }
    }
  }
  for (const codeChangeId of [...nowWaiting].filter((id) => id !== null)) {
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
  const count = await prisma.codeChangeAction.count({ where: { codeChangeId, ...inReview, status: { in: ["PENDING", "STALE"] } } });
  // (A changelog line the previous release left, held back: it's not the team's to review.)
  if (count === 0) {
    return;
  }
  const { projectId, project, ...pullRequest } = change;
  await emitEvent(projectId, "code_change.ready", {
    codeChange: { ...pullRequest, waiting: count, page: `${appUrl().origin}/app/${project.slug}/autopilot/activity/${change.id}` },
  });
}

export const dismissCodeChangeAction = defineOperation({
  name: "codeChangeActions.dismiss",
  summary:
    "Dismiss a proposed action, with an optional reason (it isn't proposed again for this code change). A post's part, waiting or going out by itself, takes only its part out of the post's update; with `revision` (the post's update's version, as `apply` takes it), every part of that update is dismissed at once, refused (409) when it changed since. An article's edit is taken out of the article's unpublished changes by section, everything else in them staying; refused (409) when an edit on top of it changed the same sections",
  method: "POST",
  path: "/code-change-actions/{id}/dismiss",
  scope: "write",
  access: "team",
  input: z.object({ id, reason: z.string().trim().max(500).optional(), revision: z.string().min(1).max(100).optional() }),
  example: { reason: "Only part of it; we'll say so when it's all out" },
  run: async (context, input) => {
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: input.id, ...ofProject(context.projectId) },
      select: { id: true, kind: true, articleId: true, postId: true, revisions: { select: { id: true }, take: 1 } },
    });
    if (!action) {
      throw new OperationError(404, "not_found", "Action not found");
    }
    // An article's edit, also once scheduled: the page's Dismiss takes all of them, and dismissing one may have
    // scheduled the rest again. A post's part too: only its part of the update comes out.
    const part = POST_UPDATE.includes(action.kind) && action.postId;
    const tagged = (action.kind === "ARTICLE_EDIT" && action.articleId && action.revisions.length > 0) || part;
    const dismiss = (db: Prisma.TransactionClient) =>
      db.codeChangeAction
        .updateMany({
          where: { id: action.id, status: { in: tagged ? ["PENDING", "STALE", "SCHEDULED"] : ["PENDING", "STALE"] } },
          data: { status: "DISMISSED", decidedById: actorUser(context.actor), decidedAt: new Date(), dismissReason: input.reason ?? "", dueAt: null },
        })
        .then((result) => result.count);
    // An article's edit waiting in its unpublished changes: only its sections come out of them.
    if (action.kind === "ARTICLE_EDIT" && action.articleId && action.revisions.length > 0) {
      const articleId = action.articleId;
      await takeOutEdit(context, articleId, action.id, "changes", dismiss);
      // The one that held the others back may be gone: they go out by themselves again if each qualifies, joining any
      // already going out at their time (the hold restarts only as an edit lands). Settings read under the lock, so a
      // switch turned off meanwhile counts.
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, context.projectId);
        const left = await tx.codeChangeAction.findMany({
          where: { articleId, kind: "ARTICLE_EDIT", status: { in: ["PENDING", "SCHEDULED"] }, revisions: { some: {} } },
          select: { status: true, decidedById: true },
        });
        if (left.some((edit) => edit.status === "PENDING" && !edit.decidedById)) {
          await scheduleArticle(tx, articleId, await tx.project.findUniqueOrThrow({ where: { id: context.projectId }, select: autopilotSettingsSelect }), { keepDue: true });
        }
      });
      return { id: action.id, status: "dismissed" };
    }
    // The whole post's update as reviewed (`revision`): every part at once, under the lock, so none is left to go out by
    // itself if one of them can't be dismissed.
    if (part && input.revision !== undefined) {
      const postId = action.postId!;
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, context.projectId);
        const whole = await postUpdate(postId, tx);
        if (!whole.parts.some((one) => one.id === action.id)) {
          throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
        }
        if (whole.version !== input.revision) {
          throw new OperationError(409, "changed", "The post's update changed since you reviewed it: review it again before dismissing");
        }
        await tx.codeChangeAction.updateMany({
          where: { id: { in: whole.parts.map((one) => one.id) }, status: { in: ["PENDING", "SCHEDULED"] } },
          data: { status: "DISMISSED", decidedById: actorUser(context.actor), decidedAt: new Date(), dismissReason: input.reason ?? "", dueAt: null },
        });
      });
      return { id: action.id, status: "dismissed" };
    }
    const count = await dismiss(prisma);
    if (count === 0) {
      throw new OperationError(409, "already_decided", "Someone already applied or dismissed this");
    }
    // The part that held the post's update back may be gone: the rest go out by themselves again if each qualifies, at
    // the time of any already going out (the hold restarts only as a part lands). A completion dismissed: the progress
    // updates left are the post's update again.
    if (part) {
      const postId = action.postId!;
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, context.projectId);
        const left = await tx.codeChangeAction.findMany({ where: { postId, kind: { in: POST_UPDATE }, status: "PENDING" }, select: { decidedById: true } });
        if (left.some((one) => !one.decidedById)) {
          await schedulePost(tx, postId, await tx.project.findUniqueOrThrow({ where: { id: context.projectId }, select: autopilotSettingsSelect }), { keepDue: true });
        }
      });
    }
    return { id: action.id, status: "dismissed" };
  },
});
