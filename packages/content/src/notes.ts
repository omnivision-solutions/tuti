import { isSafeLink } from "./links";
import { toMarkdown } from "./markdown";
import type { Doc } from "./document";

type JSONContent = NonNullable<Doc["content"]>[number];

/*
 * Text the AI writes, read back into documents (changelog drafts and edits, code changes' article
 * edits). The model's reply is untrusted: it only ever becomes plain text, headings, "- " lists,
 * bold, and links Tuti allows; images and videos go to the model as {{media N}} lines and come back
 * as the original nodes, so nothing else can add them.
 */

/** Blocks as Markdown for the model; each image or video becomes a {{media N}} line, its node pushed to `media`. */
export function blocksToNotes(blocks: JSONContent[], media: JSONContent[]): string {
  return blocks
    .map((block) => {
      if (block.type === "image" || block.type === "video") {
        media.push(block);
        return `{{media ${media.length}}}`;
      }
      return toMarkdown({ type: "doc", content: [block] });
    })
    .filter(Boolean)
    .join("\n\n");
}

/** The links, images and videos in these blocks: what an edit must keep. Keyed by what they point to. */
export function factsIn(blocks: JSONContent[]): Map<string, string> {
  const facts = new Map<string, string>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === "link" && typeof mark.attrs?.href === "string") {
        facts.set(`link ${mark.attrs.href}`, `the link to ${mark.attrs.href}`);
      }
    }
    if (node.type === "image") {
      facts.set(`image ${String(node.attrs?.mediaId)}`, "an image");
    } else if (node.type === "video") {
      facts.set(`video ${String(node.attrs?.provider)} ${String(node.attrs?.id)}`, "a video");
    }
    node.content?.forEach(visit);
  };
  blocks.forEach(visit);
  return facts;
}

/** What `before` has that `after` lost (see factsIn), described. */
export function droppedFacts(before: JSONContent[], after: JSONContent[]): string[] {
  const kept = factsIn(after);
  return [...factsIn(before)].filter(([key]) => !kept.has(key)).map(([, description]) => description);
}

/**
 * The model's reply (JSON with `notes`, and maybe a `title`) as a title and a document, or null if it
 * can't be read. Links survive only to `allowedLinks`; other links keep their text.
 */
export function readNotes(
  reply: string,
  allowedLinks: Set<string>,
  /** The nodes {{media N}} lines stand for (see blocksToNotes); each comes back at most once. */
  media: JSONContent[] = [],
): { title: string | null; doc: Doc } | null {
  // Models sometimes wrap JSON in a code fence or a sentence: take the outermost object.
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const { title, notes } = (parsed ?? {}) as { title?: unknown; notes?: unknown };
  if (typeof notes !== "string") {
    return null;
  }
  const doc = notesToDoc(notes, allowedLinks, media);
  if (doc.content!.length === 0) {
    return null;
  }
  const cleanTitle = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return { title: cleanTitle.length >= 3 && cleanTitle.length <= 120 ? cleanTitle : null, doc };
}

/** The markdown subset the prompt asks for: headings, "- " lists, paragraphs; anything else is text. */
function notesToDoc(notes: string, allowedLinks: Set<string>, media: JSONContent[]): Doc {
  const content: JSONContent[] = [];
  const unused = new Set(media);
  let paragraph: string[] = [];
  let list: JSONContent | null = null;
  const flushParagraph = () => {
    const text = inline(paragraph.join(" "), allowedLinks);
    if (text.length > 0) {
      content.push({ type: "paragraph", content: text });
    }
    paragraph = [];
  };

  for (const raw of notes.replace(/\r\n?/g, "\n").split("\n")) {
    // A divider (---) only separates, like a blank line; a quote's ">" and a line break's "\" go.
    const line = raw
      .trim()
      .replace(/^([-*_])\1{2,}$/, "")
      .replace(/^>\s*/, "")
      .replace(/\\$/, "");
    const heading = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
    const item = /^(?:[-*•+]|\d+[.)])(?:\s+(.*))?$/.exec(line);
    const embed = media[Number(/^\{\{media (\d+)\}\}$/.exec(line)?.[1]) - 1];
    if (heading || item || embed || line === "") {
      flushParagraph();
    }
    if (!item && line !== "") {
      list = null;
    }
    if (embed) {
      if (unused.delete(embed)) {
        content.push(embed);
      }
    } else if (heading) {
      const text = inline((heading[2] ?? "").replace(/#+$/, "").trim(), allowedLinks);
      if (text.length > 0) {
        content.push({ type: "heading", attrs: { level: heading[1]!.length <= 2 ? 2 : 3 }, content: text });
      }
    } else if (item) {
      const text = inline(item[1] ?? "", allowedLinks);
      if (text.length > 0) {
        if (!list) {
          list = { type: "bulletList", content: [] };
          content.push(list);
        }
        list.content!.push({ type: "listItem", content: [{ type: "paragraph", content: text }] });
      }
    } else if (line !== "") {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return { type: "doc", content };
}

/** Text with **bold** and [links](url); a link is kept only to an allowed, safe URL. */
function inline(text: string, allowedLinks: Set<string>): JSONContent[] {
  const nodes: JSONContent[] = [];
  const push = (value: string, marks?: JSONContent["marks"]) => {
    // Stray markers (an unclosed ** or `code`) are dropped rather than shown; Markdown escapes are undone.
    const clean = value.replace(/\*\*|`/g, "").replace(/\\([!-/:-@[-`{-~])/g, "$1");
    if (clean !== "") {
      nodes.push(marks ? { type: "text", text: clean, marks } : { type: "text", text: clean });
    }
  };
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const href = match[2]!;
      push(match[1], allowedLinks.has(href) && isSafeLink(href) ? [{ type: "link", attrs: { href } }] : undefined);
    } else {
      push(match[3]!, [{ type: "bold" }]);
    }
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return nodes;
}
