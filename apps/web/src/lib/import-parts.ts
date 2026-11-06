import type { ImportView } from "@/server/operations/imports";

/**
 * What an import can bring from another tool (docs/plan.md, Switching from Featurebase), as the setup step offers it:
 * only parts that are built. `needs`: parts it can't come without (Feedback and Inbox need Contacts, so the right people
 * wrote each post and message). `media`: it brings images or files, which need media storage. Feedback, the help center
 * and the inbox add theirs (I3–I5), in the order the import runs them (@tuti/jobs IMPORT_PARTS).
 */
export const IMPORT_PARTS = {
  contacts: { label: "Contacts", description: "Your users, with their custom fields and company, as Users.", needs: [], media: false, see: { label: "See users", page: "users" } },
  feedback: {
    label: "Feedback",
    description: "Boards, posts, votes and comments, with their dates; the team's private comments as notes.",
    needs: ["contacts"],
    media: true,
    see: { label: "See feedback", page: "feedback" },
  },
  docs: { label: "Help center", description: "Collections and articles, with their images, files and the links between them.", needs: [], media: true, see: { label: "See docs", page: "docs" } },
  inbox: { label: "Inbox", description: "Conversations with their messages, notes and images, as the Inbox.", needs: ["contacts"], media: true, see: { label: "See conversations", page: "inbox" } },
} as const satisfies Record<string, ImportPartInfo>;

/** `see`: where what it brought is in the app (Home's link once an import ends: the first picked part's). */
export type ImportPartInfo = { label: string; description: string; needs: readonly string[]; media: boolean; see: { label: string; page: string } };
export type ImportPart = keyof typeof IMPORT_PARTS;

/**
 * The picked parts after ticking (`on`) or unticking one: ticking one ticks what it needs, unticking one unticks what
 * needs it, all the way along.
 */
export function pickPart<P extends string>(picked: readonly P[], part: P, on: boolean, parts: Record<P, { needs: readonly string[] }>): P[] {
  const keys = Object.keys(parts) as P[];
  const next = new Set(picked);
  const visit = (p: P) => {
    if (on ? next.has(p) : !next.has(p)) {
      return;
    }
    if (on) {
      next.add(p);
      parts[p].needs.forEach((need) => visit(need as P));
    } else {
      next.delete(p);
      keys.filter((other) => parts[other].needs.includes(p)).forEach(visit);
    }
  };
  visit(part);
  // In the list's order, whatever order they were ticked in.
  return keys.filter((p) => next.has(p));
}

/** A picked part whose needs aren't picked (null: none), as imports.start refuses it. */
export function missingNeed<P extends string>(picked: readonly P[], parts: Record<P, { needs: readonly string[] }>): { part: P; need: P } | null {
  for (const part of picked) {
    const need = parts[part].needs.find((n) => !picked.includes(n as P));
    if (need) {
      return { part, need: need as P };
    }
  }
  return null;
}

/** What each kind an import counts is called, one and many (imports' counts: contacts, …). */
const KINDS: Record<string, [string, string]> = {
  contacts: ["contact", "contacts"],
  boards: ["board", "boards"],
  posts: ["post", "posts"],
  votes: ["vote", "votes"],
  comments: ["comment", "comments"],
  notes: ["note", "notes"],
  collections: ["collection", "collections"],
  articles: ["article", "articles"],
  privateDrafts: ["article as a draft (only some people could see it)", "articles as drafts (only some people could see them)"],
  limitDrafts: ["article as a draft (past the plan's article limit)", "articles as drafts (past the plan's article limit)"],
  unpublishedChanges: ["article's unpublished changes", "articles' unpublished changes"],
  images: ["image", "images"],
  files: ["file", "files"],
  videos: ["video", "videos"],
  avatars: ["avatar", "avatars"],
  conversations: ["conversation", "conversations"],
  attachments: ["attachment", "attachments"],
};

/** An import's count of a kind, in words ("12 contacts"). */
export const kindCount = (kind: string, n: number) => {
  const [one, many] = KINDS[kind] ?? [kind, kind];
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
};

/** An import's title, as the setup step and Home say it. */
export const importTitle = (run: ImportView) =>
  run.state === "running" ? "Importing from Featurebase" : run.state === "done" ? "Imported from Featurebase" : "The import from Featurebase stopped";

/** What an import brought so far, and what it left out and why, in a sentence or two. */
export function importSummary(run: ImportView) {
  // In the order the import brings them (the database keeps them in its own); a kind only left out isn't "brought".
  const rank = (kind: string) => (kind in KINDS ? Object.keys(KINDS).indexOf(kind) : Infinity);
  const kinds = Object.entries(run.counts).sort(([a], [b]) => rank(a) - rank(b));
  const brought = kinds.flatMap(([kind, count]) => (count.imported > 0 ? [kindCount(kind, count.imported)] : [])).join(", ");
  const leftOut = kinds.flatMap(([kind, count]) => Object.entries(count.leftOut).map(([reason, n]) => `${kindCount(kind, n)} ${reason}`));
  const done = run.state === "running" ? (brought ? `${brought} so far.` : "Starting…") : `${brought || "Nothing"} brought across.`;
  return [done, leftOut.length > 0 && `Left out: ${leftOut.join("; ")}.`, run.error].filter(Boolean).join(" ");
}

/** How long Home shows an import's result once it ended. */
const SHOWN_MS = 3 * 24 * 60 * 60_000;

/** Whether Home shows an import: while it runs, and for a few days after it ended. */
export const onHome = (run: ImportView, now = Date.now()) => run.state === "running" || now - new Date(run.finishedAt!).getTime() < SHOWN_MS;

/** Where an ended import's link on Home goes: the first part it brought, in the order the import runs them. */
export const importSee = (run: ImportView) => (Object.entries(IMPORT_PARTS) as [ImportPart, ImportPartInfo][]).find(([part]) => run.parts.includes(part))?.[1].see ?? null;
