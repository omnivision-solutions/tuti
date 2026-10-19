import { type Doc, fromPlainText, mediaIdsIn, parseDoc, type Profile, toPlainText, updateImages } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";

type ContentResult = { doc: Doc; text: string; mediaIds: string[]; error?: never } | { error: string };

/** Rich content from a form's `content` (the editor's JSON) or `body` (plain text) fields; see `readContent`. */
export function contentFromForm(
  formData: FormData,
  profile: Profile,
  options: { projectId: string; maxLength: number },
): Promise<ContentResult> {
  const body = formData.get("body");
  return readContent(profile, { content: formData.get("content"), body: typeof body === "string" ? body : undefined }, options);
}

/**
 * Rich content to store: `content` (a document, or its JSON as forms send it,
 * checked against the profile) or, without it, plain `body` text (forms without
 * JavaScript, API clients). Images must be finished uploads from the same project;
 * their sizes come from the upload, not the request. Returns the document, its
 * plain text (for `body`) and the uploads it uses (pass them to `attachMedia` in the
 * transaction that saves it).
 */
export async function readContent(
  profile: Profile,
  { content: raw, body }: { content?: unknown; body?: string },
  { projectId, maxLength }: { projectId: string; maxLength: number },
): Promise<ContentResult> {
  let doc: Doc;
  if (raw !== undefined && raw !== null && raw !== "") {
    const parsed = parseDoc(profile, raw);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    doc = parsed.doc;
  } else {
    doc = fromPlainText(body ?? "");
  }
  const text = toPlainText(doc);
  if (text.length > maxLength) {
    return { error: `Keep it under ${maxLength.toLocaleString("en")} characters` };
  }

  const mediaIds = mediaIdsIn(doc);
  if (mediaIds.length > 0) {
    const media = await prisma.media.findMany({
      where: { id: { in: mediaIds }, projectId, status: "READY" },
      select: { id: true, width: true, height: true },
    });
    if (media.length !== mediaIds.length) {
      return { error: MEDIA_GONE };
    }
    const sizes = new Map(media.map((m) => [m.id, { w: m.width, h: m.height }]));
    updateImages(doc, (id) => sizes.get(id)!);
  }
  return { doc, text, mediaIds };
}

export const MEDIA_GONE = "An image is still uploading or can't be used here. Wait for it, or remove it.";

/**
 * Marks uploads as used by content being saved, inside the transaction that saves
 * it, so the cleanup of unused uploads keeps them. Throws (rolling the save back)
 * if any of them is gone: the cleanup may have claimed it since it was checked.
 */
export async function attachMedia(tx: Prisma.TransactionClient, projectId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) {
    return;
  }
  const { count } = await tx.media.updateMany({
    where: { id: { in: mediaIds }, projectId, status: "READY" },
    data: { attachedAt: new Date() },
  });
  if (count !== mediaIds.length) {
    throw new MediaGoneError(MEDIA_GONE);
  }
}

export class MediaGoneError extends Error {}

/** What to render: the stored document, or one made from the plain text of rows from before rich text. */
export function displayDoc(row: { content: unknown; body: string }): Doc {
  return (row.content as Doc | null) ?? fromPlainText(row.body);
}
