import { type Doc, fromPlainText, toPlainText } from "@tuti/content";
import { type CodeChangeActionStatus, Prisma, prisma } from "@tuti/db";

import { type AutopilotSettings, dueAt, waitsBecause } from "./autopilot";

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

/** A saved version's text as a document (an article written before rich text has only its text). */
export const docOf = (version: { content: unknown; body: string }): Doc => (version.content as Doc | null) ?? fromPlainText(version.body);

/** JSON with its keys in one order, so a document read back from Postgres compares equal to the one written. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

export const sameDoc = (a: Doc, b: Doc) => canon(a.content ?? []) === canon(b.content ?? []);

/** The article's top-level sections in order: what's before the first heading, then each heading and what follows it up to the next. */
export function sections(blocks: Block[]): Block[][] {
  const out: Block[][] = [[]];
  for (const block of blocks) {
    if (block.type === "heading" && out.at(-1)!.length > 0) {
      out.push([]);
    }
    out.at(-1)!.push(block);
  }
  return out.filter((section) => section.length > 0);
}

/**
 * Sections by key: the heading's text ("" before the first heading), numbered when one repeats. ponytail: a renamed
 * heading is a different section (taken out and added), so an edit to it and to its old name count as the same one.
 */
function keyed(doc: Doc): [string, Block[]][] {
  const seen = new Map<string, number>();
  return sections(doc.content ?? []).map((section) => {
    const head = section[0]!.type === "heading" ? toPlainText(section[0]!).trim() : "";
    const n = seen.get(head) ?? 0;
    seen.set(head, n + 1);
    return [`${head}\u0000${n}`, section];
  });
}

/** The sections that differ from `a` to `b`: changed, added or taken out. */
export function changedSections(a: Doc, b: Doc): Set<string> {
  const [x, y] = [new Map(keyed(a)), new Map(keyed(b))];
  return new Set([...new Set([...x.keys(), ...y.keys()])].filter((key) => canon(x.get(key)) !== canon(y.get(key))));
}

/** Whether `b` keeps the sections `a` has in the same order (sections added or taken out aside). */
function sameOrder(a: Doc, b: Doc): boolean {
  const [x, y] = [keyed(a).map(([key]) => key), keyed(b).map(([key]) => key)];
  const [inX, inY] = [x.filter((key) => y.includes(key)), y.filter((key) => x.includes(key))];
  return inX.every((key, i) => key === inY[i]);
}

/**
 * `ours` (an edit of `base`) applied by section onto `theirs` (another edit of `base`): the sections it changed,
 * added (after the one before it in `ours`) or took out. `theirs` still `base`: `ours` as it is. Null when both changed
 * one of the same sections, or `ours` moves sections around (a merge by section can't keep that).
 */
export function mergeSections(base: Doc, ours: Doc, theirs: Doc): Doc | null {
  if (sameDoc(base, theirs)) {
    return ours;
  }
  if (!sameOrder(base, ours)) {
    return null;
  }
  const mine = changedSections(base, ours);
  const others = changedSections(base, theirs);
  if ([...mine].some((key) => others.has(key))) {
    return null;
  }
  const result = keyed(theirs);
  const ordered = keyed(ours);
  for (const key of mine) {
    const at = result.findIndex(([k]) => k === key);
    const section = ordered.find(([k]) => k === key);
    if (!section) {
      result.splice(at, 1);
    } else if (at !== -1) {
      result[at] = section;
    } else {
      // After the section before it in `ours` that's there, or first.
      const before = ordered.slice(0, ordered.indexOf(section)).reverse().find(([k]) => result.some(([r]) => r === k));
      result.splice(before ? result.findIndex(([r]) => r === before[0]) + 1 : 0, 0, section);
    }
  }
  return { type: "doc", content: result.flatMap(([, blocks]) => blocks) };
}

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
export type TaggedEdit = { revisionId: string; actionId: string; number: number; createdAt: Date; base: Doc | null; doc: Doc };

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
      number: revision.codeChangeAction!.codeChange.number,
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
  for (const edit of await taggedEdits(articleId, WAITING_EDIT, db)) {
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
  const numbers = (at === -1 ? [] : edits.slice(at + 1))
    .filter((other) => other.base && [...changedSections(other.base, other.doc)].some((key) => mine.has(key)))
    .map((other) => `#${other.number}`);
  return {
    refused:
      numbers.length > 0
        ? `PR ${numbers.join(", PR ")}'s edit changed the same section since: take ${numbers.length === 1 ? "it" : "them"} out first`
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
/**
 * An edit a teammate stopped (Stop says who). Not one the runner or Publish now holds while applying it: they claim it
 * the same way (waiting, with whoever applies it), but without a Stop's words.
 */
const stopped = (edit: { status: string; decidedById: string | null; waitReason: string | null }) =>
  edit.status === "PENDING" && edit.decidedById !== null && Boolean(edit.waitReason?.startsWith("Stopped by"));

export async function scheduleArticle(tx: Prisma.TransactionClient, articleId: string, project: AutopilotSettings, { keepDue = false } = {}): Promise<number> {
  const edits = await tx.codeChangeAction.findMany({
    where: { articleId, kind: "ARTICLE_EDIT", status: { in: WAITING_EDIT }, revisions: { some: {} } },
    select: { id: true, codeChangeId: true, kind: true, probability: true, payload: true, postId: true, articleId: true, status: true, decidedById: true, waitReason: true, dueAt: true },
  });
  const reasons = await Promise.all(
    edits.map((edit) => (stopped(edit) ? edit.waitReason! : waitsBecause(edit, project, tx))),
  );
  if (reasons.every((reason) => reason === null)) {
    await tx.codeChangeAction.updateMany({
      where: { id: { in: edits.map((edit) => edit.id) } },
      // `keepDue` (an edit taken out, none landing): those already going out keep their time, and the rest join them.
      data: { status: "SCHEDULED", dueAt: (keepDue && edits.find((edit) => edit.status === "SCHEDULED")?.dueAt) || dueAt("ARTICLE_EDIT", project), waitReason: null, decidedById: null },
    });
    return edits.length;
  }
  for (const [i, edit] of edits.entries()) {
    // One that would go by itself says what holds it; one that was going says why it stopped; a teammate's stop keeps its words.
    if (!stopped(edit)) {
      await tx.codeChangeAction.update({
        where: { id: edit.id },
        data: {
          status: "PENDING",
          dueAt: null,
          waitReason: reasons[i] === null ? "Another edit to its article waits for you" : edit.status === "SCHEDULED" ? reasons[i] : edit.waitReason,
        },
      });
    }
  }
  return 0;
}

/**
 * The article's waiting edits once its unpublished changes are published (APPLIED, by `by`) or discarded (DISMISSED),
 * as one: they were in them. Call it in the transaction that published or discarded them, with the project locked.
 */
export async function settleWaitingEdits(tx: Prisma.TransactionClient, articleId: string, status: "APPLIED" | "DISMISSED", by: string | null) {
  await tx.codeChangeAction.updateMany({
    where: { articleId, kind: "ARTICLE_EDIT", status: { in: WAITING_EDIT }, revisions: { some: {} } },
    data: { status, decidedById: by, decidedAt: new Date(), dueAt: null, ...(status === "DISMISSED" && { dismissReason: "Its changes were discarded" }) },
  });
}
