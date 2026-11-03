import { changedSections, type Doc, fromPlainText, mergeSections, sameDoc, toPlainText } from "@tuti/content";
import { type CodeChangeActionStatus, Prisma, prisma } from "@tuti/db";

import { type AutopilotSettings, scheduleTogether } from "./autopilot";

/**
 * An article's update is its unpublished changes (docs/plan.md, V3): each pull request's edit is written on top of the
 * article's newest text and saved there as a revision tagged with its update, so each one's diff is its revision against
 * the one before. Edits are compared, merged and taken out by section: what's before the first heading, then each
 * heading and what follows it up to the next.
 */

type Block = NonNullable<Doc["content"]>[number];

/** Revisions kept per article (the oldest go past it), but never a tagged one, nor the one it's based on, while its update waits or can be undone. */
export const ARTICLE_REVISIONS_KEPT = 50;

/** An update whose tagged revision is still in play: waiting, going out by itself, or applied (Undo can take it out). */
export const LIVE_EDIT: CodeChangeActionStatus[] = ["PENDING", "STALE", "SCHEDULED", "APPLIED"];
/** Waiting for the team or going out by itself: in the article's unpublished changes. */
export const WAITING_EDIT: CodeChangeActionStatus[] = ["PENDING", "SCHEDULED"];
/** In the article's unpublished changes: waiting, going out, or out of date (its text is there all the same). */
const IN_CHANGES: CodeChangeActionStatus[] = ["PENDING", "STALE", "SCHEDULED"];

/** A saved version's text as a document (an article written before rich text has only its text). */
export const docOf = (version: { content: unknown; body: string }): Doc => (version.content as Doc | null) ?? fromPlainText(version.body);

export { changedSections, mergeSections, sameDoc, sections, withSectionsOf } from "@tuti/content";

const newestFirst: Prisma.ArticleRevisionOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
const versionSelect = { title: true, body: true, content: true, collectionId: true } as const;

/** The article's newest revision's id (null: none yet), as articles.update orders them. */
export const newestRevision = async (articleId: string, db: Prisma.TransactionClient = prisma) =>
  (await db.articleRevision.findFirst({ where: { articleId }, orderBy: newestFirst, select: { id: true } }))?.id ?? null;

/**
 * Lets an article's oldest revisions go past ARTICLE_REVISIONS_KEPT, keeping each tagged one (and the one it's based
 * on) while its update is in play: its diff, Dismiss and Undo need both. Call it with the project locked.
 */
export async function pruneRevisions(tx: Prisma.TransactionClient, articleId: string) {
  const old = await tx.articleRevision.findMany({ where: { articleId }, orderBy: newestFirst, skip: ARTICLE_REVISIONS_KEPT, select: { id: true } });
  if (old.length === 0) {
    return;
  }
  const tagged = await tx.articleRevision.findMany({
    where: { articleId, codeChangeAction: { status: { in: LIVE_EDIT } } },
    select: { id: true, basedOnId: true },
  });
  const kept = new Set(tagged.flatMap((revision) => [revision.id, revision.basedOnId ?? ""]));
  const gone = old.filter((revision) => !kept.has(revision.id)).map((revision) => revision.id);
  if (gone.length > 0) {
    await tx.articleRevision.deleteMany({ where: { id: { in: gone } } });
  }
}

/**
 * An edit's own change: the revision it was written on (`base`; null once that's gone, pruned by a release that didn't
 * keep it) and its tagged revision (`doc`), with whose it is.
 */
export type TaggedEdit = { revisionId: string; actionId: string; number: number | null; createdAt: Date; base: Doc | null; doc: Doc };

/** How an edit is named to the team: its pull request ("PR #12"), or Verify for a Verify run's fix (`number` null). */
export const editName = (edit: { number: number | null }) => (edit.number === null ? "Verify" : `PR #${edit.number}`);

/** The article's tagged edits whose updates are in `statuses`, oldest first: one written on another always after it. */
export async function taggedEdits(articleId: string, statuses: CodeChangeActionStatus[], db: Prisma.TransactionClient = prisma): Promise<TaggedEdit[]> {
  const found = await db.articleRevision.findMany({
    where: { articleId, codeChangeAction: { status: { in: statuses } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, body: true, content: true, basedOnId: true, createdAt: true, codeChangeAction: { select: { id: true, codeChange: { select: { number: true } } } } },
  });
  // By time, then by what each was written on (two saved in one millisecond, or a clock that stepped back).
  const ids = new Set(found.map((revision) => revision.id));
  const revisions: typeof found = [];
  const rest = [...found];
  while (rest.length > 0) {
    const next = rest.findIndex((revision) => !revision.basedOnId || !ids.has(revision.basedOnId) || revisions.some((done) => done.id === revision.basedOnId));
    revisions.push(...rest.splice(Math.max(next, 0), 1));
  }
  const bases = await db.articleRevision.findMany({
    where: { id: { in: revisions.flatMap((revision) => (revision.basedOnId ? [revision.basedOnId] : [])) } },
    select: { id: true, body: true, content: true },
  });
  return revisions.map((revision) => {
    const base = bases.find((b) => b.id === revision.basedOnId);
    return {
      revisionId: revision.id,
      actionId: revision.codeChangeAction!.id,
      number: revision.codeChangeAction!.codeChange?.number ?? null,
      createdAt: revision.createdAt,
      base: base ? docOf(base) : null,
      doc: docOf(revision),
    };
  });
}

/**
 * Whether the article's unpublished changes hold more than its waiting edits: a teammate's edit (or anything that
 * can't be told apart from one). The published version with each waiting edit applied by section, in order, must
 * be its unpublished text exactly.
 */
export async function hasTeammateEdit(articleId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { ...versionSelect, changes: { select: versionSelect } } });
  if (!article?.changes) {
    return false;
  }
  if (article.changes.title !== article.title || article.changes.collectionId !== article.collectionId) {
    return true;
  }
  let text: Doc | null = docOf(article);
  for (const edit of await taggedEdits(articleId, IN_CHANGES, db)) {
    // One whose base is gone can't be told apart from a teammate's edit: counted as one.
    text = text && edit.base && mergeSections(edit.base, edit.doc, text);
  }
  return !text || !sameDoc(text, docOf(article.changes));
}

/**
 * The edit (`edit.doc`, written on `edit.base`) taken out of `text` by section, or why not: the edits on top of it
 * (`edits`, as `taggedEdits` lists them: those after it are on top) that changed one of its sections, by pull request
 * number; none named, a teammate's edit did.
 */
export function takeOut(edit: TaggedEdit, text: Doc, edits: TaggedEdit[]): { doc: Doc } | { refused: string } {
  // Without what it was written on, its change isn't known: never "everything" (that would empty the article).
  if (!edit.base) {
    return { refused: "There's no record of what it changed any more: change it in the editor instead" };
  }
  const doc = mergeSections(edit.doc, edit.base, text);
  if (doc) {
    return { doc };
  }
  const mine = changedSections(edit.base, edit.doc);
  // Those after it in the list, matched by its revision (not listed: none is known to be on top).
  const at = edits.findIndex((other) => other.revisionId === edit.revisionId);
  const names = (at === -1 ? [] : edits.slice(at + 1))
    .filter((other) => other.base && [...changedSections(other.base, other.doc)].some((key) => mine.has(key)))
    .map(editName);
  return {
    refused:
      names.length > 0
        ? `${names.join(", ")}'s edit changed the same section since: take ${names.length === 1 ? "it" : "them"} out first`
        : "Someone edited the same section since: change it in the editor instead",
  };
}

/**
 * Saves an edit (`doc`, written on `writtenOn`) into the article's unpublished changes as a revision tagged with its
 * update. A newer text than it was written on gets only its changed sections; when that one changed one of the same
 * sections it's `conflict` (written again from the newest). `gone`: the article isn't published any more. Call it
 * with the project locked.
 */
export async function landEdit(
  tx: Prisma.TransactionClient,
  articleId: string,
  actionId: string,
  writtenOn: Doc,
  doc: Doc,
): Promise<"landed" | "conflict" | "gone"> {
  const article = await tx.article.findUnique({ where: { id: articleId }, select: { ...versionSelect, publishedAt: true, deletedAt: true, changes: { select: versionSelect } } });
  if (!article || article.deletedAt || !article.publishedAt) {
    return "gone";
  }
  const { title, body, content, collectionId } = article.changes ?? article;
  const saved = { title, body, content, collectionId };
  const now = docOf(saved);
  const text = sameDoc(now, writtenOn) ? doc : mergeSections(writtenOn, doc, now);
  if (!text) {
    return "conflict";
  }
  // Based on a revision of the text it's applied to: recorded first when the newest isn't (an article saved before revisions).
  const newest = await tx.articleRevision.findFirst({ where: { articleId }, orderBy: newestFirst, select: { id: true, ...versionSelect } });
  const base =
    newest && newest.title === saved.title && newest.collectionId === saved.collectionId && sameDoc(docOf(newest), now)
      ? newest.id
      : (await tx.articleRevision.create({ data: { articleId, ...saved, content: saved.content ?? Prisma.DbNull, createdAt: new Date() }, select: { id: true } })).id;
  const version = { title: saved.title, collectionId: saved.collectionId, body: toPlainText(text), content: text as Prisma.InputJsonValue };
  await tx.articleChanges.upsert({ where: { articleId }, create: { articleId, ...version }, update: version });
  await tx.articleRevision.create({ data: { articleId, ...version, codeChangeActionId: actionId, basedOnId: base, createdAt: new Date() } });
  await pruneRevisions(tx, articleId);
  return "landed";
}

/**
 * After an edit lands on an article: its waiting edits go out by themselves together, the hold restarting for all of
 * them, only when every one qualifies (and nobody stopped one); otherwise they all wait for someone, each saying why.
 * Returns how many are scheduled.
 */
export async function scheduleArticle(tx: Prisma.TransactionClient, articleId: string, project: AutopilotSettings, { keepDue = false } = {}): Promise<number> {
  // An out-of-date one in the changes holds them all, as the runner does (publishing would send it too).
  const outdated = (await tx.codeChangeAction.count({ where: { articleId, kind: "ARTICLE_EDIT", status: "STALE", revisions: { some: {} } } })) > 0;
  return scheduleTogether(tx, { articleId, kind: "ARTICLE_EDIT", revisions: { some: {} } }, project, {
    keepDue,
    held: outdated ? "Another edit to its article waits for you" : null,
    other: "Another edit to its article waits for you",
  });
}

/**
 * The tagged revisions in the article's unpublished changes, oldest first: what a save, Restore and the 409 protect.
 * Pull requests' edits and Verify's fixes (V5: updates with no pull request) alike, so every rule over waiting tagged
 * revisions covers both.
 */
export const editsInChanges = (articleId: string, db: Prisma.TransactionClient = prisma) => taggedEdits(articleId, IN_CHANGES, db);

/**
 * Whether `text`, replacing the article's unpublished text `now`, keeps the edit. A save in the editor (`any` false)
 * takes it out only when it replaces all the sections the edit changed: some of them is a teammate's edit on top (it
 * keeps waiting, its other sections still in the changes). Restore (`any`) takes it out when it replaces any of them
 * (a version from before it: Restore says so first, and the edit is dismissed rather than approved half there), unless
 * it restores the edit's own text there. One a
 * later edit already rewrote on the same section isn't taken out by text that leaves it as now. An edit whose base is
 * gone: kept only if `text` changes nothing.
 */
export function keepsEdit(edit: TaggedEdit, text: Doc, now: Doc, { any = false } = {}): boolean {
  const replaced = changedSections(now, text);
  if (!edit.base) {
    return replaced.size === 0;
  }
  const mine = [...changedSections(edit.base, edit.doc)];
  if (any) {
    // A section it changes from now to other than the edit's own text (restoring the edit's own version keeps it).
    const unlikeEdit = changedSections(edit.doc, text);
    return !mine.some((key) => replaced.has(key) && unlikeEdit.has(key));
  }
  return mine.some((key) => !replaced.has(key));
}

/** The article's newest text: its unpublished changes, else what's published (or its draft). */
export async function newestText(articleId: string, db: Prisma.TransactionClient = prisma): Promise<Doc> {
  const article = await db.article.findUniqueOrThrow({ where: { id: articleId }, select: { body: true, content: true, changes: { select: { body: true, content: true } } } });
  return docOf(article.changes ?? article);
}

/**
 * Dismisses the tagged revisions in the changes that `text` (about to replace them: a restored version) takes out,
 * by `by`, and returns them. Each tagged revision's update is dismissed (a Verify fix's is its run's record of it). Call
 * it in the transaction that saves `text`, with the project locked.
 */
export async function dismissTakenOut(
  tx: Prisma.TransactionClient,
  articleId: string,
  text: Doc,
  by: string | null,
  { edits, reason = "Taken out by restoring an earlier version", any = false }: { edits?: TaggedEdit[]; reason?: string; any?: boolean } = {},
): Promise<TaggedEdit[]> {
  const now = await newestText(articleId, tx);
  const taken = (edits ?? (await editsInChanges(articleId, tx))).filter((edit) => !keepsEdit(edit, text, now, { any }));
  if (taken.length > 0) {
    await tx.codeChangeAction.updateMany({
      where: { id: { in: taken.map((edit) => edit.actionId) }, status: { in: IN_CHANGES } },
      data: { status: "DISMISSED", decidedById: by, decidedAt: new Date(), dueAt: null, dismissReason: reason },
    });
  }
  return taken;
}

/**
 * The article's edits in its unpublished changes (out of date ones too) once they're published (APPLIED, by `by`) or discarded (DISMISSED),
 * as one: they were in them. Call it in the transaction that published or discarded them, with the project locked.
 */
export async function settleWaitingEdits(tx: Prisma.TransactionClient, articleId: string, status: "APPLIED" | "DISMISSED", by: string | null) {
  await tx.codeChangeAction.updateMany({
    where: { articleId, kind: "ARTICLE_EDIT", status: { in: IN_CHANGES }, revisions: { some: {} } },
    data: { status, decidedById: by, decidedAt: new Date(), dueAt: null, ...(status === "DISMISSED" && { dismissReason: "Its changes were discarded" }) },
  });
}
