import { z } from "zod";

import { spamPassedWhy, spamWhy } from "./spam-reasons";
import { ACTIONS, TRIGGERS, type WorkflowAction } from "./workflows";

/**
 * A conversation's Activity (docs/plan.md, Inbox automation, W16): what happened to it, one row per event
 * (`conversation_event`). Each kind has its own schema, as workflows' actions do: later items add theirs. A row keeps what
 * it says as it was then (a workflow's name, why it didn't match, a key's name), so deleting a workflow or a key changes
 * nothing in it.
 */

/**
 * Who did it. A teammate is a reference (gone with their account: "A former teammate"); an API key, its name then; the
 * user, the conversation's person (their message reopening it or ending its snooze).
 */
export const ACTORS = ["teammate", "api_key", "user", "workflow", "spam_filter", "ai", "tuti"] as const;
export type EventActor = (typeof ACTORS)[number];

/** The filters: People is what people did (teammates, API keys, the conversation's person), Workflows the rest. */
export const PEOPLE: EventActor[] = ["teammate", "api_key", "user"];

export const EVENTS = {
  /** A trigger's list ran: every workflow it checked, what each did or why it didn't match. */
  workflows_ran: z.object({
    trigger: z.string(),
    workflows: z.array(
      z.object({
        name: z.string(),
        matched: z.boolean(),
        /** Didn't match: the group it's for, by its name then. */
        notIn: z.string().optional(),
        /** The actions that changed something, by kind. */
        did: z.array(z.string()),
      }),
    ),
  }),
  /** The spam filter's verdict where the conversation started. */
  spam_filter: z.object({ spam: z.boolean(), reason: z.string().nullable(), check: z.string().nullable(), phrase: z.string().optional() }),
  /** `byMessage`: the change came with a message (a teammate's reply, the person writing), not by itself. */
  status: z.object({ status: z.enum(["open", "waiting", "closed"]), byMessage: z.boolean().optional() }),
  /** Snoozed till then, or its snooze ended (`until` null): by a teammate, the person writing, or its time passing (Tuti). */
  snooze: z.object({ until: z.string().nullable() }),
  /** The teammate it was assigned to (a reference: their name is read when shown), or null for unassigned. */
  assignee: z.object({ assigneeId: z.string().nullable() }),
  priority: z.object({ priority: z.boolean() }),
  spam: z.object({ spam: z.boolean() }),
  /** Take over (`team`; `byReply` when a teammate's reply did it) or Hand back to the AI (`ai`). */
  handled_by: z.object({ handledBy: z.enum(["ai", "team"]), byReply: z.boolean().optional() }),
};
export type EventKind = keyof typeof EVENTS;
export type EventDetails<Kind extends EventKind> = z.input<(typeof EVENTS)[Kind]>;

/** An event as written: its kind and details, and who did it. */
export type NewEvent = { [Kind in EventKind]: { kind: Kind; details: EventDetails<Kind> } }[EventKind] & {
  actor: EventActor;
  actorId?: string | null;
  actorName?: string | null;
};

/** An event as told: who (bold in the panel), what they did, a short detail, and for a run each workflow it checked. */
export type ToldEvent = { who: string | null; text: string; detail: string | null; lines: { name: string; what: string }[] };

const STATUS_TEXT = { open: "reopened it", waiting: "set it waiting on the user", closed: "closed it" } as const;

/**
 * An event in words, or null for a kind or details this release can't read (a later release's, while a deploy overlaps
 * the two). `names`: the teammates' names by id (who did it, an assignee); `person`: the conversation's person, as the
 * Inbox names them.
 */
export function tellEvent(
  row: { kind: string; actor: string; actorId: string | null; actorName: string | null; details: unknown },
  names: Map<string, string>,
  person = "The user",
): ToldEvent | null {
  const schema = (EVENTS as Record<string, z.ZodType>)[row.kind];
  const parsed = schema?.safeParse(row.details);
  if (!parsed?.success) {
    return null;
  }
  const details = parsed.data as never;
  const who =
    row.actor === "teammate"
      ? (row.actorId && names.get(row.actorId)) || "A former teammate"
      : row.actor === "api_key"
        ? `The API key “${row.actorName ?? "unnamed"}”`
        : row.actor === "user"
          ? person
          : null;
  const told = (text: string, detail: string | null = null): ToldEvent => ({ who, text, detail, lines: [] });
  // How a message's change came: the person writing, or a teammate's reply.
  const by = row.actor === "user" ? "by writing" : "by replying";
  switch (row.kind as EventKind) {
    case "workflows_ran": {
      const { trigger, workflows } = details as z.output<typeof EVENTS.workflows_ran>;
      return {
        who: (TRIGGERS as Record<string, string>)[trigger] ?? trigger,
        text: "ran",
        detail: `${workflows.length} ${workflows.length === 1 ? "workflow" : "workflows"} checked`,
        lines: workflows.map((workflow) => ({
          name: workflow.name,
          what: !workflow.matched
            ? workflow.notIn
              ? `didn't match (not in ${workflow.notIn})`
              : "didn't match"
            : workflow.did.length > 0
              ? new Intl.ListFormat("en-GB").format(workflow.did.map((kind) => ACTIONS[kind as WorkflowAction["kind"]]?.did ?? kind))
              : "matched, nothing to change",
        })),
      };
    }
    case "spam_filter": {
      const verdict = details as z.output<typeof EVENTS.spam_filter>;
      return {
        who: "Spam filter",
        text: verdict.spam ? "filed it as spam" : "let it through",
        detail: verdict.spam ? spamWhy(verdict.reason, verdict.phrase) : spamPassedWhy(verdict.check),
        lines: [],
      };
    }
    case "status": {
      const { status, byMessage } = details as z.output<typeof EVENTS.status>;
      return told(STATUS_TEXT[status], byMessage ? by : null);
    }
    case "snooze": {
      const { until } = details as z.output<typeof EVENTS.snooze>;
      if (until) {
        return told("snoozed it", `until ${new Date(until).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`);
      }
      return row.actor === "tuti" ? { who: null, text: "Its snooze ended", detail: null, lines: [] } : told("ended its snooze", row.actor === "user" ? by : null);
    }
    case "assignee": {
      const { assigneeId } = details as z.output<typeof EVENTS.assignee>;
      if (!assigneeId) {
        return told("unassigned it");
      }
      return told(row.actor === "teammate" && assigneeId === row.actorId ? "assigned it to themselves" : `assigned it to ${names.get(assigneeId) ?? "a former teammate"}`);
    }
    case "priority":
      return told((details as z.output<typeof EVENTS.priority>).priority ? "marked it priority" : "took its priority off");
    case "spam":
      return told((details as z.output<typeof EVENTS.spam>).spam ? "marked it as spam" : "marked it not spam");
    case "handled_by": {
      const { handledBy, byReply } = details as z.output<typeof EVENTS.handled_by>;
      return handledBy === "team" ? told("took it over from the AI", byReply ? by : "Take over") : told("handed it back to the AI");
    }
  }
}

/** The teammates an event names (who did it, who it was assigned to), whose names are read when it's shown. */
export function eventPeople(row: { kind: string; actorId: string | null; details: unknown }): string[] {
  const assignee = row.kind === "assignee" ? EVENTS.assignee.safeParse(row.details).data?.assigneeId : null;
  return [row.actorId, assignee].filter((id): id is string => !!id);
}
