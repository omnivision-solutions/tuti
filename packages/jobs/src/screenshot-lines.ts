import { type Doc, fromPlainText, MAX_ALT_LENGTH, toPlainText } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";

import { recordRevision } from "./article-layers";
import { lockProject } from "./running-draft";

/**
 * "[Screenshot: what it should show]" lines filled with screenshots of the team's app (docs/plan.md, SC2 and SC3): a
 * changelog entry's (changelog.takeScreenshots) or a help center article's (articles.takeScreenshots) asks a run
 * (screenshots.ts) for each line's screenshot, and once the run is done its job puts each one taken in place of its
 * line. A line that wasn't taken stays, so publishing still waits for it.
 */

type Block = NonNullable<Doc["content"]>[number];

/** The longest a screenshot's description may be (screenshots.take's). */
export const MAX_SHOW = 500;
/** How long placing may take, waiting on the entry's or project's lock behind a save or a publish included. */
const PLACING_MS = 30_000;
/** Where one starts: its end is the line's last "]", so nothing here backtracks however long the line. */
const MARKER_START = /^\[\s*screenshot\s*:/i;

/**
 * What a "[Screenshot: …]" line asks to show: a paragraph of its own in the text with nothing else in it; null for any
 * other block (one inside a sentence or a list has no place an image could take, and is left to the team).
 */
export function screenshotAsked(block: Block): string | null {
  if (block.type !== "paragraph") {
    return null;
  }
  const text = toPlainText(block).trim();
  const start = MARKER_START.exec(text);
  // Whole, however long: two lines alike up to a cut-off aren't the same line (the operations refuse one over
  // MAX_SHOW, which the agent isn't asked).
  return start && text.endsWith("]") ? text.slice(start[0].length, -1).trim() || null : null;
}

/** The "[Screenshot: …]" lines a text asks for, in order (see screenshotAsked). */
export const screenshotsAsked = (doc: Doc) => (doc.content ?? []).map(screenshotAsked).filter((show): show is string => show !== null);

/**
 * Claims a finished run (once, and only once it's ended: a second delivery of its job finds it running and leaves it
 * to the first) and puts its screenshots in `doc`, each in place of a line that asked for exactly it (one for one, in
 * order). Call it under the lock its text is saved under, so a line put back later as it was isn't filled again.
 * Null when there's nothing to place.
 */
async function fill(tx: Prisma.TransactionClient, runId: string, doc: Doc): Promise<{ text: Doc; placed: number } | null> {
  const { count } = await tx.screenshotRun.updateMany({ where: { id: runId, placedAt: null, state: { not: "RUNNING" } }, data: { placedAt: new Date() } });
  if (count === 0) {
    return null;
  }
  // Its screenshots read once it's claimed, never before: read while it ran (by a placement that then waited on the
  // lock), they'd lack the images taken since, which nothing would place after this claim.
  const shots = await tx.screenshot.findMany({
    where: { runId },
    orderBy: { position: "asc" },
    select: { show: true, description: true, image: { select: { id: true, status: true, width: true, height: true } } },
  });
  const taken = shots.flatMap(({ show, description, image }) =>
    image?.status === "READY" && image.width && image.height ? [{ show, description, id: image.id, w: image.width, h: image.height }] : [],
  );
  let placed = 0;
  const content = (doc.content ?? []).map((block): Block => {
    const asked = screenshotAsked(block);
    const at = asked === null ? -1 : taken.findIndex((shot) => shot.show === asked);
    if (at === -1) {
      return block;
    }
    const { show, description, id, w, h } = taken.splice(at, 1)[0]!;
    placed++;
    // What it shows, or, where the agent didn't say, what it was asked to show: never an image with no alt text.
    return { type: "image", attrs: { mediaId: id, width: "100", align: "center", alt: (description || show).slice(0, MAX_ALT_LENGTH), w, h } };
  });
  // Its images are kept as the screenshots' are (storeImage attaches them).
  return placed > 0 ? { text: { ...doc, content }, placed } : null;
}

/**
 * Puts a finished run's screenshots in the text it was taken for, read and saved under the lock its saves take, so a
 * line the team changed or took out meanwhile is left as they saved it, and a save waiting on the lock keeps what it
 * writes. Once per run (`placedAt`): the job does it, and the editor's read does it for a run finished without (by an
 * older worker, during a deploy). Returns how many were placed.
 */
export async function placeScreenshots(runId: string): Promise<number> {
  const run = await prisma.screenshotRun.findUniqueOrThrow({ where: { id: runId }, select: { projectId: true, startedById: true, changelogEntryId: true, articleId: true } });
  if (run.changelogEntryId) {
    return placeInEntry(runId, run.changelogEntryId);
  }
  if (run.articleId) {
    return placeInArticle(runId, run.articleId, run.projectId, run.startedById);
  }
  return 0;
}

/** A changelog entry's, under the entry's lock; the run records the version it replaced (changelog.update's `screenshotsSince`). */
function placeInEntry(runId: string, entryId: string) {
  return prisma.$transaction(async (tx) => {
    const [entry] = await tx.$queryRaw<{ content: unknown; body: string; updatedAt: Date }[]>`SELECT content, body, "updatedAt" FROM changelog_entry WHERE id = ${entryId} FOR UPDATE`;
    const filled = entry ? await fill(tx, runId, (entry.content as Doc | null) ?? fromPlainText(entry.body)) : null;
    if (!entry || !filled) {
      return 0;
    }
    await tx.changelogEntry.update({ where: { id: entryId }, data: { content: filled.text, body: toPlainText(filled.text) } });
    await tx.screenshotRun.update({ where: { id: runId }, data: { placedOver: entry.updatedAt } });
    return filled.placed;
  }, { timeout: PLACING_MS });
}

/**
 * A help center article's, under the project's lock as its saves are: into the text last saved (a draft's own, a
 * published one's unpublished changes, made from its published text if it has none, so readers see nothing until it's
 * published), recorded as a version by whoever started the run. An editor open on the version before then has a newer
 * one saved: its next save goes on top by section, as after a teammate's (articles.update), never putting the lines back.
 */
function placeInArticle(runId: string, articleId: string, projectId: string, by: string | null) {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const article = await tx.article.findUnique({
      where: { id: articleId },
      select: { title: true, body: true, content: true, collectionId: true, publishedAt: true, deletedAt: true, changes: { select: { title: true, body: true, content: true, collectionId: true } } },
    });
    const saved = article && !article.deletedAt ? (article.changes ?? article) : null;
    const filled = saved ? await fill(tx, runId, (saved.content as Doc | null) ?? fromPlainText(saved.body)) : null;
    if (!article || !saved || !filled) {
      return 0;
    }
    const text = { body: toPlainText(filled.text), content: filled.text as Prisma.InputJsonValue };
    if (article.publishedAt) {
      const changes = { title: saved.title, collectionId: saved.collectionId, ...text };
      await tx.articleChanges.upsert({ where: { articleId }, create: { articleId, ...changes }, update: changes });
    } else {
      await tx.article.update({ where: { id: articleId }, data: text });
    }
    await recordRevision(tx, articleId, by);
    return filled.placed;
  }, { timeout: PLACING_MS });
}
