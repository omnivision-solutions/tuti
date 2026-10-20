export type AnswerBlock = { type: "paragraph"; text: string } | { type: "list"; ordered: boolean; items: string[] };

/**
 * An AI answer as paragraphs and lists, to render as text (never as markup): blank lines
 * separate paragraphs, "- " or "1. " lines are list items. Markdown markers the model adds
 * anyway (**, `, # headings) are dropped.
 */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\*\*|`/g, "").replace(/^#+\s*/, "");
    const item = /^(?:([-*•])|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = !item[1];
      const last = blocks.at(-1);
      if (last?.type === "list" && last.ordered === ordered) {
        last.items.push(item[2]!);
      } else {
        blocks.push({ type: "list", ordered, items: [item[2]!] });
      }
    } else if (line === "") {
      flush();
      // A blank line ends a list too.
      blocks.push({ type: "paragraph", text: "" });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks.filter((block) => block.type === "list" || block.text !== "");
}
