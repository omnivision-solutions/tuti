"use server";

import { prisma } from "@tuti/db";
import { THRESHOLDS } from "@tuti/jobs";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { analyseCodeChange as analyseOperation, applyCodeChangeAction, dismissCodeChangeAction } from "./operations/code-changes";
import { asTeam, call } from "./operations/run";

/** The team's actions on code changes (any team role), through the codeChanges.* operations. */

/** "Analyse anyway" (nothing to do) or "Analyse again" (failed). */
export async function analyseCodeChange(projectSlug: string, codeChangeId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can analyse code changes", (context) =>
    call(analyseOperation, context, { id: String(codeChangeId) }),
  );
}

/** Applies a proposed action; `comment` is the team's edit of the comment for a post it moves forward. */
export async function applyCodeChange(projectSlug: string, actionId: string, comment?: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can apply code changes", (context) =>
    call(applyCodeChangeAction, context, { id: String(actionId), ...(typeof comment === "string" && comment.trim() && { comment }) }),
  );
}

export async function dismissCodeChange(projectSlug: string, actionId: string, reason?: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can dismiss code changes", (context) =>
    call(dismissCodeChangeAction, context, { id: String(actionId), ...(typeof reason === "string" && reason.trim() && { reason }) }),
  );
}

/**
 * "Apply likely": the code change's waiting feedback proposals above their kind's "likely" threshold,
 * one after another. Stops at the first that fails (the ones before it stay applied).
 */
export async function applyLikelyCodeChanges(projectSlug: string, codeChangeId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can apply code changes", async (context) => {
    const change = await prisma.codeChange.findFirst({ where: { id: String(codeChangeId), projectId: context.projectId }, select: { id: true } });
    if (!change) {
      throw new OperationError(404, "not_found", "Code change not found");
    }
    const actions = await prisma.codeChangeAction.findMany({
      where: { codeChangeId: change.id, status: "PENDING", kind: { in: ["RESOLVES", "MOVES_FORWARD", "LINKS"] } },
      orderBy: { probability: "desc" },
      select: { id: true, kind: true, probability: true },
    });
    for (const action of actions) {
      if (action.probability >= THRESHOLDS[action.kind as "RESOLVES" | "MOVES_FORWARD" | "LINKS"].likely) {
        await call(applyCodeChangeAction, context, { id: action.id });
      }
    }
  });
}
