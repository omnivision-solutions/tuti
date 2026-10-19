import type { JSONContent } from "@tiptap/core";

import { isSafeLink, isVideo, videoPageUrl } from "./links";
import { IMAGE_ALIGNMENTS, IMAGE_SIZES, isCellSpan, isMediaId, MAX_ALT_LENGTH, type Profile, schemaFor } from "./profiles";

/** Rich content as stored: ProseMirror JSON (never HTML). */
export type Doc = JSONContent & { type: "doc" };

/** Big enough for a long article, small enough that nobody stores megabytes of JSON. */
export const MAX_DOC_JSON_LENGTH = 200_000;

export type ParseResult = { ok: true; doc: Doc } | { ok: false; error: string };

/**
 * Checks content against a profile before it's stored: only the profile's nodes
 * and marks, in valid places, safe links and allowed videos. Returns it normalised
 * (unknown attributes dropped, links reduced to their href), which is what to store.
 */
export function parseDoc(profile: Profile, input: unknown): ParseResult {
  let value = input;
  if (typeof value === "string") {
    if (value.length > MAX_DOC_JSON_LENGTH) {
      return { ok: false, error: "This is too long." };
    }
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "This content couldn't be read." };
    }
  } else if (JSON.stringify(value ?? null).length > MAX_DOC_JSON_LENGTH) {
    return { ok: false, error: "This is too long." };
  }
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "doc") {
    return { ok: false, error: "This content couldn't be read." };
  }

  let doc: Doc;
  try {
    const node = schemaFor(profile).nodeFromJSON(value);
    node.check();
    doc = node.toJSON() as Doc;
  } catch {
    return { ok: false, error: "This content has something that isn't allowed here." };
  }

  let error: string | undefined;
  visit(doc, (node) => {
    if (node.type === "video" && !isVideo(node.attrs ?? {})) {
      error = "Only YouTube, Vimeo and Loom videos can be embedded.";
    }
    if (node.type === "image" && !isImageAttrs(node.attrs ?? {})) {
      error = "This image can't be used here.";
    }
    if (node.type === "tableCell" || node.type === "tableHeader") {
      const { colspan, rowspan } = node.attrs ?? {};
      if (!isCellSpan(colspan) || !isCellSpan(rowspan)) {
        error = "This table can't be used here.";
      }
      // Column widths aren't shown anywhere.
      node.attrs = { colspan, rowspan, colwidth: null };
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") {
        if (!isSafeLink(mark.attrs?.href)) {
          error = "Links must start with http://, https:// or mailto:.";
        }
        mark.attrs = { href: mark.attrs?.href };
      }
    }
  });
  return error ? { ok: false, error } : { ok: true, doc };
}

function isImageAttrs(attrs: Record<string, unknown>): boolean {
  return (
    isMediaId(attrs.mediaId) &&
    (IMAGE_SIZES as readonly unknown[]).includes(attrs.width) &&
    (IMAGE_ALIGNMENTS as readonly unknown[]).includes(attrs.align) &&
    typeof attrs.alt === "string" &&
    attrs.alt.length <= MAX_ALT_LENGTH
  );
}

/** Ids of the uploaded images in a document, for checking and attaching them. */
export function mediaIdsIn(doc: JSONContent): string[] {
  const ids = new Set<string>();
  visit(doc, (node) => {
    if (node.type === "image" && isMediaId(node.attrs?.mediaId)) {
      ids.add(node.attrs.mediaId);
    }
  });
  return [...ids];
}

/** Sets attributes of every image node, e.g. its real size from the upload. */
export function updateImages(doc: JSONContent, attrs: (mediaId: string) => Record<string, unknown>): void {
  visit(doc, (node) => {
    if (node.type === "image" && isMediaId(node.attrs?.mediaId)) {
      node.attrs = { ...node.attrs, ...attrs(node.attrs.mediaId) };
    }
  });
}

function visit(node: JSONContent, fn: (node: JSONContent) => void) {
  fn(node);
  for (const child of node.content ?? []) {
    visit(child, fn);
  }
}

const TEXTBLOCKS = new Set(["paragraph", "codeBlock", "heading"]);

/** Plain text for search, embeddings, previews and email subjects. Blocks end up on their own lines. */
export function toPlainText(node: JSONContent): string {
  const text = (function walk(n: JSONContent): string {
    switch (n.type) {
      case "text":
        return n.text ?? "";
      case "hardBreak":
        return "\n";
      case "image":
        return typeof n.attrs?.alt === "string" ? n.attrs.alt : "";
      case "video":
        return isVideo(n.attrs ?? {}) ? videoPageUrl(n.attrs as Parameters<typeof videoPageUrl>[0]) : "";
      default:
        return (n.content ?? []).map(walk).join(TEXTBLOCKS.has(n.type ?? "") ? "" : "\n");
    }
  })(node);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** About 400 tokens: long enough to hold an answer, short enough to match one question well. */
export const MAX_CHUNK_LENGTH = 1500;

export type Chunk = { heading: string; text: string };

/**
 * A document in sections for search and AI answers: each heading starts one,
 * holding the text up to the next heading. Sections longer than MAX_CHUNK_LENGTH
 * are split between blocks (a block longer than that on its own is cut). Always
 * at least one chunk, so an article with only a title can still be found.
 */
export function toChunks(doc: JSONContent): Chunk[] {
  const sections: { heading: string; blocks: string[] }[] = [{ heading: "", blocks: [] }];
  for (const node of doc.content ?? []) {
    const text = toPlainText(node);
    if (node.type === "heading") {
      sections.push({ heading: text, blocks: [] });
    } else if (text) {
      for (let i = 0; i < text.length; i += MAX_CHUNK_LENGTH) {
        sections.at(-1)!.blocks.push(text.slice(i, i + MAX_CHUNK_LENGTH));
      }
    }
  }
  const chunks: Chunk[] = [];
  for (const { heading, blocks } of sections) {
    let text = "";
    for (const block of blocks) {
      if (text && text.length + 2 + block.length > MAX_CHUNK_LENGTH) {
        chunks.push({ heading, text });
        text = "";
      }
      text = text ? `${text}\n\n${block}` : block;
    }
    if (text || heading) {
      chunks.push({ heading, text });
    }
  }
  return chunks.length ? chunks : [{ heading: "", text: "" }];
}

/** Whether there's nothing in it (no text, images or videos), e.g. an untouched editor. */
export function isEmptyDoc(doc: JSONContent): boolean {
  let embeds = false;
  visit(doc, (node) => {
    embeds ||= node.type === "image" || node.type === "video";
  });
  return !embeds && toPlainText(doc) === "";
}

/** Plain text as a document: blank lines start paragraphs, single newlines become line breaks. */
export function fromPlainText(text: string): Doc {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "");
  return {
    type: "doc",
    content: paragraphs.length
      ? paragraphs.map((p) => ({
          type: "paragraph",
          content: p
            .split("\n")
            .flatMap((line, i) => [
              ...(i > 0 ? [{ type: "hardBreak" }] : []),
              ...(line ? [{ type: "text", text: line }] : []),
            ]),
        }))
      : [{ type: "paragraph" }],
  };
}
