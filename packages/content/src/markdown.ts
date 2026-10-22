import type { JSONContent } from "@tiptap/core";

import { isSafeLink, isVideo, type Video, videoPageUrl } from "./links";
import { imageKey, imageWidths, type MediaUrls } from "./media";
import { isCellSpan, isMediaId, isPixelSize } from "./profiles";

/** `media`: where to load images from (by key); `flat`: one line (table cells), so hard breaks become spaces. */
type Context = { media?: MediaUrls; flat?: boolean };

/**
 * Markdown (CommonMark, with GFM tables) for AI tools and "Copy as Markdown".
 * Like the renderers, unknown nodes are skipped and unsafe links become text;
 * images need their URL in `mediaUrls` (they're left out without it). Text is escaped, so
 * it reads back as the same text, never as markup.
 */
export function toMarkdown(doc: JSONContent, { mediaUrls }: { mediaUrls?: MediaUrls | null } = {}): string {
  return blocks(doc, { media: mediaUrls ?? undefined });
}

const LISTS = new Set(["bulletList", "orderedList"]);

function blocks(node: JSONContent, ctx: Context, separator = "\n\n"): string {
  return (node.content ?? [])
    .map((child) => block(child, ctx))
    .filter(Boolean)
    .join(separator);
}

function block(node: JSONContent, ctx: Context): string {
  switch (node.type) {
    case "paragraph":
      return inline(node, ctx);
    case "heading": {
      const level = Number(node.attrs?.level);
      const text = inline(node, { ...ctx, flat: true });
      return text && `${"#".repeat(level >= 1 && level <= 6 ? level : 2)} ${text}`;
    }
    case "blockquote":
      return blocks(node, ctx).replace(/^/gm, "> ").replace(/^> $/gm, ">");
    case "horizontalRule":
      return "---";
    case "codeBlock": {
      const code = (node.content ?? []).map((t) => t.text ?? "").join("");
      const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      const language = node.attrs?.language;
      return `${fence}${typeof language === "string" && /^[\w#+.-]+$/.test(language) ? language : ""}\n${code}\n${fence}`;
    }
    case "bulletList":
    case "orderedList": {
      const start = Number(node.attrs?.start);
      const first = Number.isInteger(start) && start > 1 ? start : 1;
      return (node.content ?? [])
        .map((item, i) => {
          const marker = node.type === "bulletList" ? "- " : `${first + i}. `;
          // A nested list follows its item's text on the next line; other blocks after a blank line.
          const body = (item.content ?? [])
            .map((child) => ({ list: LISTS.has(child.type ?? ""), text: block(child, ctx) }))
            .filter((part) => part.text)
            .map((part, j) => (j === 0 ? "" : part.list ? "\n" : "\n\n") + part.text)
            .join("");
          return `${marker}${body.replace(/\n(?=.)/g, `\n${" ".repeat(marker.length)}`)}`.trimEnd();
        })
        .join("\n");
    }
    case "table": {
      // ponytail: GFM tables have no rowspan; a spanned cell shows once and the rows below shift left.
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).flatMap((cell) => {
          const text = blocks(cell, { ...ctx, flat: true }, " ")
            .replace(/\s*\n\s*/g, " ")
            .replace(/\|/g, "\\|");
          const span = isCellSpan(cell.attrs?.colspan) ? cell.attrs.colspan : 1;
          return [text, ...Array<string>(span - 1).fill("")];
        }),
      );
      if (rows.length === 0) {
        return "";
      }
      // GFM tables need a header row: the first row is it.
      const width = Math.max(...rows.map((row) => row.length));
      const line = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
      return [line(rows[0]!), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
    }
    case "image": {
      const { mediaId, alt, w } = node.attrs ?? {};
      const url = isMediaId(mediaId) && isPixelSize(w) && ctx.media?.[imageKey(mediaId, imageWidths(w).find((width) => width >= 960) ?? w)];
      return url ? `![${escape(typeof alt === "string" ? alt.replace(/\s+/g, " ") : "")}](${url})` : "";
    }
    case "video":
      return isVideo(node.attrs ?? {}) ? `[Video](${videoPageUrl(node.attrs as Video)})` : "";
    default:
      return "";
  }
}

type OpenMark = { type: string; href?: string };
// `*`, not `_`: CommonMark ignores `_` inside a word (snake*case* is italic, snake_case_ isn't).
const DELIMITERS: Record<string, string> = { bold: "**", italic: "*" };

/**
 * A text block's content. Marks that run across text nodes stay open (`**a *b***`,
 * not `**a*****b***`), and spaces at their edges move outside them, where
 * CommonMark needs them.
 */
function inline(node: JSONContent, ctx: Context): string {
  let out = "";
  const open: OpenMark[] = [];
  const close = (keep: number) => {
    const trailing = /\s*$/.exec(out)![0];
    out = out.slice(0, out.length - trailing.length);
    for (const mark of open.splice(keep).reverse()) {
      out += mark.type === "link" ? `](${linkTarget(mark.href!)})` : DELIMITERS[mark.type];
    }
    out += trailing;
  };

  for (const child of node.content ?? []) {
    if (child.type === "hardBreak") {
      close(0);
      out += ctx.flat ? " " : "\\\n";
      continue;
    }
    if (child.type !== "text" || !child.text) {
      continue;
    }
    const code = child.marks?.some((mark) => mark.type === "code");
    let text = code ? codeSpan(child.text) : escape(child.text);
    if (!code && child.text.trim() === "") {
      out += text;
      continue;
    }
    const marks: OpenMark[] = (child.marks ?? [])
      .filter((mark) => mark.type in DELIMITERS || (mark.type === "link" && isSafeLink(mark.attrs?.href)))
      .map((mark) => ({ type: mark.type, href: mark.attrs?.href }));
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep]!.type === marks[keep]!.type && open[keep]!.href === marks[keep]!.href) {
      keep++;
    }
    close(keep);
    if (marks.length > keep) {
      const leading = /^\s*/.exec(text)![0];
      out += leading;
      text = text.slice(leading.length);
      for (const mark of marks.slice(keep)) {
        out += mark.type === "link" ? "[" : DELIMITERS[mark.type];
        open.push(mark);
      }
    }
    out += text;
  }
  close(0);

  return (
    out
      .replace(/(\\\n)+$/, "")
      // What would start a heading, quote, list, divider or code fence at the start of a line.
      .replace(/^([ \t]*)([#>+\-=~])/gm, "$1\\$2")
      .replace(/^([ \t]*\d+)([.)])/gm, "$1\\$2")
  );
}

/** Characters that are markup anywhere in a line, and `&` where it would start an entity (`&copy;`). */
const escape = (text: string) => text.replace(/[\\`*_[\]<]|&(?=#?[a-z0-9]+;)/gi, "\\$&");

function codeSpan(text: string): string {
  const ticks = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** A link's URL with the characters that would end it early encoded. */
const linkTarget = (href: string) => href.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
