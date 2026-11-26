import { type Doc, fromPlainText, MAX_ALT_LENGTH, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";

/**
 * Changelog drafts' "[Screenshot: what it should show]" lines filled with screenshots of the team's app (docs/plan.md,
 * SC2): changelog.takeScreenshots asks a run (screenshots.ts) for each line's screenshot, and once the run is done its
 * job puts each one taken in place of its line. A line that wasn't taken stays, so publishing still waits for it.
 */

type Block = NonNullable<Doc["content"]>[number];

/** The longest a screenshot's description may be (screenshots.take's). */
const MAX_SHOW = 500;
/** How long placing may take, waiting on the entry's lock behind a save or a publish included. */
const PLACING_MS = 30_000;
/** Where one starts: its end is the line's last "]", so nothing here backtracks however long the line. */
const MARKER_START = /^\[\s*screenshot\s*:/i;

/**
 * What a "[Screenshot: …]" line asks to show: a paragraph of its own in the entry's text with nothing else in it; null
 * for any other block (one inside a sentence or a list has no place an image could take, and is left to the team).
 */
export function screenshotAsked(block: Block): string | null {
  if (block.type !== "paragraph") {
    return null;
  }
  const text = toPlainText(block).trim();
  const start = MARKER_START.exec(text);
  return start && text.endsWith("]") ? text.slice(start[0].length, -1).trim().slice(0, MAX_SHOW) || null : null;
}

/** The "[Screenshot: …]" lines a text asks for, in order (see screenshotAsked). */
export const screenshotsAsked = (doc: Doc) => (doc.content ?? []).map(screenshotAsked).filter((show): show is string => show !== null);

/**
 * Puts a finished run's screenshots in its changelog entry, each in place of a line that asked for exactly it (one for
 * one, in order): read and saved under the entry's lock, as publishing reads it, so a line the team changed or took out
 * meanwhile is left as they saved it, and a save waiting on the lock keeps what it writes. Once per run (`placedAt`): the
 * job does it, and the editor's read does it for a run finished without (by an older worker, during a deploy). Returns
 * how many were placed.
 */
export async function placeChangelogScreenshots(runId: string): Promise<number> {
  const { changelogEntryId: entryId } = await prisma.screenshotRun.findUniqueOrThrow({ where: { id: runId }, select: { changelogEntryId: true } });
  if (!entryId) {
    return 0;
  }
  return prisma.$transaction(async (tx) => {
    const [entry] = await tx.$queryRaw<{ content: unknown; body: string }[]>`SELECT content, body FROM changelog_entry WHERE id = ${entryId} FOR UPDATE`;
    // Once, and only once it's ended (a second delivery of its job finds it running and leaves it to the first): claimed
    // under the entry's lock, so a line the team puts back later as it was isn't filled again.
    const { count } = await tx.screenshotRun.updateMany({ where: { id: runId, placedAt: null, state: { not: "RUNNING" } }, data: { placedAt: new Date() } });
    if (!entry || count === 0) {
      return 0;
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
    if (taken.length === 0) {
      return 0;
    }
    const doc = (entry.content as Doc | null) ?? fromPlainText(entry.body);
    const placed: string[] = [];
    const content = (doc.content ?? []).map((block): Block => {
      const asked = screenshotAsked(block);
      const at = asked === null ? -1 : taken.findIndex((shot) => shot.show === asked);
      if (at === -1) {
        return block;
      }
      const { show, description, id, w, h } = taken.splice(at, 1)[0]!;
      placed.push(id);
      // What it shows, or, where the agent didn't say, what it was asked to show: never an image with no alt text.
      return { type: "image", attrs: { mediaId: id, width: "100", align: "center", alt: (description || show).slice(0, MAX_ALT_LENGTH), w, h } };
    });
    if (placed.length === 0) {
      return 0;
    }
    // Its images are kept as the screenshots' are (storeImage attaches them).
    const text: Doc = { ...doc, content };
    await tx.changelogEntry.update({ where: { id: entryId }, data: { content: text, body: toPlainText(text) } });
    await tx.screenshotRun.update({ where: { id: runId }, data: { placed: placed.length } });
    return placed.length;
  }, { timeout: PLACING_MS });
}
