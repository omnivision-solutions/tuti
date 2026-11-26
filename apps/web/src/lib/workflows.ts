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
  about_to_hand_over: "A conversation is about to go to a person",
} as const;
export type WorkflowTrigger = keyof typeof TRIGGERS;

/** When each trigger fires, as the editor says under its choice. */
export const TRIGGER_HINTS: Record<WorkflowTrigger, string> = {
  conversation_started: "On a user's first message, once per conversation, after the spam filter lets it through.",
  user_replied: "On every later message from the user, one that reopens a closed conversation too.",
  about_to_hand_over: "Each time a conversation would go to your team, with the reason.",
};

/**
 * Why a conversation is about to go to a person, as its Activity says it. "The AI is off" is every conversation the AI
 * doesn't answer (nothing answers for it yet); "too many automated replies" is the cap (AUTOMATED_REPLIES_PER_HOUR),
 * where nothing can keep it from the team.
 */
export const HANDOVER_REASONS = {
  user_asked: "the user asked for a person",
  ai_off: "the AI is off",
  too_many_replies: "too many automated replies",
} as const;
export type HandoverReason = keyof typeof HANDOVER_REASONS;

/**
 * Automated replies (the AI's and the workflows' set replies, together) a conversation gets in an hour: past them it gets
 * none, and goes to the team, so two machines never answer each other for long.
 */
export const AUTOMATED_REPLIES_PER_HOUR = 5;
export const MAX_WORKFLOW_REPLY = 1000;
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
  reply_text: z.object({
    kind: z.literal("reply_text").describe("`reply_text` (about_to_hand_over): replies with set text as the AI, once per conversation").meta({ examples: ["reply_text"] }),
    text: z
      .string()
      .trim()
      .min(1, "Write the reply")
      .max(MAX_WORKFLOW_REPLY, `Keep the reply under ${MAX_WORKFLOW_REPLY.toLocaleString("en")} characters`)
      .describe("The reply, as plain text")
      .meta({ examples: ["Thanks! Our team answers Enterprise questions within the hour."] }),
  }),
  dont_hand_over: z.object({
    kind: z.literal("dont_hand_over").describe("`dont_hand_over` (about_to_hand_over): keeps the conversation with the AI").meta({ examples: ["dont_hand_over"] }),
  }),
};

export const workflowAction = z.discriminatedUnion("kind", [ACTION_SCHEMAS.mark_priority, ACTION_SCHEMAS.reply_text, ACTION_SCHEMAS.dont_hand_over]);
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
  reply_text: {
    label: "Reply with set text",
    hint: "Sent as the AI, at most once per conversation.",
    triggers: ["about_to_hand_over"],
    deciding: false,
    did: "replied",
  },
  dont_hand_over: {
    label: "Don't hand over",
    hint: "Keeps the conversation with the AI. Ends the list.",
    triggers: ["about_to_hand_over"],
    deciding: true,
    did: "kept it with the AI",
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
export function workflowSentence(workflow: { trigger: WorkflowTrigger; conditions: WorkflowCondition[]; actions: Pick<WorkflowAction, "kind">[] }, groupNames: Record<string, string>) {
  const when = `When ${TRIGGERS[workflow.trigger].charAt(0).toLowerCase()}${TRIGGERS[workflow.trigger].slice(1)}`;
  const who = workflow.conditions.map((condition) => `if the person is in ${groupNames[condition.group] ?? condition.group}`).join(", ") || "for everyone";
  const what = workflow.actions.map((action) => ACTIONS[action.kind].label.toLowerCase());
  return `${when}, ${who}: ${what.length ? new Intl.ListFormat("en-GB").format(what) : "nothing yet"}.`;
}
