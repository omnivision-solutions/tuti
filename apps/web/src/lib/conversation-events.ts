import { z } from "zod";

import { spamPassedWhy, spamWhy } from "./spam-reasons";
import { ACTIONS, HANDOVER_REASONS, TRIGGERS, type WorkflowAction } from "./workflows";

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
    /** "About to go to a person": why (HANDOVER_REASONS). */
    reason: z.string().optional(),
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
  /**
   * The spam filter's verdict where the conversation started, or the models' once they've judged one it held (W4: `by`,
   * the model that answered, and its probability; the check "model_unanswered" where it didn't).
   */
  spam_filter: z.object({
    spam: z.boolean(),
    reason: z.string().nullable(),
    check: z.string().nullable(),
    phrase: z.string().optional(),
    by: z.enum(["decision", "chat"]).optional(),
    probability: z.number().min(0).max(1).optional(),
  }),
  /**
   * The spam filter's model checks (W3), watching only (rows from before W4, which no longer writes them), would have filed it: the model that said so, and the decision
   * model's probability. Nothing of the sender's, nor the model's words (a sender could steer those).
   */
  spam_would_file: z.object({ by: z.enum(["decision", "chat"]), probability: z.number().min(0).max(1).optional() }),
  /**
   * `byMessage`: the change came with a message (a teammate's reply, the person writing), not by itself. `other`: the
   * message was someone else's on the email thread (a Cc'd colleague), not the conversation's person; who isn't kept.
   */
  status: z.object({ status: z.enum(["open", "waiting", "closed"]), byMessage: z.boolean().optional(), other: z.boolean().optional() }),
  /** Snoozed till then, or its snooze ended (`until` null): by a teammate, the person writing, or its time passing (Tuti). */
  snooze: z.object({ until: z.string().nullable(), other: z.boolean().optional() }),
  /**
   * The teammate it was assigned to (a reference: their name is read when shown), or null for unassigned. `left`: the
   * teammate who left the team, which unassigned it; `imported`: they held it in an import and joined, which assigned it.
   */
  assignee: z.object({ assigneeId: z.string().nullable(), left: z.string().optional(), imported: z.boolean().optional() }),
  priority: z.object({ priority: z.boolean() }),
  spam: z.object({ spam: z.boolean() }),
  /** Take over (`team`; `byReply` when a teammate's reply did it) or Hand back to the AI (`ai`). */
  handled_by: z.object({ handledBy: z.enum(["ai", "team"]), byReply: z.boolean().optional() }),
  /** Handed to the team (the path's built-in step), and why (HANDOVER_REASONS). */
  handed_over: z.object({ reason: z.string() }),
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

/** Why the spam filter's AI check filed or let through a conversation it held (W4), by how sure the model was it's spam. */
const modelWhy = (probability = 0) => `the AI check was ${Math.floor(probability * 100)}% sure it's spam`;

const STATUS_TEXT = { open: "reopened it", waiting: "set it waiting on the user", closed: "closed it" } as const;

/**
 * An event in words, or null for a kind or details this release can't read (a later release's, while a deploy overlaps
 * the two). `names`: the teammates' names by id (who did it, an assignee); `person`: the conversation's person, as the
 * Inbox names them.
 */
export function tellEvent(
  row: { kind: string; actor: string; actorId: string | null; actorName: string | null; details: unknown },
  names: Map<string, string>,
  person = "Unknown",
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
          ? (row.details as { other?: boolean } | null)?.other
            ? "Someone else on the email thread"
            : person
          : row.actor === "tuti"
            ? "Tuti"
            : null;
  const told = (text: string, detail: string | null = null): ToldEvent => ({ who, text, detail, lines: [] });
  // How a message's change came: the person writing, or a teammate's reply.
  const by = row.actor === "user" ? "by writing" : "by replying";
  switch (row.kind as EventKind) {
    case "workflows_ran": {
      const { trigger, reason, workflows } = details as z.output<typeof EVENTS.workflows_ran>;
      const why = reason && ((HANDOVER_REASONS as Record<string, string>)[reason] ?? reason);
      return {
        who: (TRIGGERS as Record<string, string>)[trigger] ?? trigger,
        text: "ran",
        detail: `${workflows.length} ${workflows.length === 1 ? "workflow" : "workflows"} checked${why ? ` · ${why}` : ""}`,
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
        detail: verdict.by ? modelWhy(verdict.probability) : verdict.spam ? spamWhy(verdict.reason, verdict.phrase) : spamPassedWhy(verdict.check),
        lines: [],
      };
    }
    case "spam_would_file": {
      // ponytail: kept for W3's rows; drop once none is left (the plan's history).
      const { by, probability } = details as z.output<typeof EVENTS.spam_would_file>;
      return {
        who: "Spam filter",
        text: "would have filed it as spam",
        detail: by === "decision" && probability !== undefined ? `the decision model was ${Math.floor(probability * 100)}% sure; watching only` : "the chat model judged it spam; watching only",
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
      const { assigneeId, left, imported } = details as z.output<typeof EVENTS.assignee>;
      if (!assigneeId) {
        return told("unassigned it", left ? `${names.get(left) ?? "A former teammate"} left the team` : null);
      }
      const to = row.actor === "teammate" && assigneeId === row.actorId ? "assigned it to themselves" : `assigned it to ${names.get(assigneeId) ?? "a former teammate"}`;
      return told(to, imported ? "they held it in the import, and joined" : null);
    }
    case "priority":
      return told((details as z.output<typeof EVENTS.priority>).priority ? "marked it priority" : "took its priority off");
    case "spam":
      return told((details as z.output<typeof EVENTS.spam>).spam ? "marked it as spam" : "marked it not spam");
    case "handled_by": {
      const { handledBy, byReply } = details as z.output<typeof EVENTS.handled_by>;
      return handledBy === "team" ? told("took it over from the AI", byReply ? by : "Take over") : told("handed it back to the AI");
    }
    case "handed_over": {
      const { reason } = details as z.output<typeof EVENTS.handed_over>;
      return { who: null, text: "Handed to the team", detail: (HANDOVER_REASONS as Record<string, string>)[reason] ?? reason, lines: [] };
    }
  }
}

/** The teammates an event names (who did it, who it was assigned to), whose names are read when it's shown. */
export function eventPeople(row: { kind: string; actorId: string | null; details: unknown }): string[] {
  const assignee = row.kind === "assignee" ? EVENTS.assignee.safeParse(row.details).data : null;
  return [row.actorId, assignee?.assigneeId, assignee?.left].filter((id): id is string => !!id);
}
