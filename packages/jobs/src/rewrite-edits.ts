import { isDeepStrictEqual } from "node:util";

import { toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { codeChangesEnabled, planIncludes } from "@tuti/shared";

import { docOf, editsInChanges, hasTeammateEdit, recordRevision, scheduleArticle, takeOut, versions } from "./article-layers";
import { autopilotSettingsSelect } from "./autopilot";
import { REWRITTEN, retryCodeChanges } from "./code-changes";
import { checksOn } from "./edit-review";
import { lockProject } from "./running-draft";

/** What a pull request whose edits are written again says until its analysis starts (its page shows it beside "Autopilot tries again"). */
export const REWRITING = "Its edits are being written again with the check.";

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
 * request is put to be analysed again at once, through the retries' sweep: queued here right after, or by the worker's
 * sweep within 10 minutes if this stops first. That analysis writes its edits again (one of its edits left in an
 * article keeps a new one off it). Run again, it finds the rewritten edits measured and the rest as they were.
 */
export async function rewriteWaitingEdits(slug: string, now = new Date()): Promise<{ edits: number; pullRequests: number; queued: number }> {
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
      // Due now, the oldest merged first (each one a millisecond before the next newer), so each is written knowing the
      // edits of those merged before it. ponytail: it uses the first of the retries' tries, so a provider that doesn't
      // answer is tried again 6 hours later, not after an hour.
      await tx.codeChange.update({
        where: { id: codeChangeId },
        data: { state: "FAILED", reason: REWRITING, retryAt: new Date(now.getTime() - pullRequests), retries: 0, retryPastGate: false },
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
  const { queued } = pullRequests > 0 ? await retryCodeChanges(now) : { queued: 0 };
  return { edits, pullRequests, queued: Number(queued) };
}
