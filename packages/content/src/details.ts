// The editor parts (parseHTML) read DOM elements; servers importing this need the DOM types too.
/// <reference lib="dom" />

import { Node } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    details: { setDetails: () => ReturnType };
  }
}

/**
 * Collapsible details (articles): a summary line that opens to show its body, rendered as `<details>`/`<summary>`.
 * The body takes blocks but no headings (so "On this page" and an article's sections stay top-level) and no details
 * in details. The editor shows it open.
 */
const DETAILS_BODY = "(paragraph | bulletList | orderedList | blockquote | codeBlock | codeTabs | horizontalRule | image | video | table)+";

/** The details node holding the cursor (in its summary or body), with its depth. */
function detailsAt($pos: ResolvedPos): { node: PMNode; depth: number } | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "details") {
      return { node: $pos.node(depth), depth };
    }
  }
  return null;
}

export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsContent",
  // The cursor can sit before and after it (gap cursor), and Backspace and Delete don't merge it into its neighbours.
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: "details" }, { tag: "div[data-details]" }];
  },
  renderHTML() {
    return ["div", { "data-details": "", class: "rich-details" }, 0];
  },
  addCommands() {
    return {
      setDetails:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name, content: [{ type: "detailsSummary" }, { type: "detailsContent", content: [{ type: "paragraph" }] }] })
            // The insert leaves the cursor at its end (the body): move it to the summary.
            .command(({ tr }) => {
              const found = detailsAt(tr.selection.$from);
              if (found) {
                tr.setSelection(TextSelection.create(tr.doc, tr.selection.$from.before(found.depth) + 2));
              }
              return !!found;
            })
            .run(),
    };
  },
});

export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "summary" }, { tag: "div[data-details-summary]" }];
  },
  renderHTML() {
    return ["div", { "data-details-summary": "", "data-placeholder": "Summary", class: "rich-details-summary" }, 0];
  },
  addKeyboardShortcuts() {
    const inSummary = () => {
      const { selection } = this.editor.state;
      return selection.empty && selection.$from.parent.type.name === this.name ? selection.$from : null;
    };
    return {
      // Enter goes on to the body.
      Enter: () => {
        const $from = inSummary();
        const at = $from?.after();
        return at !== undefined && this.editor.commands.command(({ tr }) => !!tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))));
      },
      // Backspace in an empty summary takes the details away, keeping its body.
      Backspace: () => {
        const $from = inSummary();
        if (!$from || $from.parent.content.size > 0) {
          return false;
        }
        const details = $from.node(-1);
        const start = $from.before(-1);
        return this.editor
          .chain()
          .command(({ tr }) => {
            tr.replaceWith(start, start + details.nodeSize, details.lastChild!.content);
            tr.setSelection(TextSelection.near(tr.doc.resolve(start + 1)));
            return true;
          })
          .run();
      },
    };
  },
});

export const DetailsContent = Node.create({
  name: "detailsContent",
  content: DETAILS_BODY,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-details-content]" }, { tag: "details > div.rich-details-body" }];
  },
  renderHTML() {
    return ["div", { "data-details-content": "", class: "rich-details-body" }, 0];
  },
  addKeyboardShortcuts() {
    return {
      // Enter on an empty last line of the body leaves the details, as it leaves a list.
      Enter: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        const body = $from.node(-1);
        if (
          !selection.empty ||
          $from.parent.type.name !== "paragraph" ||
          $from.parent.content.size > 0 ||
          body?.type.name !== this.name ||
          body.childCount < 2 ||
          $from.index(-1) !== body.childCount - 1
        ) {
          return false;
        }
        const after = $from.after(-2);
        return this.editor
          .chain()
          .command(({ tr }) => {
            tr.delete($from.before(), $from.after());
            const at = tr.mapping.map(after);
            tr.insert(at, this.editor.schema.nodes.paragraph!.create());
            tr.setSelection(TextSelection.create(tr.doc, at + 1));
            return true;
          })
          .run();
      },
    };
  },
});
