"use server";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { analyseCodeChange as analyseOperation, applyCodeChangeAction, applyCodeChangeActions, dismissCodeChangeAction, publishCodeChangeActionNow, resumeCodeChanges as resumeOperation, stopCodeChangeAction, undoCodeChangeAction } from "./operations/code-changes";
import { asTeam, call } from "./operations/run";
import { type VerificationView, verifyAll as verifyAllOperation, type VerifyAllView, verifyArticle as verifyOperation } from "./operations/verify";

/** The team's actions on code changes (any team role), through the codeChanges.* operations. */

/** "Analyse anyway" (nothing to do) or "Analyse again" (failed). */
export async function analyseCodeChange(projectSlug: string, codeChangeId: string): Promise<FormState & { queued?: boolean }> {
  let queued = false;
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    // Still analysing once asked: queued (on Hatchet the job runs later), or already being analysed.
    queued = (await call(analyseOperation, context, { id: String(codeChangeId) })).state === "analysing";
  });
  return result.error ? result : { queued };
}

/** "Resume all" on Home: every code change paused for want of AI credits. */
export async function resumeCodeChanges(projectSlug: string): Promise<FormState & { failed?: number }> {
  let failed = 0;
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    failed = (await call(resumeOperation, context, {})).failed;
  });
  return result.error ? result : { failed };
}

/**
 * Applies a proposed action: `comment` is the team's edit of the comment for a post it moves forward; `line` is the
 * team's edit of the changelog line; `revision`, for an article's edit, the version reviewed (approving publishes it).
 */
export async function applyCodeChange(
  projectSlug: string,
  actionId: string,
  options: { comment?: string; line?: string; revision?: string } = {},
): Promise<FormState> {
  const { comment, line, revision } = options ?? {};
  // A page from before `publish` went (an article's edit is always published now) gets told, not published.
  if (options && typeof options === "object" && "publish" in options) {
    return { error: "Autopilot changed: reload the page to review this again" };
  }
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) =>
    call(applyCodeChangeAction, context, {
      id: String(actionId),
      ...(typeof comment === "string" && comment.trim() && { comment }),
      ...(typeof line === "string" && line.trim() && { line }),
      // Any string, empty too: the operation refuses one that isn't a version, never dismissing only this part instead.
      ...(typeof revision === "string" && { revision }),
    }),
  );
}

/** Undo on an approved update: puts back what it changed (codeChangeActions.undo). */
export async function undoCodeChange(projectSlug: string, actionId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) => call(undoCodeChangeAction, context, { id: String(actionId) }));
}

/** Publish now: scheduled updates applied at once, by whoever asks (codeChangeActions.publishNow). */
export async function publishCodeChangesNow(projectSlug: string, actionIds: string[]): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    // Several at once (Home's buttons): one that went out (or was stopped) meanwhile is skipped, not the end of it; so is
    // an article edit that can't go now (past the plan's published articles, or held by another edit to its article
    // waiting): it waits saying why, and is told after the rest went.
    const ids = (Array.isArray(actionIds) ? actionIds : []).map(String);
    let done = 0;
    const waiting: OperationError[] = [];
    for (const id of ids) {
      try {
        await call(publishCodeChangeActionNow, context, { id });
        done++;
      } catch (error) {
        if (ids.length > 1 && error instanceof OperationError && (error.code === "article_limit" || error.code === "held")) {
          waiting.push(error);
        } else if (!(error instanceof OperationError && error.code === "not_scheduled" && ids.length > 1)) {
          throw error;
        }
      }
    }
    if (waiting.length > 0) {
      const edits = waiting.length === 1 ? "An article edit waits" : `${waiting.length} article edits wait`;
      // Only what this click published: others skipped may have gone out by themselves meanwhile, or been stopped.
      const went = done > 0 ? `; ${done} other ${done === 1 ? "update" : "updates"} went out now` : "";
      // The plan's limit first, when one hit it: it's the way out for the others held behind it too.
      const why = waiting.find((error) => error.code === "article_limit") ?? waiting[0]!;
      throw new OperationError(why.status, why.code, `${edits}${went}. ${why.message}`);
    }
    if (ids.length > 1 && done === 0) {
      throw new OperationError(409, "not_scheduled", "None of them is scheduled any more: they went out, or someone stopped them");
    }
  });
}

/** Stop: scheduled updates wait for the team instead (codeChangeActions.stop). */
export async function stopCodeChanges(projectSlug: string, actionIds: string[]): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    // Several at once (Home's buttons): one that went out (or was stopped) meanwhile is skipped, not the end of it.
    const ids = (Array.isArray(actionIds) ? actionIds : []).map(String);
    let done = 0;
    for (const id of ids) {
      try {
        await call(stopCodeChangeAction, context, { id });
        done++;
      } catch (error) {
        if (!(error instanceof OperationError && error.code === "not_scheduled" && ids.length > 1)) {
          throw error;
        }
      }
    }
    if (ids.length > 1 && done === 0) {
      throw new OperationError(409, "not_scheduled", "None of them is scheduled any more: they went out, or someone stopped them");
    }
  });
}

export async function dismissCodeChange(projectSlug: string, actionId: string, reason?: string, revision?: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) =>
    call(dismissCodeChangeAction, context, {
      id: String(actionId),
      ...(typeof reason === "string" && reason.trim() && { reason }),
      // A post's whole update, as reviewed.
      // Any string, empty too: the operation refuses one that isn't a version, never dismissing only this part instead.
      ...(typeof revision === "string" && { revision }),
    }),
  );
}

/** One update to approve, with the team's edits (as applyCodeChange takes them). */
export type Approval = { id: string; comment?: string; line?: string; revision?: string };

/**
 * The review page's Approve: the ticked updates, each with its edits (codeChangeActions.applyMany).
 * `failed`: those not applied, with why (out of date, someone else decided first, or it can't tell); an error only when none is the project's.
 */
export async function approveCodeChanges(projectSlug: string, approvals: Approval[]): Promise<FormState & { applied?: number; failed?: { id: string; message: string }[] }> {
  let outcome: { applied: number; failed: { id: string; message: string }[] } = { applied: 0, failed: [] };
  if (Array.isArray(approvals) && approvals.some((approval) => approval && typeof approval === "object" && "publish" in approval)) {
    return { error: "Autopilot changed: reload the page to review this again" };
  }
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    const actions = (Array.isArray(approvals) ? approvals : []).map((approval) => ({
      id: String(approval.id),
      ...(typeof approval.comment === "string" && approval.comment.trim() && { comment: approval.comment }),
      ...(typeof approval.line === "string" && approval.line.trim() && { line: approval.line }),
      ...(typeof approval.revision === "string" && approval.revision && { revision: approval.revision }),
    }));
    const { results } = await call(applyCodeChangeActions, context, { actions });
    outcome = {
      applied: results.filter((r) => r.status === "applied").length,
      failed: results.flatMap((r) => (r.status === "failed" ? [{ id: r.id, message: r.message }] : [])),
    };
    // None of them is this project's: refused, as for any other project's records. Otherwise each one
    // that didn't go says why (the page names each), even when none went.
    if (outcome.applied === 0 && results.every((r) => r.status === "failed" && r.code === "not_found")) {
      throw new OperationError(404, "not_found", outcome.failed[0]!.message);
    }
  });
  return result.error ? result : outcome;
}

/** Verify on an article (articles.verify): what it found, or why it couldn't run. */
export async function verifyArticle(projectSlug: string, articleSlug: string): Promise<FormState & { verification?: VerificationView }> {
  let verification: VerificationView | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    verification = await call(verifyOperation, context, { slug: String(articleSlug) });
  });
  return result.error ? result : { verification };
}

/** Verify all (articles.verifyAll), once its cost was shown: the run started, or the one running already, with its progress. */
export async function verifyAll(projectSlug: string): Promise<FormState & { verifyAll?: VerifyAllView }> {
  let verifyAll: VerifyAllView | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    verifyAll = await call(verifyAllOperation, context, {});
  });
  return result.error ? result : { verifyAll };
}
