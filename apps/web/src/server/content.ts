import { type Doc, fromPlainText, parseDoc, type Profile, toPlainText } from "@tuti/content";

/**
 * Rich content from a form: the editor's `content` (JSON, checked against the
 * profile) or, without it, plain `body` text (forms without JavaScript, API clients).
 * Returns the document to store and its plain text (for `body`).
 */
export function contentFromForm(
  formData: FormData,
  profile: Profile,
  maxLength: number,
): { doc: Doc; text: string; error?: never } | { error: string } {
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
  return { doc, text };
}

/** What to render: the stored document, or one made from the plain text of rows from before rich text. */
export function displayDoc(row: { content: unknown; body: string }): Doc {
  return (row.content as Doc | null) ?? fromPlainText(row.body);
}
