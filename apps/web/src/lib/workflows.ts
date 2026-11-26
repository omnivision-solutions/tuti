import { z } from "zod";

/**
 * Workflows (docs/plan.md, Inbox automation): what the team sets to happen on its own in the inbox. A workflow is a
 * name, a trigger, conditions and ordered actions, with a place in its trigger's list. Here: what one can be made of,
 * for the API and the editor. server/inbox-path.ts runs them.
 */

/**
 * The moments a workflow can be for, in the path's order, as the team reads them. The first two never come for the same
 * message. Stored as text (`workflow.trigger`), so a new moment ("About to go to a person") is one more line here.
 */
export const TRIGGERS = {
  conversation_started: "A conversation starts",
  user_replied: "A user replies",
} as const;
export type WorkflowTrigger = keyof typeof TRIGGERS;

/** When each trigger fires, as the editor says under its choice. */
export const TRIGGER_HINTS: Record<WorkflowTrigger, string> = {
  conversation_started: "On a user's first message, once per conversation, after the spam filter lets it through.",
  user_replied: "On every later message from the user, one that reopens a closed conversation too.",
};
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as [WorkflowTrigger, ...WorkflowTrigger[]];

/** How many workflows a trigger's list holds: each of the project's messages runs it. */
export const MAX_WORKFLOWS = 50;
export const MAX_WORKFLOW_ACTIONS = 10;
export const MAX_WORKFLOW_NAME = 100;

/** The conditions, each kind with its own schema: the list grows. */
const CONDITIONS = {
  in_group: z.object({
    kind: z.literal("in_group").describe("`in_group`: the conversation's person is in a reader group").meta({ examples: ["in_group"] }),
    group: z.string().trim().toLowerCase().min(1).max(50).describe("The reader group's key (groups.list)").meta({ examples: ["enterprise"] }),
  }),
};

export const workflowCondition = z.discriminatedUnion("kind", [CONDITIONS.in_group]);
export type WorkflowCondition = z.output<typeof workflowCondition>;

/** A workflow's conditions, all of which must match: one for now (the person is in a group), or none, which is everyone. */
export const workflowConditions = z.array(workflowCondition).max(1, "A workflow has one condition, or none for everyone");

/** The actions, each kind with its own schema: the list grows. */
const ACTION_SCHEMAS = {
  mark_priority: z.object({ kind: z.literal("mark_priority").describe("`mark_priority`: marks the conversation priority").meta({ examples: ["mark_priority"] }) }),
};

export const workflowAction = z.discriminatedUnion("kind", [ACTION_SCHEMAS.mark_priority]);
export type WorkflowAction = z.output<typeof workflowAction>;

/**
 * What each action is: which triggers offer it, and whether it's a marking one (the next workflow still runs) or a
 * deciding one (it ends its trigger's list for that message). `did`: what the conversation's Activity says it did, after
 * the workflow's name. server/inbox-path.ts has what each does.
 */
export const ACTIONS: Record<WorkflowAction["kind"], { label: string; hint: string; triggers: readonly WorkflowTrigger[]; deciding: boolean; did: string }> = {
  mark_priority: {
    label: "Mark priority",
    hint: "Marks the conversation priority. The next workflow still runs.",
    triggers: ["conversation_started", "user_replied"],
    deciding: false,
    did: "marked this priority",
  },
};

/** A workflow's actions, in the order they run: at least one. */
export const workflowActions = z.array(workflowAction).min(1, "A workflow needs an action").max(MAX_WORKFLOW_ACTIONS, `Up to ${MAX_WORKFLOW_ACTIONS} actions`);

/** The actions a trigger offers, by kind. */
export const actionsFor = (trigger: WorkflowTrigger) =>
  (Object.keys(ACTIONS) as WorkflowAction["kind"][]).filter((kind) => ACTIONS[kind].triggers.includes(trigger));

/**
 * A workflow's conditions and actions as stored, or null when something in them can't be read or isn't its trigger's (a
 * later release's kind, while a deploy overlaps the two): such a workflow doesn't run, rather than run in part.
 */
export function storedWorkflow(workflow: { trigger: string; conditions: unknown; actions: unknown }): { conditions: WorkflowCondition[]; actions: WorkflowAction[] } | null {
  const conditions = workflowConditions.safeParse(workflow.conditions).data;
  const actions = workflowActions.safeParse(workflow.actions).data;
  const offered = TRIGGER_KEYS.includes(workflow.trigger as WorkflowTrigger) ? actionsFor(workflow.trigger as WorkflowTrigger) : [];
  return conditions && actions?.every((action) => offered.includes(action.kind)) ? { conditions, actions } : null;
}

/** A workflow in one line, as Settings → Workflows lists it: who it's for, then what it does ("In Enterprise: mark priority"). `groupNames`: the groups' names by key. */
export function workflowSummary(workflow: { conditions: WorkflowCondition[]; actions: WorkflowAction[] }, groupNames: Record<string, string>) {
  const who = workflow.conditions.map((condition) => `In ${groupNames[condition.group] ?? condition.group}`).join(", ") || "Everyone";
  return `${who}: ${workflow.actions.map((action) => ACTIONS[action.kind].label.toLowerCase()).join(", ")}`;
}

/**
 * A workflow read back as a sentence, as its editor shows it: "When a conversation starts, if the person is in
 * Enterprise: mark priority." `groupNames`: the groups' names by key.
 */
export function workflowSentence(workflow: { trigger: WorkflowTrigger; conditions: WorkflowCondition[]; actions: WorkflowAction[] }, groupNames: Record<string, string>) {
  const when = `When ${TRIGGERS[workflow.trigger].charAt(0).toLowerCase()}${TRIGGERS[workflow.trigger].slice(1)}`;
  const who = workflow.conditions.map((condition) => `if the person is in ${groupNames[condition.group] ?? condition.group}`).join(", ") || "for everyone";
  const what = workflow.actions.map((action) => ACTIONS[action.kind].label.toLowerCase());
  return `${when}, ${who}: ${what.length ? new Intl.ListFormat("en-GB").format(what) : "nothing yet"}.`;
}
