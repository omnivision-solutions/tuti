import { type Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { z } from "zod";

import {
  ACTIONS,
  actionsFor,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOWS,
  TRIGGER_KEYS,
  TRIGGERS,
  type WorkflowAction,
  workflowAction,
  workflowActions,
  type WorkflowCondition,
  workflowCondition,
  workflowConditions,
  type WorkflowTrigger,
} from "@/lib/workflows";

import { defineOperation, OperationError } from "./define";

/**
 * Workflows (docs/plan.md, Inbox automation): what the team sets to happen on its own when a user's message arrives.
 * Each trigger has an ordered list of them, which server/inbox-path.ts runs top to bottom. Owners and admins', as the
 * inbox's other settings are.
 */

const workflowId = z.string().min(1).max(64).describe("The workflow's id").meta({ examples: ["cm3k9x2ab0001qz8h4f7d2e1c"] });
const position = z.number().int().min(0).max(10_000);

const fields = {
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(MAX_WORKFLOW_NAME)
    .describe("Its name: the note it leaves in a conversation starts with it")
    .meta({ examples: ["Enterprise first"] }),
  trigger: z
    .enum(TRIGGER_KEYS)
    .describe(
      "When it runs: `conversation_started` (a user's first message, once per conversation, after the spam filter passed it) or `user_replied` (every later message from the user, one that reopens a closed conversation included)",
    )
    .meta({ examples: ["conversation_started"] }),
  conditions: workflowConditions
    .describe(
      "Who it's for, checked when it runs: the conversation's person is in a reader group (`in_group`), or none for everyone. Someone who isn't one of your app's users (a signed-out visitor, an address that isn't a user's) is in no group",
    )
    .meta({ examples: [[{ kind: "in_group", group: "enterprise" }]] }),
  actions: workflowActions
    .describe(
      "What it does, in order, at least one, from those its trigger offers. `mark_priority` (both triggers) marks the conversation priority, and the next workflow in the list still runs",
    )
    .meta({ examples: [[{ kind: "mark_priority" }]] }),
  enabled: z.boolean().describe("Whether it's on: one that's off never runs").meta({ examples: [true] }),
};

const workflowOutput = z
  .object({
    id: workflowId,
    name: z.string().describe("Its name: the note it leaves in a conversation starts with it").meta({ examples: ["Enterprise first"] }),
    trigger: z.enum(TRIGGER_KEYS).describe("When it runs: `conversation_started` (a user's first message) or `user_replied` (every later one)").meta({ examples: ["conversation_started"] }),
    position: z.number().int().describe("Its place in its trigger's list, 0 first: the list runs top to bottom").meta({ examples: [0] }),
    enabled: fields.enabled,
    conditions: z
      .array(workflowCondition)
      .describe("Who it's for: the conversation's person is in a reader group, or none for everyone")
      .meta({ examples: [[{ kind: "in_group", group: "enterprise" }]] }),
    actions: z
      .array(workflowAction)
      .describe("What it does, in order")
      .meta({ examples: [[{ kind: "mark_priority" }]] }),
  })
  .meta({ id: "Workflow", description: "A workflow: when its trigger's moment comes for a conversation whose person its conditions match, its actions run" });

const select = { id: true, name: true, trigger: true, position: true, enabled: true, conditions: true, actions: true } satisfies Prisma.WorkflowSelect;
type Row = Prisma.WorkflowGetPayload<{ select: typeof select }>;

/** A workflow as the API returns it: its conditions and actions as they're stored. */
const view = (row: Row) => ({
  ...row,
  trigger: row.trigger as WorkflowTrigger,
  conditions: row.conditions as WorkflowCondition[],
  actions: row.actions as WorkflowAction[],
});

const notFound = () => new OperationError(404, "not_found", "There's no workflow with that id");

/** One of the project's workflows (of a trigger this release knows), or 404. */
async function found(tx: Prisma.TransactionClient, projectId: string, id: string) {
  const row = await tx.workflow.findFirst({ where: { id, projectId, trigger: { in: TRIGGER_KEYS } }, select });
  if (!row) {
    throw notFound();
  }
  return row;
}

/** A trigger's list, top to bottom. */
const listOf = (tx: Prisma.TransactionClient, projectId: string, trigger: string) =>
  tx.workflow.findMany({ where: { projectId, trigger }, orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true } });

/** Numbers a list's workflows 0, 1, … in the order of `ids`, in one statement. */
async function renumber(tx: Prisma.TransactionClient, ids: string[]) {
  await tx.$executeRaw`
    UPDATE "workflow" w SET "position" = n.place - 1
    FROM unnest(${ids}::text[]) WITH ORDINALITY AS n(id, place)
    WHERE w.id = n.id`;
}

/**
 * Refuses what a workflow can't be made of: an action its trigger doesn't offer, a group the project doesn't have.
 * Call it with the project locked: groups.delete locks it too, so a group is here or the workflow isn't saved for it.
 */
async function check(tx: Prisma.TransactionClient, projectId: string, workflow: { trigger: WorkflowTrigger; conditions: WorkflowCondition[]; actions: WorkflowAction[] }) {
  const offered = actionsFor(workflow.trigger);
  const other = workflow.actions.find((action) => !offered.includes(action.kind));
  if (other) {
    throw new OperationError(400, "invalid_input", `“${TRIGGERS[workflow.trigger]}” doesn't offer ${ACTIONS[other.kind].label}`);
  }
  const keys = workflow.conditions.map((condition) => condition.group);
  const groups = await tx.readerGroup.findMany({ where: { projectId, key: { in: keys } }, select: { key: true } });
  const missing = keys.find((key) => !groups.some((group) => group.key === key));
  if (missing !== undefined) {
    throw new OperationError(400, "invalid_input", `There's no group “${missing}”: add it in Settings → Groups first`);
  }
}

/** A list is full: each of the project's messages runs it. */
function full(count: number, trigger: WorkflowTrigger) {
  if (count >= MAX_WORKFLOWS) {
    throw new OperationError(409, "conflict", `“${TRIGGERS[trigger]}” has ${MAX_WORKFLOWS} workflows already: delete one first`);
  }
}

/** The project's workflows, each trigger's list top to bottom, the triggers in the path's order. */
export async function workflowsOf(projectId: string) {
  const rows = await prisma.workflow.findMany({ where: { projectId, trigger: { in: TRIGGER_KEYS } }, orderBy: [{ position: "asc" }, { id: "asc" }], select });
  return TRIGGER_KEYS.flatMap((trigger) => rows.filter((row) => row.trigger === trigger)).map(view);
}

export const listWorkflows = defineOperation({
  name: "workflows.list",
  title: "List workflows",
  summary:
    "List the inbox's workflows: what the team set to happen on its own when a user's message arrives. Each trigger has a list, run once, top to bottom, for each message; they come in that order, `conversation_started`'s first.",
  method: "GET",
  path: "/workflows",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: z.object({ workflows: z.array(workflowOutput).describe("The workflows, each trigger's list top to bottom") }).describe("The inbox's workflows"),
  run: async ({ projectId }) => ({ workflows: await workflowsOf(projectId) }),
});

export const getWorkflow = defineOperation({
  name: "workflows.get",
  title: "Get a workflow",
  summary: "Get one of the inbox's workflows by its id.",
  method: "GET",
  path: "/workflows/{id}",
  scope: "read",
  access: "admin",
  input: z.object({ id: workflowId }),
  output: workflowOutput.describe("The workflow"),
  run: async ({ projectId }, { id }) => view(await found(prisma, projectId, id)),
});

export const createWorkflow = defineOperation({
  name: "workflows.create",
  title: "Create a workflow",
  summary:
    "Add a workflow to the inbox, last in its trigger's list (workflows.move places it). When a user's message arrives, the trigger's workflows that are on run top to bottom; each that changed the conversation leaves a note in it, “<name> marked this priority”.",
  method: "POST",
  path: "/workflows",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    name: fields.name,
    trigger: fields.trigger,
    conditions: fields.conditions.default([]),
    actions: fields.actions,
    enabled: fields.enabled.default(true).describe("Whether it's on (the default): one that's off never runs"),
  }),
  example: { name: "Enterprise first", trigger: "conversation_started", conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] },
  output: workflowOutput.describe("The new workflow"),
  run: async ({ projectId }, input) =>
    view(
      // Under the project's lock: workflows made at once get places one after the other.
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        await check(tx, projectId, input);
        const count = await tx.workflow.count({ where: { projectId, trigger: input.trigger } });
        full(count, input.trigger);
        return tx.workflow.create({ data: { projectId, ...input, position: count }, select });
      }),
    ),
});

export const updateWorkflow = defineOperation({
  name: "workflows.update",
  title: "Update a workflow",
  summary:
    "Change a workflow; what's left out stays. Given another trigger, it goes last in that trigger's list. Messages it already ran for aren't run again.",
  method: "PATCH",
  path: "/workflows/{id}",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    id: workflowId,
    name: fields.name.optional(),
    trigger: fields.trigger.optional(),
    conditions: fields.conditions.optional().describe("All of its conditions, in place of those it has (see workflows.create); none for everyone"),
    actions: fields.actions.optional().describe("All of its actions, in place of those it has (see workflows.create)"),
    enabled: fields.enabled.optional(),
  }),
  example: { enabled: false },
  output: workflowOutput.describe("The workflow as it is now"),
  run: async ({ projectId }, { id, ...input }) =>
    view(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const current = view(await found(tx, projectId, id));
        const trigger = input.trigger ?? current.trigger;
        const moved = trigger !== current.trigger;
        // Checked whole, as it will be: what it keeps against what changes (its actions against another trigger).
        await check(tx, projectId, { trigger, conditions: input.conditions ?? current.conditions, actions: input.actions ?? current.actions });
        const last = moved ? await tx.workflow.count({ where: { projectId, trigger } }) : current.position;
        if (moved) {
          full(last, trigger);
        }
        const updated = await tx.workflow.update({ where: { id }, data: { ...input, position: last }, select });
        if (moved) {
          // The list it left closes up.
          await renumber(tx, (await listOf(tx, projectId, current.trigger)).map((row) => row.id));
        }
        return updated;
      }),
    ),
});

export const moveWorkflow = defineOperation({
  name: "workflows.move",
  title: "Move a workflow",
  summary: "Move a workflow within its trigger's list; the others keep their order around it. The list runs top to bottom.",
  method: "POST",
  path: "/workflows/{id}/move",
  scope: "write",
  access: "admin",
  input: z.object({ id: workflowId, position: position.optional().describe("Its place in the list, 0 first; left out, last").meta({ examples: [0] }) }),
  example: { position: 0 },
  output: workflowOutput.describe("The workflow, moved"),
  run: async ({ projectId }, input) =>
    view(
      // Under the project's lock: moves at the same time renumber one after the other, never over each other.
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const { id, trigger } = await found(tx, projectId, input.id);
        const ids = (await listOf(tx, projectId, trigger)).map((row) => row.id).filter((other) => other !== id);
        ids.splice(Math.min(input.position ?? ids.length, ids.length), 0, id);
        await renumber(tx, ids);
        return tx.workflow.findUniqueOrThrow({ where: { id }, select });
      }),
    ),
});

export const deleteWorkflow = defineOperation({
  name: "workflows.delete",
  title: "Delete a workflow",
  summary: "Delete a workflow. The notes it left in conversations stay, and so does what it changed.",
  method: "DELETE",
  path: "/workflows/{id}",
  scope: "write",
  access: "admin",
  input: z.object({ id: workflowId }),
  output: z.object({ deleted: z.string().describe("The deleted workflow's id").meta({ examples: ["cm3k9x2ab0001qz8h4f7d2e1c"] }) }).describe("The workflow is gone"),
  run: async ({ projectId }, { id }) => {
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const { trigger } = await found(tx, projectId, id);
      await tx.workflow.delete({ where: { id } });
      // Its list closes up.
      await renumber(tx, (await listOf(tx, projectId, trigger)).map((row) => row.id));
    });
    return { deleted: id };
  },
});
