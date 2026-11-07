import { once } from "node:events";

import { type FormatCallback, convert as htmlToText } from "html-to-text";
import { MailParser, type ParsedMail } from "mailparser";

/** How much of an email's HTML is read, how deep, and how many levels deep quotes and lists are marked. */
export const MAX_HTML = 500_000;
export const MAX_DEPTH = 200;
export const MARKED_LEVELS = 5;

/** Options for the parser: it turns no HTML into text (htmlAsText does) but says where it would have, in textConversionError. */
export const PARSER_OPTIONS = { maxHtmlLengthToParse: 0, skipTextToHtml: true, skipImageLinks: true };

/**
 * An email's HTML as text: links kept, images left out, quotes as "> ". Only so much of it and so deep (the reply is
 * at the top). Quotes, lists, links and headings take the library's own form five levels deep, and not again below
 * that, as each level goes over all it holds once more (marks, indents, or works on each word): the text grows with
 * the HTML rather than with how deep it nests.
 */
export function htmlAsText(html: string): string {
  const heading = nested("heading", "block");
  return htmlToText(html.slice(0, MAX_HTML), {
    wordwrap: false,
    limits: { maxDepth: MAX_DEPTH },
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "blockquote", format: "quote" },
      { selector: "ul", format: "unordered" },
      { selector: "ol", format: "ordered" },
      { selector: "a", format: "link" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, format: "cappedHeading" })),
    ],
    formatters: {
      quote: nested("blockquote", "block"),
      unordered: nested("unorderedList", "flatList"),
      ordered: nested("orderedList", "flatList"),
      link: nested("anchor", "inline"),
      cappedHeading: heading,
      flatList,
    },
  });
}

/** The library's own formatter, `format`, five levels deep; `deeper` below that. */
function nested(format: string, deeper: string): FormatCallback {
  let depth = 0;
  return (elem, walk, builder, options) => {
    depth++;
    try {
      builder.options.formatters![depth <= MARKED_LEVELS ? format : deeper]!(elem, walk, builder, options);
    } finally {
      depth--;
    }
  };
}

/** A list's items one under the other, neither marked nor indented. */
const flatList: FormatCallback = (elem, walk, builder) => {
  builder.openBlock({ leadingLineBreaks: 1 });
  for (const child of elem.children ?? []) {
    builder.openBlock({ leadingLineBreaks: 1 });
    walk(child.name === "li" ? child.children : [child], builder);
    builder.closeBlock({ trailingLineBreaks: 1 });
  }
  builder.closeBlock({ trailingLineBreaks: 1 });
};

/**
 * An email's words: its text, or for an email in HTML alone, its HTML as text. An HTML part that comes beside the text
 * (a list's footer, say) rather than as another version of it is read in its place among the parts, as text. `mail`
 * is parsed with PARSER_OPTIONS.
 */
export async function emailText(raw: Buffer, mail: ParsedMail): Promise<string> {
  if (!mail.text?.trim()) {
    return typeof mail.html === "string" ? htmlAsText(mail.html) : "";
  }
  return mail.textConversionError ? partsText(raw) : mail.text;
}

type Part = { contentType?: string; textContent?: string; children?: Part[] };

/**
 * The email's parts in order, as the parser joins them into its text, but with the HTML beside the text as text (up to
 * MAX_HTML of it in all). Which parts those are only the parser's tree of the parts says (not part of its typed API:
 * the inbound database tests of such emails fail if a release changes it), so the email is read again for it.
 */
async function partsText(raw: Buffer): Promise<string> {
  const parser = new MailParser(PARSER_OPTIONS);
  parser.end(raw);
  for await (const data of parser) {
    if (data.type === "attachment") {
      data.content.resume();
      await once(data.content, "end");
      data.release();
    }
  }
  const texts: string[] = [];
  let html = MAX_HTML;
  const walk = (part: Part, alternative: boolean) => {
    if (part.textContent && (part.contentType === "text/plain" || part.contentType === "message/delivery-status")) {
      texts.push(part.textContent);
    } else if (part.textContent && part.contentType === "text/html" && !alternative && html > 0) {
      texts.push(trimLineBreaks(htmlAsText(part.textContent.slice(0, html))));
      html -= part.textContent.length;
    }
    for (const child of part.children ?? []) {
      walk(child, alternative || part.contentType === "multipart/alternative");
    }
  };
  walk((parser as unknown as { tree?: Part }).tree ?? {}, false);
  return texts.join("\n");
}

function trimLineBreaks(text: string) {
  let start = 0;
  let end = text.length;
  while (text[start] === "\n") start++;
  while (end > start && text[end - 1] === "\n") end--;
  return text.slice(start, end);
}
