import type { ImportView } from "@/server/operations/imports";

/**
 * What an import can bring from another tool (docs/plan.md, Switching from Featurebase), as the setup step offers it:
 * only parts that are built. `needs`: parts it can't come without (Feedback and Inbox need Contacts, so the right people
 * wrote each post and message). `media`: it brings images or files, which need media storage. In the order the import
 * runs them (@tuti/jobs IMPORT_PARTS).
 */
export const IMPORT_PARTS = {
  team: {
    label: "Team",
    description: "Your Featurebase team, as invitations you review and send. They join as members; owners can change roles in Team & roles.",
    brings: "Your team, as invitations to send",
    needs: [],
    media: false,
    see: { label: "See team", page: "settings/team" },
    steps: { team: "Team" },
    kinds: ["invitations"],
  },
  contacts: {
    label: "Contacts",
    description: "Your users, with their custom fields and company, as Users.",
    brings: "Your users, with their custom fields",
    needs: [],
    media: false,
    see: { label: "See users", page: "users" },
    steps: { contacts: "Contacts" },
    kinds: ["contacts"],
  },
  feedback: {
    label: "Feedback",
    description: "Boards, posts, votes and comments, with their dates; the team's private comments as notes.",
    brings: "Boards, posts, votes and comments",
    needs: ["contacts"],
    media: true,
    see: { label: "See feedback", page: "feedback" },
    steps: { posts: "Posts", votes: "Votes", comments: "Comments", embeddings: "Duplicate check" },
    kinds: ["boards", "posts", "votes", "comments", "notes", "images", "files", "videos"],
  },
  changelog: {
    label: "Changelog",
    description: "Your updates, published at their dates (drafts stay drafts), with their images; categories like New, Improved and Fixed become tags. Nothing is emailed.",
    brings: "Your updates, with their images",
    needs: [],
    media: true,
    see: { label: "See changelog", page: "changelog" },
    steps: { changelog: "Changelog" },
    kinds: ["changelogEntries", "changelogImages", "changelogFiles", "changelogVideos", "changelogComments"],
  },
  docs: {
    label: "Help center",
    description: "Collections and articles, with their images, files and the links between them.",
    brings: "Collections and articles, with their images",
    needs: [],
    media: true,
    see: { label: "See docs", page: "docs" },
    steps: { "docs-collections": "Collections", "docs-articles": "Articles", "docs-content": "Their content", "docs-unreached": "Last check" },
    kinds: ["collections", "articles", "privateDrafts", "limitDrafts", "unpublishedChanges", "articleImages", "articleFiles", "articleVideos"],
  },
  inbox: {
    label: "Inbox",
    description: "Conversations with their messages, notes and images, as the Inbox.",
    brings: "Conversations and their messages",
    needs: ["contacts"],
    media: true,
    see: { label: "See conversations", page: "inbox" },
    steps: { conversations: "Conversations" },
    kinds: ["conversations", "messages", "attachments"],
  },
  // Last, so nothing waits for it: the least of it, and the slowest.
  avatars: {
    label: "Profile pictures",
    description: "Your users' uploaded profile pictures, copied last so the rest doesn't wait for them.",
    brings: "Your users' profile pictures",
    needs: ["contacts"],
    media: true,
    // Contacts' See users is the way to them.
    see: null,
    steps: { avatars: "Profile pictures" },
    kinds: ["avatars"],
  },
} as const satisfies Record<string, ImportPartInfo>;

/**
 * `brings`: what it brings, in a few words, while it waits its turn. `see`: where what it brought is in the app, once the
 * import ends (null: another part's link goes there). `steps`: its steps (@tuti/jobs IMPORT_PARTS) and what each is called; `kinds`: what it counts (imports'
 * counts), in the order it brings them.
 */
export type ImportPartInfo = {
  label: string;
  description: string;
  brings: string;
  needs: readonly string[];
  media: boolean;
  see: { label: string; page: string } | null;
  steps: Record<string, string>;
  kinds: readonly string[];
};
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
  invitations: ["invitation", "invitations"],
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
  avatars: ["profile picture", "profile pictures"],
  // The help center's, counted apart from feedback's.
  articleImages: ["image in an article", "images in articles"],
  articleFiles: ["file in an article", "files in articles"],
  articleVideos: ["video in an article", "videos in articles"],
  changelogEntries: ["changelog entry", "changelog entries"],
  // The changelog's, counted apart from feedback's and the help center's.
  changelogImages: ["image in the changelog", "images in the changelog"],
  changelogFiles: ["file in the changelog", "files in the changelog"],
  changelogVideos: ["video in the changelog", "videos in the changelog"],
  changelogComments: ["comment on the changelog", "comments on the changelog"],
  conversations: ["conversation", "conversations"],
  messages: ["new message in conversations already here", "new messages in conversations already here"],
  attachments: ["attachment", "attachments"],
};

/** An import's count of a kind, as its number and what it counts (["12", "contacts"]). */
const kindParts = (kind: string, n: number) => {
  const [one, many] = KINDS[kind] ?? [kind, kind];
  return [n.toLocaleString("en"), n === 1 ? one : many] as const;
};

/** An import's count of a kind, in words ("12 contacts"). */
export const kindCount = (kind: string, n: number) => kindParts(kind, n).join(" ");

/** Why an import skips what an earlier one brought: ALREADY_HERE in @tuti/jobs (which a page in the browser can't import). */
const ALREADY_HERE = "already brought across earlier";

/** An import's title, as the setup step and Home say it. */
export const importTitle = (run: ImportView) =>
  run.state === "running" ? "Importing from Featurebase" : run.state === "done" ? "Imported from Featurebase" : "The import from Featurebase stopped";

/**
 * What `counts` brought of `kinds` (["12", "contacts"]), what they left out and why ("2 contacts without a name") and
 * how many, in `kinds`' order; and how many they skipped as already brought across earlier, which isn't left out.
 */
function described(counts: ImportView["counts"], kinds: readonly string[]) {
  const present = kinds.filter((kind) => counts[kind]);
  const leftOut = present.flatMap((kind) => Object.entries(counts[kind]!.leftOut).filter(([reason]) => reason !== ALREADY_HERE).map(([reason, n]) => [kind, reason, n] as const));
  return {
    brought: present.flatMap((kind) => (counts[kind]!.imported > 0 ? [kindParts(kind, counts[kind]!.imported)] : [])),
    leftOut: leftOut.map(([kind, reason, n]) => `${kindCount(kind, n)} ${reason}`),
    leftOutCount: leftOut.reduce((sum, [, , n]) => sum + n, 0),
    skipped: present.reduce((sum, kind) => sum + (counts[kind]!.leftOut[ALREADY_HERE] ?? 0), 0),
  };
}

/** What was brought, in words ("12 contacts, 3 posts"). */
export const broughtWords = (brought: readonly (readonly [string, string])[]) => brought.map((count) => count.join(" ")).join(", ");

/** What an import brought so far, and what it left out and why, in a sentence or two. */
export function importSummary(run: ImportView) {
  // In the order the import brings them (the database keeps them in its own); a kind only left out isn't "brought".
  const known = Object.values(IMPORT_PARTS).flatMap((part) => part.kinds as readonly string[]);
  const counts = described(run.counts, [...known, ...Object.keys(run.counts).filter((kind) => !known.includes(kind))]);
  const brought = broughtWords(counts.brought);
  const done = run.state === "running" ? (brought ? `${brought} so far.` : "Starting…") : `${brought || "Nothing"} brought across.`;
  const leftOut = counts.leftOut.length > 0 && `Left out: ${counts.leftOut.join("; ")}.`;
  return [done, leftOut, counts.skipped > 0 && "Skipped what was already brought across earlier.", run.error].filter(Boolean).join(" ");
}

/**
 * Where each picked part of an import is, in the order it runs them: done, under way (`now`, at `step`, one of its
 * `steps`), `next`, waiting, or where a failed import `stopped` (and `waiting` after it); what it brought and left out.
 */
export function importProgress(run: ImportView) {
  const picked = (Object.keys(IMPORT_PARTS) as ImportPart[]).filter((part) => run.parts.includes(part));
  // One that stopped at Feedback's avatars, from before they were a part of their own: Feedback's, before its last step.
  const step = run.step === "avatars" && !picked.includes("avatars") ? "embeddings" : run.step;
  const at = step ? picked.findIndex((part) => step in IMPORT_PARTS[part].steps) : -1;
  return picked.map((part, i) => {
    const state =
      run.state === "done" || i < at ? "done" : i === at ? (run.state === "running" ? "now" : "stopped") : run.state === "running" && i === at + 1 ? "next" : "waiting";
    // Imports from before the help center counted its media apart kept it as feedback's kinds: the help center's when
    // there's no feedback. Those from before profile pictures were a part of their own counted them in feedback.
    const kinds =
      part === "docs" && !picked.includes("feedback")
        ? [...IMPORT_PARTS.docs.kinds, "images", "files", "videos"]
        : part === "feedback" && !picked.includes("avatars")
          ? [...IMPORT_PARTS.feedback.kinds, "avatars"]
          : IMPORT_PARTS[part].kinds;
    return { part, state, step: i === at ? step : null, ...described(run.counts, kinds) } as const;
  });
}

/** Which part of how many is under way ("Part 2 of 5"), while an import runs (null: none). */
export function importAt(run: ImportView) {
  const parts = importProgress(run);
  const at = parts.findIndex((part) => part.state === "now");
  return at < 0 ? null : `Part ${at + 1} of ${parts.length}`;
}

/** What's said under an import's title: the part under way, or why it stopped. */
export const importNote = (run: ImportView) => (run.state === "running" ? importAt(run) && `${importAt(run)}.` : run.state === "failed" ? run.error : null);

/** An import in a line, as Home's card says it: the part under way, the parts it brought, or where it stopped and why. */
export function importBrief(run: ImportView) {
  const progress = importProgress(run);
  const at = progress.find(({ state }) => state === "now" || state === "stopped");
  const label = at && IMPORT_PARTS[at.part].label;
  if (run.state === "running") {
    const brought = at && broughtWords(at.brought);
    return at ? `${importAt(run)}: ${label}, ${brought ? `${brought} so far` : at.leftOut.length > 0 || at.skipped > 0 ? "nothing new so far" : "starting"}.` : "Starting…";
  }
  if (run.state === "failed") {
    return [at && `Stopped at ${label}.`, run.error].filter(Boolean).join(" ");
  }
  // Only the parts that brought something: one that only left things out (all of them already here, on importing again) didn't.
  const brought = progress.filter((part) => part.brought.length > 0).map(({ part }) => IMPORT_PARTS[part].label);
  return brought.length > 0 ? `${new Intl.ListFormat("en").format(brought)} brought across.` : "Nothing new brought across.";
}

/** How long Home shows an import's result once it ended. */
const SHOWN_MS = 3 * 24 * 60 * 60_000;

/** Whether Home shows an import: while it runs, and for a few days after it ended. */
export const onHome = (run: ImportView, now = Date.now()) => run.state === "running" || now - new Date(run.finishedAt!).getTime() < SHOWN_MS;

/** How many invitations Home says wait to be sent, once an import ended: only to owners and admins, who can send them. */
export const homeInvitationsToSend = (run: ImportView, admin: boolean) => (admin && run.state !== "running" ? run.invitationsToSend : 0);
