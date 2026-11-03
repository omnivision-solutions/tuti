import { changedSections } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { type Ai, decide, type DecisionQuestion, log } from "@tuti/shared";

import { editName, editsInChanges, newestRevision } from "./article-layers";
import { analysisOn } from "./code-changes";
import { aiPaused, aiPausedIn } from "./credits";
import { enqueue } from "./index";
import { lockProject } from "./running-draft";
import { settleStale } from "./verify";

/**
 * Verify after edits pile up (docs/plan.md, V6): once a pull request's edit lands on an article, the decision model
 * says whether the pull requests' edits waiting on it (many, rewriting each other's sections, or unsure) call for a
 * full Verify, and only then one is started, by Autopilot. A Verify fix is never one of those edits, and landing one
 * never asks, so Verify can't start itself again.
 */

/** How sure the decision model must be that the article needs Verify. ponytail: one bar for every project, until each is calibrated on its own. */
export const VERIFY_AFTER = 0.7;
/** Pull requests' edits waiting on an article before it's asked: one edit is reviewed on its own. */
const ASKED_FROM = 2;

export const VERIFY_QUESTION: Record<string, DecisionQuestion> = {
  verify: {
    type: "noul",
    instructions:
      "A help article has edits from several merged pull requests waiting for review, each written on top of the one before. Should the whole article be checked against the product's code now?",
    criteria: {
      true: "The edits have piled up, later ones rewrite sections earlier ones wrote, or they're unsure: the article as a whole may no longer match the product.",
      false: "A few sure edits in different sections: reviewing each one is enough.",
    },
  },
};

/**
 * The pull requests' edits waiting on the article (a Verify fix has none) that its last check didn't see, so the ones it
 * checked don't pile up again with every later merge. Its last check (`checked`): a run that skipped it as verified, or
 * that told something (a statement still true or out of date, as verify-article counts it), done or with an edit
 * landing after it checked. One that changed before it checked anything, or could tell nothing, didn't check it.
 * `fresh`: how many of them landed since Autopilot's own last run, whatever came of it (failed, or telling nothing), so
 * it tries again only on new edits, and a pile of edits Verify can't tell about isn't paid for again with every merge.
 */
async function uncheckedEdits(articleId: string, db: Prisma.TransactionClient = prisma) {
  const newest = (where: Prisma.ArticleVerificationWhereInput) =>
    db.articleVerification.findFirst({ where: { articleId, ...where }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } });
  const checked = await newest({ OR: [{ state: "SKIPPED" }, { state: { in: ["DONE", "CHANGED"] }, OR: [{ current: { gt: 0 } }, { outdated: { gt: 0 } }] }] });
  const tried = await newest({ startedReason: { not: "" }, state: { not: "RUNNING" } });
  const since = (run: { createdAt: Date } | null) => (edit: { createdAt: Date }) => !run || edit.createdAt > run.createdAt;
  const edits = (await editsInChanges(articleId, db)).filter((edit) => edit.number !== null && since(checked)(edit));
  return { checked, edits, fresh: edits.filter(since(tried)).length };
}

/** Whether a Verify all going on the project hasn't reached the article yet: it checks it then, so Autopilot doesn't too. */
const comingInVerifyAll = async (projectId: string, articleId: string, db: Prisma.TransactionClient = prisma) =>
  (await db.verifyAll.findMany({ where: { projectId, state: "RUNNING" }, select: { articleIds: true, taken: true } })).some(
    (all) => all.articleIds.indexOf(articleId) >= all.taken,
  );

/**
 * After a pull request's edit landed on the article: asks the decision model whether it needs Verify, and starts it if
 * so. Asked only with ASKED_FROM pull requests' edits waiting that its last check didn't see (one started before they
 * landed saw none of them), landed since Autopilot last tried, and told about all those its last check didn't see,
 * while Verify could run (the analysis switch on, AI credits left, none running on the
 * article, nor a Verify all about to reach it). A run in a Verify all is a person's check: a person started it. A rerun
 * at the same commit on the same version is skipped by the run itself. Returns whether it started one.
 */
export async function verifyAfterEdit(projectId: string, articleId: string, use: Ai): Promise<boolean> {
  if (!(await analysisOn(projectId)) || (await aiPaused(projectId))) {
    return false;
  }
  await settleStale(articleId);
  if ((await prisma.articleVerification.count({ where: { articleId, state: "RUNNING" } })) > 0 || (await comingInVerifyAll(projectId, articleId))) {
    return false;
  }
  const { checked, edits, fresh } = await uncheckedEdits(articleId);
  if (fresh < ASKED_FROM) {
    return false;
  }
  // Two edits changing one section: the later one rewrote what the earlier one wrote.
  const sections = edits.map((edit) => (edit.base ? changedSections(edit.base, edit.doc) : new Set<string>()));
  const rewritten = edits.filter((_, i) => sections.slice(0, i).some((earlier) => [...sections[i]!].some((key) => earlier.has(key))));
  const probabilities = await prisma.codeChangeAction.findMany({ where: { id: { in: edits.map((edit) => edit.actionId) } }, select: { probability: true } });
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId }, select: { title: true } });
  const state = {
    article: article.title,
    pull_requests_edits_waiting: edits.length,
    edits_rewriting_an_earlier_edit: rewritten.length,
    least_sure_edit: Math.min(...probabilities.map((one) => one.probability)),
  };
  const answer = (await decide(state, VERIFY_QUESTION, { meter: use.meter })).verify!;
  const yes = answer.type === "noul" ? answer.noul : 0;
  log.info("Verify after edits: decided", { projectId, articleId, yes, waiting: edits.length, rewriting: rewritten.length });
  if (yes < VERIFY_AFTER) {
    return false;
  }
  const rewriting = rewritten.length > 0 ? `, ${rewritten.map(editName).join(", ")} rewriting a section an earlier one changed` : "";
  const why = `Started by Autopilot: ${edits.length} pull requests' edits wait on it${checked ? " since its last check" : ""}${rewriting}.`;
  // Started under the project's lock, as articles.verify starts one: never beside a run started meanwhile.
  const run = await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const still = await tx.article.findFirst({ where: { id: articleId, deletedAt: null, publishedAt: { not: null } }, select: { id: true } });
    if (!still || (await tx.articleVerification.count({ where: { articleId, state: "RUNNING" } })) > 0 || (await comingInVerifyAll(projectId, articleId, tx))) {
      return null;
    }
    // Turned off, or out of credits, while the model decided: no run. Read in the transaction: aiPaused can give free
    // credits, in a transaction of its own that would wait on this one's lock.
    if (!(await analysisOn(projectId, tx)) || (await aiPausedIn(tx, projectId))) {
      return null;
    }
    // Only on the edits it decided on: a run that finished meanwhile (another analysis's) checked some of them, and an
    // edit landing meanwhile is another analysis's, which decides again with it.
    const now = await uncheckedEdits(articleId, tx);
    const ids = now.edits.map((edit) => edit.actionId);
    if (now.fresh < ASKED_FROM || ids.length !== edits.length || edits.some((edit) => !ids.includes(edit.actionId))) {
      return null;
    }
    return tx.articleVerification.create({
      data: { projectId, articleId, startedReason: why, revisionId: await newestRevision(articleId, tx) },
      select: { id: true },
    });
  });
  if (!run) {
    return false;
  }
  try {
    await enqueue("verifyArticle", { verificationId: run.id });
  } catch (error) {
    await prisma.articleVerification.updateMany({ where: { id: run.id, state: "RUNNING" }, data: { state: "FAILED", reason: "Couldn't start it.", finishedAt: new Date() } });
    throw error;
  }
  return true;
}
