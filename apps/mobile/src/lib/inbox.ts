/**
 * The Inbox's list, as the server's operations give it (apps/web/src/server/operations/conversations.ts):
 * `conversations.views` (GET /inbox/views) for the filter chips and `conversations.list` (GET /conversations) for the
 * rows, a page at a time.
 */

export type ViewName = "open" | "mine" | "unassigned" | "waiting" | "snoozed" | "closed" | "spam";
export type InboxView = { view: ViewName; title: string; count: number };

export type Row = {
  number: number;
  subject: string;
  status: "open" | "waiting" | "closed";
  user: { name: string | null; email: string | null };
  assignee: { name: string; email: string } | null;
  lastMessageAt: string;
  company: string | null;
  unread: boolean;
  latestMessage: { author: "user" | "team" | "ai" | "tuti"; name: string | null; fromYou: boolean; fromAddress: string | null; line: string | null } | null;
  /** With a search: the message it was found by. */
  match: { note: boolean; snippet: string } | null;
};

export type Page = { conversations: Row[]; nextCursor: string | null; total: number };

export const PAGE_SIZE = 25;

/** One page of a view, or of a search (every view but spam, as the web's search). */
export function listPath({ view, q, cursor = 0, limit = PAGE_SIZE }: { view: ViewName; q?: string; cursor?: number | string; limit?: number }) {
  const query = q ? `q=${encodeURIComponent(q)}` : `view=${view}`;
  return `/conversations?${query}&limit=${limit}&cursor=${cursor}`;
}

/**
 * Where to look for one conversation as the view lists it: its number as a search within the view (a number finds that
 * conversation). Not in the answer: no longer in the view.
 */
// ponytail: a number also finds conversations with "#12" in their text; 100 covers it unless that many do.
export const rowPath = (view: ViewName, number: number) => `/conversations?view=${view}&q=${encodeURIComponent(`#${number}`)}&limit=100`;

/** Who it's with, as the web's row says. */
export const personOf = (row: Row) => row.user.name ?? row.user.email ?? "Unknown";

/** The line under the subject: in a search, the message it was found by; otherwise the latest, with who wrote it when it isn't the person. */
export function lineOf(row: Row): string | null {
  if (row.match) {
    return `${row.match.note ? "Note: " : ""}${row.match.snippet}`;
  }
  const message = row.latestMessage;
  if (!message?.line) {
    return null;
  }
  const by = byOf(message);
  return by ? `${by}: ${message.line}` : message.line;
}

/** As the web's `rowBy`: "AI", "You", another teammate's first name, "Tuti", or someone else on the email thread. */
function byOf(message: NonNullable<Row["latestMessage"]>) {
  if (message.author === "ai") {
    return "AI";
  }
  if (message.author === "user") {
    return message.fromAddress;
  }
  return message.fromYou ? "You" : message.name?.trim().split(/\s+/)[0] || "Tuti";
}

/** How long ago, short, as the web's row: "5m", "3h", "2d" (under a minute is "1m"). */
export function ageOf(at: string, now = Date.now()) {
  const minutes = Math.max(1, Math.floor((now - Date.parse(at)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return minutes < 60 ? `${minutes}m` : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** `ageOf` in words, to be read out: "5 minutes ago", "1 hour ago", "2 days ago". */
export function spokenAgeOf(at: string, now = Date.now()) {
  const [, n, unit] = /^(\d+)([mhd])$/.exec(ageOf(at, now))!;
  const word = { m: "minute", h: "hour", d: "day" }[unit as "m" | "h" | "d"];
  return `${n} ${word}${n === "1" ? "" : "s"} ago`;
}

export const STATUS = { open: "Open", waiting: "Waiting", closed: "Closed" } as const;
/** A search finds every status: the row says which, before its age. */
export const searchAgeOf = (row: Row, now = Date.now()) => `${STATUS[row.status]} · ${ageOf(row.lastMessageAt, now)}`;

/** Initials for the face beside a row: "Maya Chen" → "MC", "sam@example.com" → "S". */
export const initialsOf = (name: string) =>
  name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("") || "?";

/** A page after the rows already shown, without those it repeats (offset pages shift as conversations move up). */
export const appendPage = (rows: Row[], page: Row[]) => [...rows, ...page.filter((row) => !rows.some((shown) => shown.number === row.number))];

/** The list once one conversation is fetched again: in place and in order, or gone (`found` null: it left the view). */
export function withRow(rows: Row[], number: number, found: Row | null) {
  const others = rows.filter((row) => row.number !== number);
  if (!found) {
    return others;
  }
  // Latest message first, as the server orders them.
  const after = others.findIndex((row) => row.lastMessageAt < found.lastMessageAt || (row.lastMessageAt === found.lastMessageAt && row.number < found.number));
  // Older than every row shown: it's on a page not loaded yet.
  if (after === -1) {
    return rows.some((row) => row.number === number) ? [...others, found] : others;
  }
  return [...others.slice(0, after), found, ...others.slice(after)];
}

/**
 * The latest of a run of loads: `start()` before each, `isLatest(n)` when it answers. A load that a newer one replaced
 * (a refresh still running when the view, the search or the project changed) is dropped. What adds to the list shown
 * (a page, a row) takes `current()`, so it's dropped too once the list is loaded again.
 */
export function latestOnly() {
  let latest = 0;
  return { start: () => ++latest, current: () => latest, isLatest: (n: number) => n === latest };
}
