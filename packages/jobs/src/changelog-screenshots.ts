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
const MARKER = /^\[\s*screenshot\s*:\s*([\s\S]*?)\s*\]$/i;

/**
 * What a "[Screenshot: …]" line asks to show: a paragraph of its own in the entry's text with nothing else in it; null
 * for any other block (one inside a sentence or a list has no place an image could take, and is left to the team).
 */
export function screenshotAsked(block: Block): string | null {
  if (block.type !== "paragraph") {
    return null;
  }
  return MARKER.exec(toPlainText(block).trim())?.[1]?.slice(0, MAX_SHOW) || null;
}

/** The "[Screenshot: …]" lines a text asks for, in order (see screenshotAsked). */
export const screenshotsAsked = (doc: Doc) => (doc.content ?? []).map(screenshotAsked).filter((show): show is string => show !== null);

/**
 * Puts a finished run's screenshots in its changelog entry, each in place of a line that asked for exactly it (one for
 * one, in order): read and saved under the entry's lock, as publishing reads it, so a line the team changed or took out
 * meanwhile is left as they saved it, and a save waiting on the lock keeps what it writes. Returns how many were placed.
 */
export async function placeChangelogScreenshots(runId: string): Promise<number> {
  const run = await prisma.screenshotRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      projectId: true,
      changelogEntryId: true,
      screenshots: { orderBy: { position: "asc" }, select: { show: true, description: true, image: { select: { id: true, status: true, width: true, height: true } } } },
    },
  });
  const entryId = run.changelogEntryId;
  const taken = run.screenshots.flatMap(({ show, description, image }) =>
    image?.status === "READY" && image.width && image.height ? [{ show, description, id: image.id, w: image.width, h: image.height }] : [],
  );
  if (!entryId || taken.length === 0) {
    return 0;
  }
  return prisma.$transaction(async (tx) => {
    const [entry] = await tx.$queryRaw<{ content: unknown; body: string }[]>`SELECT content, body FROM changelog_entry WHERE id = ${entryId} FOR UPDATE`;
    if (!entry) {
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
      const { description, id, w, h } = taken.splice(at, 1)[0]!;
      placed.push(id);
      return { type: "image", attrs: { mediaId: id, width: "100", align: "center", alt: description.slice(0, MAX_ALT_LENGTH), w, h } };
    });
    if (placed.length === 0) {
      return 0;
    }
    const text: Doc = { ...doc, content };
    // In use now: the cleanup of unused uploads keeps them.
    await tx.media.updateMany({ where: { id: { in: placed }, projectId: run.projectId }, data: { attachedAt: new Date() } });
    await tx.changelogEntry.update({ where: { id: entryId }, data: { content: text, body: toPlainText(text) } });
    return placed.length;
  });
}
