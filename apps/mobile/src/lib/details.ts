import type { Api } from "./api";
import type { Conversation } from "./conversation";
import { withAi } from "./inbox";

/**
 * A conversation's details sheet: who it's with (`conversations.person`), who it can be assigned to
 * (`conversations.assignees`), and assigning, snoozing, closing, priority, spam and taking it over from the AI
 * (`conversations.update`); the server's operations are in apps/web/src/server/operations (conversation-person.ts,
 * conversations.ts).
 */

export type PostStatus = "open" | "under_review" | "planned" | "in_progress" | "completed" | "closed";
type PostLink = { number: number; title: string; status: PostStatus };

export type Person = {
  id: string | null;
  name: string | null;
  email: string | null;
  verified: boolean;
  account: boolean;
  blocked: boolean;
  maybe: { name: string; id: string | null } | null;
  properties: { key: string; label: string; text: string }[];
  groups: { key: string; name: string }[];
  posts: PostLink[];
  postCount: number;
  votes: PostLink[];
  voteCount: number;
  conversations: { number: number; subject: string; status: Conversation["status"]; lastMessageAt: string; line: string | null }[];
  conversationCount: number;
};

export type Assignee = { name: string; email: string; image: string | null; you: boolean };

/** What the sheet changes, and the header shows. */
export type Triage = Pick<Conversation, "status" | "assignee" | "spam" | "snoozedUntil" | "handledBy" | "priority">;

export const getPerson = (api: Api, number: number) => api<Person>(`/conversations/${number}/person`);

/** The team, the teammate asking first ("You"), the others in the order they joined. */
export const getAssignees = (api: Api) =>
  api<{ assignees: Assignee[] }>("/inbox/assignees").then(({ assignees }) => [...assignees.filter((a) => a.you), ...assignees.filter((a) => !a.you)]);

/** `handledBy`: Take over, from the AI. Handing back to it isn't offered: nothing answers for the AI yet. */
export type Change = { status: "open" | "closed" } | { assignee: string | null } | { spam: boolean } | { snoozedUntil: string | null } | { handledBy: "team" } | { priority: boolean };

export const updateConversation = (api: Api, number: number, change: Change) => api<Triage>(`/conversations/${number}`, { method: "PATCH", body: change });

/** One conversation screen's key: its server, project and number (the sheet over it uses the same). */
export const screenKey = (session: { server: string; project?: string }, number: number | string) => `${session.server}|${session.project ?? ""}|${number}`;

/**
 * What the conversation screen and its sheet show of its status and assignee, by screen key: the screen's fetches put it
 * here, and the sheet's changes too, so each shows the other's at once. Kept only while a screen or sheet for it is open
 * (`holdTriage`), so an entry is never one from an earlier visit.
 */
const shown = new Map<string, Triage>();
const changes = new Map<string, number>();
const holders = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/**
 * Held while a screen or sheet for the key is open; the returned function lets go. When the last one does, the entry
 * goes, counted as a change, so a fetch still on its way is dropped rather than putting it back.
 */
export function holdTriage(key: string) {
  holders.set(key, (holders.get(key) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    const left = holders.get(key)! - 1;
    if (left > 0) {
      holders.set(key, left);
      return;
    }
    holders.delete(key);
    changes.set(key, triageChanges(key) + 1);
    shown.delete(key);
    notify();
  };
}

/** How many changes have answered for this key: read as a fetch starts, and given to `showTriage` with its answer. */
export const triageChanges = (key: string) => changes.get(key) ?? 0;

/**
 * Shows a change's answer, or (with `since`, `triageChanges` as it started) a fetch's: dropped when a change answered
 * after the fetch started, so it doesn't put back what the change replaced. Nothing is kept for a key nobody holds: an
 * answer after its screen and sheet closed.
 */
export function showTriage(key: string, { status, assignee, spam, snoozedUntil, handledBy, priority }: Triage, since?: number) {
  if (!holders.has(key)) {
    return;
  }
  if (since === undefined) {
    changes.set(key, triageChanges(key) + 1);
  } else if (since !== triageChanges(key)) {
    return;
  }
  shown.set(key, { status, assignee, spam, snoozedUntil, handledBy, priority });
  notify();
}
export const getTriage = (key: string) => shown.get(key) ?? null;
export function subscribeTriage(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Snoozed now: closed and spam ones never are. */
export const isSnoozed = (triage: Triage, now = Date.now()) => !!triage.snoozedUntil && Date.parse(triage.snoozedUntil) > now && triage.status !== "closed" && !triage.spam;

/** A conversation's status as the web's details say it. */
export const STATUS_WORDS = { open: "Needs reply", waiting: "Waiting on user", closed: "Closed" } as const;

/** The header's short word for where it stands: spam, then the AI having it (snoozed or not, as its view), and a snooze, before its status. */
export const standing = (triage: Triage, now = Date.now()) =>
  triage.spam ? "Spam" : withAi(triage) ? "With AI" : isSnoozed(triage, now) ? "Snoozed" : ({ open: "Open", waiting: "Waiting", closed: "Closed" } as const)[triage.status];

/** The details' Status: the web's words, and never "Needs reply" on one the AI has. */
export const statusWords = (triage: Triage) => (withAi(triage) ? "With AI" : STATUS_WORDS[triage.status]);

/** When a snooze ends, in the teammate's own time, as the web says it: "Tue 3 Nov, 09:00" (and its year when not this one's). */
// Date and time apart: Hermes joins them with " at ".
export const snoozeTime = (at: Date, now = new Date()) =>
  `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(at.getFullYear() !== now.getFullYear() && { year: "numeric" }) })}, ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

/** 9:00 `days` from `now`, in the teammate's own time. */
function morning(days: number, now: Date) {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at;
}

/** The web's snooze choices: in 3 hours, tomorrow at 9:00, and the next Monday at 9:00 (a week on, on a Monday). */
export const snoozeChoices = (now = new Date()) => [
  { label: "In 3 hours", at: new Date(now.getTime() + 3 * 3_600_000) },
  { label: "Tomorrow, 9:00", at: morning(1, now) },
  { label: "Monday, 9:00", at: morning((8 - now.getDay()) % 7 || 7, now) },
];

export const POST_STATUS: Record<PostStatus, string> = {
  open: "Open",
  under_review: "Under review",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  closed: "Closed",
};

/** A day as the web's details show it: "12 November". */
export const dayOf = (at: string) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

/** A conversation's Activity (`conversations.activity`, W16): each row told in the server's words, newest first. */
export type ActivityFilter = "all" | "workflows" | "people";
export type ActivityEvent = {
  id: string;
  kind: string;
  actor: "teammate" | "api_key" | "user" | "workflow" | "spam_filter" | "ai" | "tuti";
  who: string | null;
  text: string;
  detail: string | null;
  workflows: { name: string; what: string }[];
  createdAt: string;
};
export type Activity = { events: ActivityEvent[]; next: string | null };

/** A page of it: the newest (`before` none), or the ones earlier than `before`; `limit` past the server's 20 to read again as far back as shown. */
export const getActivity = (api: Api, number: number, filter: ActivityFilter, { before, limit }: { before?: string; limit?: number } = {}) =>
  api<Activity>(`/conversations/${number}/activity?${new URLSearchParams({ filter, ...(before && { before }), ...(limit && { limit: String(limit) }) })}`);

/** When a row happened, as the web's Activity says it: the time today, else the day and the time ("12 Nov, 09:30"). */
export function activityTime(at: string, now = new Date()) {
  const date = new Date(at);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}
