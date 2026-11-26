"use server";

import type { z } from "zod";

import { asAdmin, call } from "./operations/run";
import { createWorkflow, deleteWorkflow as deleteWorkflowOperation, moveWorkflow as moveWorkflowOperation, updateWorkflow } from "./operations/workflows";

/** Settings → Inbox → Workflows (see the workflows.* operations, which check what they're given). */

const DENIED = "Only project owners and admins can change the workflows";

/** Adds a workflow (`id` null) or changes workflow `id`: whatever of its name, trigger, conditions, actions and switch is given. */
export async function saveWorkflow(projectSlug: string, id: string | null, workflow: Omit<z.input<typeof updateWorkflow.input>, "id">): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) =>
    id === null ? call(createWorkflow, context, workflow as z.input<typeof createWorkflow.input>) : call(updateWorkflow, context, { ...workflow, id: String(id) }),
  );
}

/** Moves a workflow to `position` in its trigger's list (0 first). */
export async function moveWorkflow(projectSlug: string, id: string, position: number): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) => call(moveWorkflowOperation, context, { id: String(id), position }));
}

export async function deleteWorkflow(projectSlug: string, id: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) => call(deleteWorkflowOperation, context, { id: String(id) }));
}
