import type { JSONContent } from "@tiptap/core";
import type { Mark, Node as PMNode, NodeType, Schema } from "@tiptap/pm/model";

/**
 * Whether an editor with this schema can hold the text as it's stored: every node, mark and attribute is one it knows,
 * in places it allows. Text saved by a newer release (while a deploy runs both) may not be: an editor that opened it
 * anyway would drop what it doesn't know, and a save from it would replace the text without it.
 */
export function readableBy(schema: Schema, doc: JSONContent): boolean {
  const known = (node: JSONContent): boolean => {
    const type = schema.nodes[node.type ?? ""];
    return (
      !!type &&
      Object.keys(node.attrs ?? {}).every((name) => name in (type.spec.attrs ?? {})) &&
      (node.marks ?? []).every((mark) => {
        const markType = schema.marks[mark.type ?? ""];
        return !!markType && Object.keys(mark.attrs ?? {}).every((name) => name in (markType.spec.attrs ?? {}));
      }) &&
      (node.content ?? []).every(known)
    );
  };
  if (!known(doc)) {
    return false;
  }
  try {
    schema.nodeFromJSON(doc).check();
    return true;
  } catch {
    return false;
  }
}

/**
 * The part of the text this schema can show: unknown nodes, marks and attributes left out, and what that empties (a
 * collapsible block or a quote with only an unknown block in it) filled as the schema needs, or left out if nothing fits.
 * Null only if not even an empty document of it fits.
 */
export function readablePart(schema: Schema, doc: JSONContent): JSONContent | null {
  const known = (attrs: Record<string, unknown> | undefined, spec: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(attrs ?? {}).filter(([name]) => name in (spec ?? {})));
  // The marks it knows that its parent allows, added one by one so ones that exclude each other don't both stay.
  const marksOf = (node: JSONContent, parent: NodeType | null) =>
    (node.marks ?? []).reduce<readonly Mark[]>((set, mark) => {
      const type = schema.marks[mark.type ?? ""];
      return type && (!parent || parent.allowsMarkType(type)) ? type.create(known(mark.attrs, type.spec.attrs)).addToSet(set) : set;
    }, []);
  const build = (node: JSONContent, parent: NodeType | null): PMNode | null => {
    if (node.type === "text") {
      return node.text ? schema.text(node.text, marksOf(node, parent)) : null;
    }
    const type = schema.nodes[node.type ?? ""];
    if (!type) {
      return null;
    }
    // The children that fit where they are (a known block somewhere new is left out, not its whole parent).
    const children: PMNode[] = [];
    let match = type.contentMatch;
    for (const child of node.content ?? []) {
      const built = build(child, type);
      const next = built && match.matchType(built.type);
      if (built && next) {
        children.push(built);
        match = next;
      }
    }
    try {
      return type.createAndFill(known(node.attrs, type.spec.attrs), children, marksOf(node, parent));
    } catch {
      return null;
    }
  };
  const part = build(doc, null);
  try {
    part?.check();
    return part ? (part.toJSON() as JSONContent) : null;
  } catch {
    return null;
  }
}
