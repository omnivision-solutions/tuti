import type { JSONContent } from "@tiptap/core";
import { Fragment, type ReactNode } from "react";

import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";

/**
 * Renders stored content as React elements, never through HTML strings, so text
 * can't become markup. Anything unknown is skipped; unsafe links render as text.
 * Content is validated when it's saved too (parseDoc); this is the second line.
 */
export function RichText({ doc, className }: { doc: JSONContent; className?: string }) {
  return <div className={className}>{children(doc)}</div>;
}

function children(node: JSONContent): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, i));
}

function renderNode(node: JSONContent, key: number): ReactNode {
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case "paragraph":
      return <p key={key}>{children(node)}</p>;
    case "hardBreak":
      return <br key={key} />;
    case "bulletList":
      return <ul key={key}>{children(node)}</ul>;
    case "orderedList": {
      const start = Number(node.attrs?.start);
      return (
        <ol key={key} start={Number.isInteger(start) && start > 1 ? start : undefined}>
          {children(node)}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{children(node)}</li>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children(node)}</code>
        </pre>
      );
    case "video": {
      const video = node.attrs ?? {};
      return isVideo(video) ? (
        <div key={key} className="rich-video">
          <iframe
            src={videoEmbedUrl(video)}
            sandbox={VIDEO_SANDBOX}
            allow="fullscreen; picture-in-picture"
            allowFullScreen
            loading="lazy"
            title="Video"
          />
        </div>
      ) : null;
    }
    default:
      return null;
  }
}

function renderText(node: JSONContent, key: number): ReactNode {
  let element: ReactNode = node.text ?? "";
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        element = <strong>{element}</strong>;
        break;
      case "italic":
        element = <em>{element}</em>;
        break;
      case "code":
        element = <code>{element}</code>;
        break;
      case "link":
        if (isSafeLink(mark.attrs?.href)) {
          element = (
            <a href={mark.attrs.href} rel={LINK_REL} target="_blank">
              {element}
            </a>
          );
        }
        break;
    }
  }
  return <Fragment key={key}>{element}</Fragment>;
}
