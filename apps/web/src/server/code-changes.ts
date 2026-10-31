"use server";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { analyseCodeChange as analyseOperation, applyCodeChangeAction, applyCodeChangeActions, dismissCodeChangeAction, resumeCodeChanges as resumeOperation } from "./operations/code-changes";
import { asTeam, call } from "./operations/run";

/** The team's actions on code changes (any team role), through the codeChanges.* operations. */

/** "Analyse anyway" (nothing to do) or "Analyse again" (failed). */
export async function analyseCodeChange(projectSlug: string, codeChangeId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) =>
    call(analyseOperation, context, { id: String(codeChangeId) }),
  );
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
 * Applies a proposed action: `comment` is the team's edit of the comment for a post it moves forward;
 * `publish: false` keeps an article edit unpublished, to finish in the editor; `line` is the team's
 * edit of the changelog line.
 */
export async function applyCodeChange(
  projectSlug: string,
  actionId: string,
  options: { comment?: string; publish?: boolean; line?: string } = {},
): Promise<FormState> {
  const { comment, publish, line } = options ?? {};
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) =>
    call(applyCodeChangeAction, context, {
      id: String(actionId),
      ...(typeof comment === "string" && comment.trim() && { comment }),
      ...(typeof publish === "boolean" && { publish }),
      ...(typeof line === "string" && line.trim() && { line }),
    }),
  );
}

export async function dismissCodeChange(projectSlug: string, actionId: string, reason?: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can use Autopilot", (context) =>
    call(dismissCodeChangeAction, context, { id: String(actionId), ...(typeof reason === "string" && reason.trim() && { reason }) }),
  );
}

/** One update to approve, with the team's edits (as applyCodeChange takes them). */
export type Approval = { id: string; comment?: string; publish?: boolean; line?: string };

/**
 * The review page's Approve: the ticked updates, each with its edits (codeChangeActions.applyMany).
 * `failed`: those not applied, with why (out of date, someone else decided first, or it can't tell); an error only when none is the project's.
 */
export async function approveCodeChanges(projectSlug: string, approvals: Approval[]): Promise<FormState & { applied?: number; failed?: { id: string; message: string }[] }> {
  let outcome: { applied: number; failed: { id: string; message: string }[] } = { applied: 0, failed: [] };
  const result = await asTeam(projectSlug, "Only the project's team can use Autopilot", async (context) => {
    const actions = (Array.isArray(approvals) ? approvals : []).map((approval) => ({
      id: String(approval.id),
      ...(typeof approval.comment === "string" && approval.comment.trim() && { comment: approval.comment }),
      ...(typeof approval.publish === "boolean" && { publish: approval.publish }),
      ...(typeof approval.line === "string" && approval.line.trim() && { line: approval.line }),
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
