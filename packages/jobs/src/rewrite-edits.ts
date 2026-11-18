import { isDeepStrictEqual } from "node:util";

import { toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { codeChangesEnabled, log, planIncludes } from "@tuti/shared";

import { docOf, editsInChanges, hasTeammateEdit, recordRevision, scheduleArticle, takeOut, versions } from "./article-layers";
import { autopilotSettingsSelect } from "./autopilot";
import { codeChange, REWRITING, REWRITTEN } from "./code-changes";
import { checksOn } from "./edit-review";
import { lockProject } from "./running-draft";

/**
 * Once the check is on for a project (docs/plan.md, E6), its waiting article edits nobody changed are written again by
 * the current pipeline. An operator's action, run by hand (apps/worker: `rewrite:waiting-edits <slug>`), never by
 * itself; refused for a project the check isn't on for, or where Autopilot is off.
 *
 * Which: an edit waiting (or going out by itself) in a published article's unpublished changes, written before the
 * check measured it (no `check.scope`), that nobody stopped, whose pull request's analysis is ready, on an article with no
 * person's unpublished change (hasTeammateEdit: one anywhere in it leaves all its edits as they are). Each pull
 * request's together, the newest merged first (an edit on top comes out before the one under it): under the project's
 * lock each is taken out of its article by section, as Dismiss does (one that can't be stays as it is), and dismissed
 * by nobody saying REWRITTEN; the article's other edits go out by themselves again if they qualify; and the pull
 * request is marked to be written again (failed, saying REWRITING, its retry an hour away). Then each pull request so
 * marked (this run's, and any a run that stopped left) is analysed here, one at a time, the oldest merged first, so
 * each is written knowing the edits of those merged before it: claimed first, so the retries' sweep (which takes over
 * the ones left if this stops) and this never both run one. That analysis is the help center's part only (`docsOnly`:
 * no gate, no posts, its posts' updates, links and changelog line left as they are); it writes its edits again (one of
 * its edits left in an article keeps a new one off it), tells the team as any analysis does (each person's in one
 * email), and isn't retried by itself if the AI provider doesn't answer (the team's "Analyse again" is). Run again, it
 * finds the rewritten edits measured and nothing marked, so it does nothing more.
 */
export async function rewriteWaitingEdits(slug: string, now = new Date()): Promise<{ edits: number; pullRequests: number; analysed: number }> {
  if (!checksOn(slug)) {
    throw new Error(`The check isn't on for ${slug}: list it in AUTOPILOT_CHECKS_PROJECTS first`);
  }
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, ...autopilotSettingsSelect } });
  if (!project) {
    throw new Error(`There's no project ${slug}`);
  }
  if (!codeChangesEnabled() || !project.analyseCodeChanges || !planIncludes(project.plan, "codeChanges")) {
    throw new Error(`Autopilot is off for ${slug}`);
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
  const unmeasured = waiting.filter((edit) => !((edit.payload ?? {}) as { check?: { scope?: unknown } }).check?.scope);
  let edits = 0;
  let pullRequests = 0;
  const byChange = new Map<string, typeof unmeasured>();
  for (const edit of unmeasured) {
    byChange.set(edit.codeChangeId!, [...(byChange.get(edit.codeChangeId!) ?? []), edit]);
  }
  for (const [codeChangeId, its] of byChange) {
    const taken = await prisma.$transaction(async (tx) => {
      await lockProject(tx, project.id);
      // Being analysed again meanwhile (a person's "Analyse again"): that analysis is the rewrite.
      if ((await tx.codeChange.count({ where: { id: codeChangeId, state: "READY" } })) === 0) {
        return 0;
      }
      const articles: string[] = [];
      for (const { id, articleId } of its) {
        // As things stand under the lock: still waiting, nobody's, and no person's change in its article.
        if ((await tx.codeChangeAction.count({ where: { id, status: { in: ["PENDING", "SCHEDULED"] }, decidedById: null } })) === 0 || (await hasTeammateEdit(articleId!, tx))) {
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
      await tx.codeChange.update({
        where: { id: codeChangeId },
        data: { state: "FAILED", reason: REWRITING, retryAt: new Date(now.getTime() + SWEEP_AFTER_MS - pullRequests), retries: 0, retryPastGate: false },
      });
      // The edit that held the article's others back may be gone, as after a Dismiss.
      for (const articleId of new Set(articles)) {
        if ((await tx.codeChangeAction.count({ where: { articleId, kind: "ARTICLE_EDIT", status: "PENDING", decidedById: null, revisions: { some: {} } } })) > 0) {
          await scheduleArticle(tx, articleId, project, { keepDue: true });
        }
      }
      return articles.length;
    });
    if (taken > 0) {
      edits += taken;
      pullRequests++;
    }
  }
  let analysed = 0;
  const marked = await prisma.codeChange.findMany({ where: { projectId: project.id, state: "FAILED", reason: REWRITING }, orderBy: [{ mergedAt: "asc" }, { id: "asc" }], select: { id: true } });
  for (const { id } of marked) {
    const { count } = await prisma.codeChange.updateMany({ where: { id, state: "FAILED", reason: REWRITING }, data: { state: "ANALYSING", reason: "", retryAt: null } });
    if (count === 0) {
      continue;
    }
    analysed++;
    // A failure is the code change's to say (failed, with why); the next one goes on.
    await codeChange({ codeChangeId: id, force: true, pastGate: false, resume: false, docsOnly: true }, log).catch((error: unknown) => log.error("Writing a pull request's edits again failed", { error, codeChangeId: id }));
  }
  return { edits, pullRequests, analysed };
}

/**
 * When the retries' sweep takes over a pull request marked to be written again, should the run that marked it stop.
 * ponytail: a run still going after it (a few minutes a pull request, so more than a dozen or so marked) may see the
 * sweep take the ones it hasn't reached yet, in parallel on Hatchet; run it on fewer, or longer, if that matters.
 */
const SWEEP_AFTER_MS = 3_600_000;
