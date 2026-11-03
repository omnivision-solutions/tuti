import { prisma, type Prisma } from "@tuti/db";
import { analysisOn, enqueue, lockProject, newestRevision, NO_REPOSITORY, type Statement, VERIFY_OFF } from "@tuti/jobs";
import { z } from "zod";

import { aiOrRefuse } from "./credits";
import { defineOperation, OperationError } from "./define";

/**
 * Verify (docs/plan.md, V5): an article checked against the project's repository, the default branch at its latest
 * commit, by hand. The run is the `verify-article` job (inline, it's done as this returns); its fix for what's out of
 * date is an Autopilot update, reviewed on the article's review like a pull request's edit.
 */

const slug = z.string().trim().min(1).max(80);

/**
 * A run still running this long after its job started work has stopped (the worker went away; it's tried once): settled
 * as failed. Time in the queue doesn't count, but one never picked up in QUEUED_STALE_MS (its job lost) is settled too.
 */
export const RUN_STALE_MS = 30 * 60_000;
const QUEUED_STALE_MS = 24 * 60 * 60_000;

/**
 * The article's runs that have stopped (see RUN_STALE_MS), settled as failed, so neither the history nor the API waits
 * on them. A job that was only slow writes nothing after this: it claims its run as it saves (verify-article).
 */
const settleStale = (articleId: string, db: Prisma.TransactionClient = prisma) =>
  db.articleVerification.updateMany({
    where: {
      articleId,
      state: "RUNNING",
      OR: [{ startedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }, { startedAt: null, createdAt: { lt: new Date(Date.now() - QUEUED_STALE_MS) } }],
    },
    data: { state: "FAILED", reason: "It didn't finish. Verify again.", finishedAt: new Date() },
  });

const verificationSelect = {
  id: true,
  state: true,
  reason: true,
  repo: true,
  commit: true,
  revisionId: true,
  current: true,
  outdated: true,
  unclear: true,
  statements: true,
  createdAt: true,
  finishedAt: true,
  startedBy: { select: { name: true } },
  fixes: { select: { id: true, status: true, dismissReason: true, decidedAt: true, decidedBy: { select: { name: true } }, revisions: { select: { id: true }, take: 1 } }, take: 1 },
} satisfies Prisma.ArticleVerificationSelect;

const FIX_STATUSES = { PENDING: "waiting", SCHEDULED: "waiting", STALE: "waiting", APPLIED: "approved", DISMISSED: "dismissed", UNDONE: "undone" } as const;

/** A run as the API and the app show it. */
export function verificationView(run: Prisma.ArticleVerificationGetPayload<{ select: typeof verificationSelect }>) {
  const fix = run.fixes[0];
  return {
    id: run.id,
    /** running, done, changed (another edit landed while it ran: no fix written), failed, or skipped (verified at this commit already). */
    state: run.state.toLowerCase() as "running" | "done" | "changed" | "failed" | "skipped",
    /** Why it failed, was skipped, or wrote no fix. */
    reason: run.reason,
    repo: run.repo,
    commit: run.commit,
    /** The article's revision it checked. */
    revision: run.revisionId,
    counts: { current: run.current, outdated: run.outdated, unclear: run.unclear },
    /** Per statement: what the article says, whether it's still true, out of date or can't be told, and the files that show it. */
    statements: run.statements as Statement[],
    /** Its fix, an Autopilot update (codeChangeActions.dismiss, .undo; approved with the article's changes), and what became of it. */
    fix: fix
      ? {
          id: fix.id,
          status: FIX_STATUSES[fix.status],
          revision: fix.revisions[0]?.id ?? null,
          decidedBy: fix.decidedBy?.name ?? null,
          decidedAt: fix.decidedAt?.toISOString() ?? null,
          dismissReason: fix.dismissReason,
        }
      : null,
    startedBy: run.startedBy?.name ?? null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export type VerificationView = ReturnType<typeof verificationView>;

/** An article's verification history, newest first. ponytail: the latest 20; page when teams need older ones. */
export async function articleVerifications(articleId: string) {
  await settleStale(articleId);
  const runs = await prisma.articleVerification.findMany({ where: { articleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: verificationSelect });
  return runs.map(verificationView);
}

const teamArticle = async (projectId: string, articleSlug: string) => {
  const article = await prisma.article.findFirst({ where: { projectId, slug: articleSlug, deletedAt: null }, select: { id: true, publishedAt: true } });
  if (!article) {
    throw new OperationError(404, "not_found", `There's no article “${articleSlug}”`);
  }
  return article;
};

/** Why Verify can't run on an article now (null: it can), as articles.verify refuses it, credits aside. */
export async function verifyUnavailable(projectId: string, published: boolean): Promise<string | null> {
  if (!published) {
    return "Only a published article can be verified.";
  }
  if (!(await analysisOn(projectId))) {
    return VERIFY_OFF;
  }
  if ((await prisma.githubRepository.count({ where: { connection: { projectId } } })) === 0) {
    return NO_REPOSITORY;
  }
  return null;
}

export const verifyArticle = defineOperation({
  name: "articles.verify",
  summary:
    "Verify a published docs article against the project's GitHub repository (its default branch at its latest commit): what it says that's still true, out of date or can't be told, with the files that show it, and an Autopilot update fixing what's out of date (it waits for the team on the article's review, codeChanges.target). Checks the article's newest version (its unpublished changes, with every edit waiting in them). Sends repository files (secrets left out) to the AI provider, and costs AI credits where they're used (402 when out). Only while the project analyses merged pull requests and has a repository (409 otherwise). One runs per article at a time: starting it again returns the one running. Run again at the same commit on the same version, it's skipped",
  method: "POST",
  path: "/articles/{slug}/verify",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ actor, projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    const unavailable = await verifyUnavailable(projectId, article.publishedAt !== null);
    if (unavailable) {
      throw new OperationError(409, unavailable === VERIFY_OFF ? "analysis_off" : unavailable === NO_REPOSITORY ? "no_repository" : "not_published", unavailable);
    }
    // One running already is returned as it is, whatever the credits now (checked again under the lock below).
    const running = await prisma.articleVerification.findFirst({
      where: { articleId: article.id, state: "RUNNING", OR: [{ startedAt: null }, { startedAt: { gte: new Date(Date.now() - RUN_STALE_MS) } }] },
      select: verificationSelect,
    });
    if (running) {
      return verificationView(running);
    }
    await aiOrRefuse(projectId, "code_changes");
    // Checked and started under the project's lock: two starts at once (a double click, a retry) make one run.
    const started = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      // Still published (and there) under the lock: an unpublish or delete since the check above refuses it.
      const still = await tx.article.findFirst({ where: { id: article.id, deletedAt: null }, select: { publishedAt: true } });
      if (!still) {
        throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
      }
      if (!still.publishedAt) {
        throw new OperationError(409, "not_published", "Only a published article can be verified.");
      }
      await settleStale(article.id, tx);
      const running = await tx.articleVerification.findFirst({ where: { articleId: article.id, state: "RUNNING" }, select: verificationSelect });
      if (running) {
        return { running };
      }
      const run = await tx.articleVerification.create({
        data: {
          projectId,
          articleId: article.id,
          startedById: actor.kind === "user" ? actor.userId : actor.createdById,
          // The version checked: an edit landing after this is one it didn't see, so its fix isn't written.
          revisionId: await newestRevision(article.id, tx),
        },
        select: { id: true },
      });
      return { run };
    });
    if (started.running) {
      return verificationView(started.running);
    }
    const run = started.run!;
    try {
      await enqueue("verifyArticle", { verificationId: run.id });
    } catch {
      await prisma.articleVerification.updateMany({ where: { id: run.id, state: "RUNNING" }, data: { state: "FAILED", reason: "Couldn't start it.", finishedAt: new Date() } });
      throw new OperationError(503, "unavailable", "Couldn't start Verify. Try again in a moment.");
    }
    return verificationView(await prisma.articleVerification.findUniqueOrThrow({ where: { id: run.id }, select: verificationSelect }));
  },
});

export const listVerifications = defineOperation({
  name: "articles.verifications",
  summary: "A docs article's verification history (articles.verify), newest first: each run's commit, what it found per statement, and its fix",
  method: "GET",
  path: "/articles/{slug}/verifications",
  scope: "read",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => ({ verifications: await articleVerifications((await teamArticle(projectId, input.slug)).id) }),
});
