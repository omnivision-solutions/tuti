import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

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

/** The part of the text this schema can show (unknown nodes, marks and attributes left out), or nothing if even that doesn't fit. */
export function readablePart(schema: Schema, doc: JSONContent): JSONContent | null {
  const keep = (node: JSONContent): JSONContent | null => {
    const type = schema.nodes[node.type ?? ""];
    if (!type) {
      return null;
    }
    const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([name]) => name in (type.spec.attrs ?? {})));
    const marks = (node.marks ?? []).filter((mark) => schema.marks[mark.type ?? ""]);
    return {
      ...node,
      ...(node.attrs && { attrs }),
      ...(node.marks && { marks }),
      ...(node.content && { content: node.content.map(keep).filter((child): child is JSONContent => child !== null) }),
    };
  };
  const part = keep(doc);
  try {
    schema.nodeFromJSON(part).check();
    return part;
  } catch {
    return null;
  }
}
