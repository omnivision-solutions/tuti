import { type Doc, fromPlainText, mediaIdsIn, parseDoc, type Profile, toPlainText, updateImages } from "@tuti/content";
import { prisma } from "@tuti/db";

/**
 * Rich content from a form: the editor's `content` (JSON, checked against the
 * profile) or, without it, plain `body` text (forms without JavaScript, API clients).
 * Images must be finished uploads from the same project; their sizes come from the
 * upload, not the form. Returns the document to store, its plain text (for `body`)
 * and the uploads it uses (pass them to `attachMedia` once it's saved).
 */
export async function contentFromForm(
  formData: FormData,
  profile: Profile,
  { projectId, maxLength }: { projectId: string; maxLength: number },
): Promise<{ doc: Doc; text: string; mediaIds: string[]; error?: never } | { error: string }> {
  const raw = formData.get("content");
  let doc: Doc;
  if (typeof raw === "string" && raw !== "") {
    const parsed = parseDoc(profile, raw);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    doc = parsed.doc;
  } else {
    doc = fromPlainText(String(formData.get("body") ?? ""));
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
      return { error: "An image is still uploading or can't be used here. Wait for it, or remove it." };
    }
    const sizes = new Map(media.map((m) => [m.id, { w: m.width, h: m.height }]));
    updateImages(doc, (id) => sizes.get(id)!);
  }
  return { doc, text, mediaIds };
}

/** Marks uploads as used by saved content, so the cleanup of unused uploads keeps them. */
export async function attachMedia(mediaIds: string[]) {
  if (mediaIds.length > 0) {
    await prisma.media.updateMany({ where: { id: { in: mediaIds }, attachedAt: null }, data: { attachedAt: new Date() } });
  }
}

/** What to render: the stored document, or one made from the plain text of rows from before rich text. */
export function displayDoc(row: { content: unknown; body: string }): Doc {
  return (row.content as Doc | null) ?? fromPlainText(row.body);
}
