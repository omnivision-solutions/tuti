import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";

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
  const marksOf = (node: JSONContent) =>
    (node.marks ?? []).flatMap((mark) => {
      const type = schema.marks[mark.type ?? ""];
      return type ? [type.create(known(mark.attrs, type.spec.attrs))] : [];
    });
  const build = (node: JSONContent): PMNode | null => {
    if (node.type === "text") {
      return node.text ? schema.text(node.text, marksOf(node)) : null;
    }
    const type = schema.nodes[node.type ?? ""];
    if (!type) {
      return null;
    }
    const children = (node.content ?? []).map(build).filter((child): child is PMNode => child !== null);
    try {
      return type.createAndFill(known(node.attrs, type.spec.attrs), children, marksOf(node));
    } catch {
      return null;
    }
  };
  const part = build(doc);
  try {
    part?.check();
    return part ? (part.toJSON() as JSONContent) : null;
  } catch {
    return null;
  }
}
