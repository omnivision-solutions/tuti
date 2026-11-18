import { isDeepStrictEqual } from "node:util";

import { toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { codeChangesEnabled, log, planIncludes, roleModel } from "@tuti/shared";

import { docOf, editsInChanges, hasTeammateEdit, recordRevision, scheduleArticle, takeOut, versions } from "./article-layers";
import { autopilotSettingsSelect } from "./autopilot";
import { codeChange, releaseStoppedRewrites, REWRITING, REWRITTEN } from "./code-changes";
import { aiPaused } from "./credits";
import { CHECK_NO_CREDITS, CHECK_NO_REPOSITORY, CHECK_UNCLEAR, CHECKS_OFF, checksOn } from "./edit-review";
import { lockProject } from "./running-draft";

/**
 * Once the check is on for a project (docs/plan.md, E6), its waiting article edits nobody changed are written again by
 * the current pipeline. An operator's action, run by hand (apps/worker: `rewrite:waiting-edits <slug>`), never by
 * itself; refused for a project the check isn't on for, or where Autopilot is off.
 *
 * Which: an edit waiting (or going out by itself) in a published article's unpublished changes, written before the
 * check measured it (no `check.scope`) or that it didn't check (UNCHECKED: Checks off, no credits or repository, a
 * review it couldn't read), that nobody stopped, whose pull request's analysis is ready, on an article with no
 * person's unpublished change (hasTeammateEdit: one anywhere in it leaves all its edits as they are). Each pull
 * request's together, the newest merged first (an edit on top comes out before the one under it): under the project's
 * lock and the pull request's (a person's "Analyse again" meanwhile waits for it, then is the only analysis, a whole
 * one), while its analysis is still ready, each is taken out of its article by section, as Dismiss does (one that
 * can't be stays as it is), and dismissed by nobody saying REWRITTEN; the article's other edits go out by themselves
 * again if they qualify; and the pull request is marked to be written again (failed, saying REWRITING, its retry an hour
 * away). Then each pull request so marked (this run's, and any a run that stopped left: failed, paused, or analysing in
 * its process for over REWRITE_STALE_MS; not one a queued job holds, see releaseStoppedRewrites) is analysed here, one
 * at a time, the oldest merged first, so each is written knowing the edits of those merged before
 * it: claimed first, so the retries' sweep (which takes over the ones left if this stops) and this never both run one.
 * That analysis is the help center's part only (`docsOnly`: no gate, no posts, its posts' updates, links and changelog
 * line left as they are), whichever path runs it, by its marker (`rewriteDocsOnly`), which only its finishing or a
 * person's "Analyse again" (a whole analysis) clears: paused for credits and resumed, or retried after the AI provider
 * didn't answer (as any analysis, by the sweep), it's still docs-only. It writes its edits again (one of its edits left
 * in an article keeps a new one off it) and tells the team as any analysis does (each person's in one email). Refused,
 * before anything is taken out, while the project is out of AI credits or has Checks off. Run again, it finds the
 * rewritten edits measured and nothing marked, so it does nothing more (but writes again one that came back unchecked).
 */
export async function rewriteWaitingEdits(slug: string, now = new Date()): Promise<{ edits: number; pullRequests: number; analysed: number }> {
  if (!checksOn(slug)) {
    throw new Error(`The check isn't on for ${slug}: list it in AUTOPILOT_CHECKS_PROJECTS first`);
  }
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, aiModels: true, aiLevels: true, ...autopilotSettingsSelect } });
  if (!project) {
    throw new Error(`There's no project ${slug}`);
  }
  if (!codeChangesEnabled() || !project.analyseCodeChanges || !planIncludes(project.plan, "codeChanges")) {
    throw new Error(`Autopilot is off for ${slug}`);
  }
  // Nothing taken out that its analysis couldn't write again now.
  if (await aiPaused(project.id)) {
    throw new Error(`${slug} is out of AI credits: nothing was taken out. Run it again once it has some`);
  }
  if (roleModel(project, "code_changes_check") === "off") {
    throw new Error(`Checks is off for ${slug}: nothing was taken out. Switch it on in Autopilot's settings first`);
  }
  const waiting = await prisma.codeChangeAction.findMany({
    where: {
      kind: "ARTICLE_EDIT",
      status: { in: ["PENDING", "SCHEDULED"] },
      decidedById: null,
      revisions: { some: {} },
      article: { publishedAt: { not: null }, deletedAt: null },
      codeChange: { projectId: project.id, state: "READY" },
    },
    orderBy: [{ codeChange: { mergedAt: "desc" } }, { createdAt: "desc" }],
    select: { id: true, articleId: true, codeChangeId: true, payload: true },
  });
  // Written before the check measured it, or measured but not checked (UNCHECKED): a later run, with Checks on, takes it.
  const unmeasured = waiting.filter((edit) => {
    const check = ((edit.payload ?? {}) as { check?: { scope?: unknown; reason?: unknown } }).check;
    return !check?.scope || UNCHECKED.includes(check.reason as string);
  });
  let edits = 0;
  let pullRequests = 0;
  const byChange = new Map<string, typeof unmeasured>();
  for (const edit of unmeasured) {
    byChange.set(edit.codeChangeId!, [...(byChange.get(edit.codeChangeId!) ?? []), edit]);
  }
  for (const [codeChangeId, its] of byChange) {
    const taken = await prisma.$transaction(async (tx) => {
      await lockProject(tx, project.id);
      // Being analysed again meanwhile (a person's "Analyse again"): that analysis is the rewrite. Under the change's lock
      // (as writeChangelogLine takes it), so a person's claim meanwhile waits for this and then finds it marked (failed):
      // their analysis, a whole one, is the only one.
      await tx.$queryRaw`SELECT 1 FROM code_change WHERE id = ${codeChangeId} FOR UPDATE`;
      if ((await tx.codeChange.count({ where: { id: codeChangeId, state: "READY" } })) === 0) {
        return 0;
      }
      const articles: string[] = [];
      for (const { id, articleId } of its) {
        // As things stand under the lock: still waiting, nobody's, in its published article's changes, and no person's
        // change in that article.
        const still = { id, status: { in: ["PENDING" as const, "SCHEDULED" as const] }, decidedById: null, revisions: { some: {} }, article: { publishedAt: { not: null }, deletedAt: null } };
        if ((await tx.codeChangeAction.count({ where: still })) === 0 || (await hasTeammateEdit(articleId!, tx))) {
          continue;
        }
        const article = await tx.article.findUniqueOrThrow({ where: { id: articleId! }, select: { changes: { select: { body: true, content: true } } } });
        const inChanges = await editsInChanges(articleId!, tx);
        const mine = inChanges.find((edit) => edit.actionId === id);
        const out = mine && article.changes ? takeOut(mine, docOf(article.changes), inChanges) : null;
        if (!out || "refused" in out) {
          continue;
        }
        await tx.articleChanges.update({ where: { articleId: articleId! }, data: { body: toPlainText(out.doc), content: out.doc } });
        // Nothing left unpublished: no changes (as a save that puts the article back does).
        const { live, saved } = await versions(tx, articleId!);
        if (isDeepStrictEqual(live, saved)) {
          await tx.articleChanges.delete({ where: { articleId: articleId! } });
        }
        await tx.codeChangeAction.update({ where: { id }, data: { status: "DISMISSED", decidedAt: now, dueAt: null, dismissReason: REWRITTEN } });
        await recordRevision(tx, articleId!, null);
        articles.push(articleId!);
      }
      if (articles.length === 0) {
        return 0;
      }
      // The sweep's, only if this run stops first: the oldest merged first then too (a millisecond before the next newer).
      // Still ready, or nothing taken out (rolled back).
      const marked = await tx.codeChange.updateMany({
        where: { id: codeChangeId, state: "READY" },
        data: { state: "FAILED", reason: REWRITING, retryAt: new Date(now.getTime() + SWEEP_AFTER_MS - pullRequests), retries: 0, retryPastGate: false, rewriteDocsOnly: true },
      });
      if (marked.count === 0) {
        throw new NotReady();
      }
      // The edit that held the article's others back may be gone, as after a Dismiss.
      for (const articleId of new Set(articles)) {
        if ((await tx.codeChangeAction.count({ where: { articleId, kind: "ARTICLE_EDIT", status: "PENDING", decidedById: null, revisions: { some: {} } } })) > 0) {
          await scheduleArticle(tx, articleId, project, { keepDue: true });
        }
      }
      return articles.length;
    }).catch((error: unknown) => {
      if (error instanceof NotReady) {
        return 0;
      }
      throw error;
    });
    if (taken > 0) {
      edits += taken;
      pullRequests++;
    }
  }
  let analysed = 0;
  await releaseStoppedRewrites(now);
  const left = { projectId: project.id, rewriteDocsOnly: true, state: { in: ["FAILED" as const, "PAUSED" as const] } };
  const marked = await prisma.codeChange.findMany({ where: left, orderBy: [{ mergedAt: "asc" }, { id: "asc" }], select: { id: true } });
  for (const { id } of marked) {
    // Claimed in this process (no claim for a queued job): stopped mid-analysis, it's released after REWRITE_STALE_MS.
    const { count } = await prisma.codeChange.updateMany({ where: { ...left, id }, data: { state: "ANALYSING", reason: "", retryAt: null, claim: null } });
    if (count === 0) {
      continue;
    }
    analysed++;
    // A failure is the code change's to say (failed, with why, and when it's tried again); the next one goes on.
    await codeChange({ codeChangeId: id, force: true, pastGate: false, resume: false }, log).catch((error: unknown) => log.error("Writing a pull request's edits again failed", { error, codeChangeId: id }));
  }
  return { edits, pullRequests, analysed };
}

/**
 * When the retries' sweep takes over a pull request marked to be written again, should the run that marked it stop.
 * ponytail: a run still going after it (a few minutes a pull request, so more than a dozen or so marked) may see the
 * sweep take the ones it hasn't reached yet, in parallel on Hatchet; run it on fewer, or longer, if that matters.
 */
const SWEEP_AFTER_MS = 3_600_000;

/** What the check stores for an edit it didn't review (or couldn't read the review of): not measured, for a later run. */
const UNCHECKED = [CHECKS_OFF, CHECK_NO_CREDITS, CHECK_NO_REPOSITORY, CHECK_UNCLEAR];

/** The pull request wasn't ready any more when it was to be marked: the transaction's edits are rolled back. */
class NotReady extends Error {}
