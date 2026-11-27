import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markerSpans } from "@tuti/content";

export const FILL_INS = new PluginKey<DecorationSet>("fillIns");

/**
 * What a draft left for the team to fill in ("[Check: …]", "[Screenshot: …]"), highlighted where it is: the same
 * markers publishing refuses (markersIn), so each one in the way is easy to find. Decorations: never saved.
 */
export function fillInsPlugin() {
  // ponytail: redrawn from the whole text on each change; fine at an entry's or article's length.
  const draw = (doc: Node) => {
    const marks: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) {
        return true;
      }
      // Its text, each character's position beside it: anything else inline (a line break, an image) ends a line.
      let text = "";
      const at: number[] = [];
      node.forEach((child, offset) => {
        const start = pos + 1 + offset;
        const piece = child.isText ? child.text! : "\n";
        for (let i = 0; i < piece.length; i++) {
          at.push(start + i);
        }
        text += piece;
      });
      let line = 0;
      for (const each of text.split("\n")) {
        for (const [from, to] of markerSpans(each)) {
          marks.push(Decoration.inline(at[line + from]!, at[line + to - 1]! + 1, { class: "rounded-sm bg-highlight text-highlight-foreground", "data-fill-in": "" }));
        }
        line += each.length + 1;
      }
      return false;
    });
    return DecorationSet.create(doc, marks);
  };
  return new Plugin<DecorationSet>({
    key: FILL_INS,
    state: { init: (_, state) => draw(state.doc), apply: (tr, old) => (tr.docChanged ? draw(tr.doc) : old) },
    props: { decorations: (state) => FILL_INS.getState(state) },
  });
}
