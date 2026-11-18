import { isSafeLink } from "./links";
import { toMarkdown } from "./markdown";
import type { Doc } from "./document";

type JSONContent = NonNullable<Doc["content"]>[number];

/*
 * Text the AI writes, read back into documents (changelog drafts and edits, code changes' article
 * edits). The model's reply is untrusted: it only ever becomes plain text, headings, "- " and "1. " lists,
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

/** The markdown subset the prompt asks for: headings, "- " and numbered lists, paragraphs; anything else is text. */
function notesToDoc(notes: string, allowedLinks: Set<string>, media: JSONContent[]): Doc {
  const content: JSONContent[] = [];
  const unused = new Set(media);
  let paragraph: string[] = [];
  let list: JSONContent | null = null;
  // The open list's last number, whether every item so far had it ("1." on each), and whether a blank line came since.
  let last = 0;
  let same = true;
  let blank = false;
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
    const item = /^([-*•+]|\d+[.)])(?:\s+(.*))?$/.exec(line);
    const embed = media[Number(/^\{\{media (\d+)\}\}$/.exec(line)?.[1]) - 1];
    if (heading || item || embed || line === "") {
      flushParagraph();
    }
    if (line === "") {
      blank = true;
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
      const text = inline(item[2] ?? "", allowedLinks);
      if (text.length > 0) {
        // "1." steps are numbered, from the first one's number. A list of the other kind starts a new one, and so does a
        // number that doesn't go on from the last: the next one goes on, and so does the same one on the very next line
        // while every item had it ("1." on every step); any other (two numbered lists one after the other) starts again.
        const start = /^\d/.test(item[1]!) ? Number.parseInt(item[1]!, 10) : null;
        const type = start === null ? "bulletList" : "orderedList";
        const open = list as JSONContent | null;
        const continues: boolean = open?.type === type && (start === null || start === last + 1 || (start === last && same && !blank));
        const current: JSONContent = continues ? open! : { type, ...(start !== null && start !== 1 && { attrs: { start } }), content: [] };
        if (!continues) {
          content.push(current);
          list = current;
        }
        current.content!.push({ type: "listItem", content: [{ type: "paragraph", content: text }] });
        same = continues ? same && start === last : true;
        last = start ?? 0;
        blank = false;
      } else if ((list as JSONContent | null)?.type === "orderedList" && item[1] && Number.parseInt(item[1], 10) === last + 1) {
        // An empty step, dropped, still counts: the next one goes on from it.
        last += 1;
      }
    } else if (line !== "") {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return { type: "doc", content };
}

/** Text with **bold** and [links](url) (and *italics*, with `italic`); a link is kept only to an allowed, safe URL. */
function inline(text: string, allowedLinks: Set<string>, italic = false): JSONContent[] {
  const nodes: JSONContent[] = [];
  const push = (value: string, marks?: JSONContent["marks"]) => {
    // Stray markers (an unclosed ** or `code`) are dropped rather than shown; Markdown escapes are undone.
    const clean = value.replace(/\*\*|`/g, "").replace(/\\([!-/:-@[-`{-~])/g, "$1");
    if (clean !== "") {
      nodes.push(marks ? { type: "text", text: clean, marks } : { type: "text", text: clean });
    }
  };
  // Each part has a length limit, so a reply of nothing but "[" or "**" is read in linear time.
  // (An address as long as a link may be: isSafeLink's 2,048.)
  // An italic's stars hug its words ("2 * 3 * 4" is text), and an escaped star (\\*) is no marker.
  const pattern = italic
    ? /\[([^\]]{1,1000})\]\(([^)\s]{1,2048})\)|\*\*([^*]{1,2000})\*\*|(?<![\\*])\*(?![\s*])([^*]{1,2000}?)(?<![\s\\])\*(?!\*)/g
    : /\[([^\]]{1,1000})\]\(([^)\s]{1,2048})\)|\*\*([^*]{1,2000})\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const href = match[2]!;
      push(match[1], allowedLinks.has(href) && isSafeLink(href) ? [{ type: "link", attrs: { href } }] : undefined);
    } else if (match[3] !== undefined) {
      push(match[3], [{ type: "bold" }]);
    } else {
      push(match[4]!, [{ type: "italic" }]);
    }
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return nodes;
}

/** Blocks that hold text only, wherever they sit (a list's item, a table's cell, a step): what a passage can be, with code blocks. */
const TEXT_BLOCKS = new Set(["paragraph", "heading", "detailsSummary", "stepTitle"]);
const PASSAGE_MARKS = new Set(["bold", "italic", "link", "code"]);
const LISTS = new Set(["bulletList", "orderedList"]);
const isCode = (node: JSONContent) => (node.marks ?? []).some((mark) => mark.type === "code");
/** A line break in a passage, so a passage and its replacement are one line each. Text's own "<" is escaped (\<): this is only ever a break. */
const BREAK = "<br>";
/** BREAK where it isn't escaped (after an even number of backslashes). */
const BREAKS = /(?<=(?:^|[^\\])(?:\\\\)*)<br>/;
/** A text block's content as Markdown, without what its block adds (a heading's #, an item's marker), its line breaks as BREAK. */
const passageText = (content: JSONContent[]) =>
  toMarkdown({ type: "doc", content: [{ type: "paragraph", content }] })
    .trim()
    .replaceAll("\\\n", BREAK);
/** A code block as the model is shown it and quotes it: fenced, with its language (its file name is no part of it). */
const fenced = (node: JSONContent) => toMarkdown({ type: "doc", content: [{ type: "codeBlock", attrs: { language: node.attrs?.language ?? null }, content: node.content }] });

/** A text block's content as its characters with their marks (spaces aside: Markdown moves those out of bold), line breaks included. */
const marked = (content: JSONContent[]) =>
  content.flatMap((node) => (node.type === "hardBreak" ? [BREAK] : [...(node.text ?? "")].map((char) => (char.trim() ? char + JSON.stringify(node.marks ?? []) : char)))).join("\u0000");

/** The passage's own link marks by address: a stored link carries more than its address (target, rel), and a replacement keeps them. */
const ownLinks = (content: JSONContent[]) =>
  new Map(content.flatMap((node) => (node.marks ?? []).filter((mark) => mark.type === "link" && typeof mark.attrs?.href === "string").map((mark) => [mark.attrs!.href as string, mark] as const)));

/** The addresses these blocks link to: all a replacement or an added paragraph may link to. */
const linksOf = (blocks: JSONContent[]) => new Set([...factsIn(blocks).keys()].filter((fact) => fact.startsWith("link ")).map((fact) => fact.slice("link ".length)));

/**
 * The passages in these blocks: each text block whose text can be replaced by itself (replacePassage), as the Markdown
 * the model is shown and quotes back, and each code block (fenced). Only text in bold, italics, links and `code`, and
 * line breaks (as <br>). And only a block that comes back as it is when replaced with its own text, so every passage
 * listed can be replaced: one the reply's reader (inline) can't read back isn't listed (text in two marks at once, as it
 * keeps one mark per run of text; a link whose address or text Markdown has to escape; a backtick outside code; a line
 * break at its end).
 * ponytail: those can't be changed in place; teach the reader nesting and escapes if they're missed.
 */
export function passagesIn(blocks: JSONContent[]): { text: string; node: JSONContent }[] {
  const found: { text: string; node: JSONContent }[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "codeBlock") {
      const content = node.content ?? [];
      if (content.every((child) => child.type === "text" && !child.marks?.length) && content.some((child) => child.text?.trim())) {
        found.push({ text: fenced(node), node });
      }
      return;
    }
    if (!TEXT_BLOCKS.has(node.type ?? "")) {
      node.content?.forEach(visit);
      return;
    }
    const content = node.content ?? [];
    const text = content.every((child) => child.type === "hardBreak" || (child.type === "text" && (child.marks ?? []).every((mark) => PASSAGE_MARKS.has(mark.type))))
      ? passageText(content)
      : "";
    const back = text && rewritten(node, text);
    if (back && marked(back.content!) === marked(content)) {
      found.push({ text, node });
    }
  };
  blocks.forEach(visit);
  return found;
}

/** `node` with `target` (that very object, anywhere under it) as `next`; everything else the same objects. */
function swap(node: JSONContent, target: JSONContent, next: JSONContent): JSONContent {
  if (node === target) {
    return next;
  }
  const content = node.content?.map((child) => swap(child, target, next));
  return content?.some((child, i) => child !== node.content![i]) ? { ...node, content } : node;
}

/** What notesToDoc reads as a block's start: a heading, a quote, a list's item. Escaped ("1\. Use…"), it's text. */
const BLOCK_MARKER = /^(#{1,6}(\s|$)|>|([-*•+]|\d+[.)])(\s|$)|([-*_])\5{2,}$)/;

/** How many links to each address these text nodes hold (nodes side by side with one address are one link). */
function linkRuns(content: JSONContent[]): Map<string, number> {
  const runs = new Map<string, number>();
  let last: unknown;
  for (const node of content) {
    const href: unknown = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    if (typeof href === "string" && href !== last) {
      runs.set(href, (runs.get(href) ?? 0) + 1);
    }
    last = href;
  }
  return runs;
}

/**
 * The code span `text` starts with (its backticks, then the same number closing it; a space inside both ends taken off,
 * as Markdown does) and how long it is, or null: not closed, empty, or more than one line.
 */
function codeSpanAt(text: string): { code: string; length: number } | null {
  const ticks = /^`+/.exec(text)![0];
  const close = new RegExp(`(?<!\`)${ticks}(?!\`)`, "g");
  close.lastIndex = ticks.length;
  const end = close.exec(text);
  let code = end ? text.slice(ticks.length, end.index) : "";
  if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) {
    code = code.slice(1, -1);
  }
  return end && code.trim() && !/[\n\r]/.test(code) ? { code, length: end.index + ticks.length } : null;
}

/** A text block with `replace` as its content (see replacePassage), or null when it can't be used. */
function rewritten(target: JSONContent, replace: string): JSONContent | null {
  let rest = replace.trim();
  // One line, and no block of its own: a marker at its start (notesToDoc's) would be stored as text ("2. 1. Open…").
  // Nor an image's placeholder: the image stays where it is, and the placeholder would be stored as text.
  if (rest === "" || /[\n\r]/.test(rest) || BLOCK_MARKER.test(rest) || /\{\{media \d+\}\}/.test(rest.replace(/\\(.)/g, "$1"))) {
    return null;
  }
  const links = linksOf([target]);
  const content: JSONContent[] = [];
  // Text outside the passage's code can't hold a backtick: it would be code made up. Each <br> is a line break.
  const text = (value: string) => {
    value.split(BREAKS).forEach((part, i) => {
      if (i > 0) {
        content.push({ type: "hardBreak" });
      }
      content.push(...inline(part, links, true));
    });
    return !value.includes("`");
  };
  // As many code spans as the passage had, in its order: what's in one may change (a renamed flag), its marks stay.
  for (const code of (target.content ?? []).filter(isCode)) {
    const at = rest.indexOf("`");
    const span = at === -1 ? null : codeSpanAt(rest.slice(at));
    if (!span || !text(rest.slice(0, at))) {
      return null;
    }
    content.push(span.code === code.text ? code : { ...code, text: span.code });
    rest = rest.slice(at + span.length);
  }
  // Each link the passage had, as often as it had it: one of two to the same address made plain text is a link lost.
  if (!text(rest) || content.every((node) => node.type === "hardBreak")) {
    return null;
  }
  // A link the passage had comes back as the mark it was, every attribute: the reader makes one with the address alone.
  const own = ownLinks(target.content ?? []);
  const kept = content.map((node) => (node.marks?.some((mark) => mark.type === "link") ? { ...node, marks: node.marks.map((mark) => (mark.type === "link" && own.get(mark.attrs?.href as string)) || mark) } : node));
  const next = { ...target, content: kept };
  const has = linkRuns(content);
  return [...linkRuns(target.content ?? [])].every(([href, count]) => (has.get(href) ?? 0) >= count) ? next : null;
}

/**
 * A code block with `replace` as its code: a fenced block (its own language on the fence is ignored: the block keeps its
 * language and file name). Null when it isn't one, or its code is blank.
 */
function rewrittenCode(target: JSONContent, replace: string): JSONContent | null {
  const block = /^(`{3,})[^\n`]*\n([\s\S]*)\n\1[ \t]*$/.exec(replace.replace(/\r\n?/g, "\n").trim());
  return block?.[2]?.trim() ? { ...target, content: [{ type: "text", text: block[2] }] } : null;
}

/**
 * What taking a passage out, or adding after it, acts on: its block, when that's one of these blocks (a paragraph, a
 * heading, a code block), or the item of one of these lists that holds only it. Null for anything else (a table's cell,
 * a step's title, a nested list's item): those have no place to add to or take from without changing what's around them.
 */
function unitOf(blocks: JSONContent[], node: JSONContent): { list: JSONContent | null; unit: JSONContent } | null {
  if (blocks.includes(node)) {
    return { list: null, unit: node };
  }
  const list = blocks.find((block) => LISTS.has(block.type ?? "") && block.content?.some((item) => item.content?.length === 1 && item.content[0] === node));
  return list ? { list, unit: list.content!.find((item) => item.content![0] === node)! } : null;
}

/** One passage of these blocks, found by its exact text (see passagesIn), or null: found no time, or more than once. */
function passageAt(blocks: JSONContent[], find: string) {
  const matches = passagesIn(blocks).filter((passage) => passage.text === find.trim());
  return matches.length === 1 ? matches[0]!.node : null;
}

/**
 * These blocks with one passage's text replaced: the block whose text is exactly `find` (see passagesIn) gets
 * `replace` as its content, and keeps its type and attributes; every other node is the object it was. An empty `replace`
 * takes the passage out: a paragraph, heading or code block of these blocks, or a list's item (its list too, when it was
 * the last). (A section's heading goes only with the rest of its section: articleNotes.) Null when it can't be used, never a guess: `find` isn't the text of exactly one passage; `replace` is more than
 * one line (a line break is <br>) or starts like a block of its own (a heading's #, a list's marker); it loses a link
 * the passage had (one of two to the same address counts); or it hasn't the passage's code spans, as many and in order
 * (their code may change; none is made up); a code block's isn't a fenced block; or what's taken out isn't one of these
 * blocks or a list's item (a table's cell, a step's title). The rest is read like any reply (inline):
 * text, **bold**, *italics* and the links the passage had.
 */
export function replacePassage(blocks: JSONContent[], find: string, replace: string): JSONContent[] | null {
  const node = passageAt(blocks, find);
  if (!node) {
    return null;
  }
  if (replace.trim() === "") {
    const at = unitOf(blocks, node);
    if (!at?.list) {
      return at && blocks.filter((block) => block !== at.unit);
    }
    const items = at.list.content!.filter((item) => item !== at.unit);
    return items.length > 0 ? blocks.map((block) => (block === at.list ? { ...at.list, content: items } : block)) : blocks.filter((block) => block !== at.list);
  }
  const next = node.type === "codeBlock" ? rewrittenCode(node, replace) : rewritten(node, replace);
  return next && blocks.map((block) => swap(block, node, next));
}

/**
 * These blocks with `insert` added after one passage (found as replacePassage finds it): read like any reply (readNotes:
 * paragraphs, lists, bold, the links these blocks have), after the passage's block when it's one of these, or as more
 * items of its list after a list's item. Null when it can't be used: the passage isn't found exactly once or has no
 * place (see unitOf); `insert` reads as nothing, has a heading (it would start a section), an image's placeholder, or
 * after a list's item is anything but one list.
 */
export function insertAfterPassage(blocks: JSONContent[], after: string, insert: string): JSONContent[] | null {
  const node = passageAt(blocks, after);
  const at = node && unitOf(blocks, node);
  if (!at || /\{\{media \d+\}\}/.test(insert.replace(/\\(.)/g, "$1"))) {
    return null;
  }
  const added = readNotes(JSON.stringify({ notes: insert }), linksOf(blocks))?.doc.content ?? [];
  if (added.length === 0 || added.some((block) => block.type === "heading")) {
    return null;
  }
  const place = (list: JSONContent[], items: JSONContent[]) => list.flatMap((one) => (one === at.unit ? [one, ...items] : [one]));
  if (!at.list) {
    return place(blocks, added);
  }
  const [items] = added;
  return added.length === 1 && LISTS.has(items!.type ?? "") ? blocks.map((block) => (block === at.list ? { ...at.list, content: place(at.list.content!, items!.content!) } : block)) : null;
}
