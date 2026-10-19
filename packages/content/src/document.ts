import type { JSONContent } from "@tiptap/core";

import { isSafeLink, isVideo, videoPageUrl } from "./links";
import { type Profile, schemaFor } from "./profiles";

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
      case "video":
        return isVideo(n.attrs ?? {}) ? videoPageUrl(n.attrs as Parameters<typeof videoPageUrl>[0]) : "";
      default:
        return (n.content ?? []).map(walk).join(TEXTBLOCKS.has(n.type ?? "") ? "" : "\n");
    }
  })(node);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether there's nothing in it (no text and no embeds), e.g. an untouched editor. */
export function isEmptyDoc(doc: JSONContent): boolean {
  return toPlainText(doc) === "";
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
