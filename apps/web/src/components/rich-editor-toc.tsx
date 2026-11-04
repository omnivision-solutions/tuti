"use client";

import type { JSONContent } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { docHeadings, TableOfContents } from "@tuti/content";
import { TableOfContents as TableOfContentsList } from "@tuti/content/react";

/** The table of contents block in the editor: the headings as they're typed, as text (they get their ids once published). */
function TableOfContentsView({ editor }: NodeViewProps) {
  const headings = useEditorState({
    editor,
    selector: ({ editor }) => {
      const tops: JSONContent[] = [];
      editor.state.doc.forEach((node) => node.type.name === "heading" && tops.push(node.toJSON() as JSONContent));
      return JSON.stringify(docHeadings({ content: tops }));
    },
  });
  const list = JSON.parse(headings) as ReturnType<typeof docHeadings>;
  return (
    <NodeViewWrapper>
      {list.some((heading) => heading.text.trim()) ? (
        <TableOfContentsList headings={list} links={false} />
      ) : (
        <div className="rich-toc text-muted-foreground">Table of contents: the headings you add show here.</div>
      )}
    </NodeViewWrapper>
  );
}

export const EditorTableOfContents = TableOfContents.extend({
  addNodeView: () => ReactNodeViewRenderer(TableOfContentsView),
});
