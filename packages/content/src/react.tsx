import type { JSONContent } from "@tiptap/core";
import { Fragment, type ReactNode } from "react";

import { docHeadings } from "./document";
import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";
import { imageKey, imageWidths, type MediaUrls } from "./media";
import { isCellSpan, isMediaId, isPixelSize } from "./profiles";

/** Widest the text column gets (Tailwind max-w-3xl), for picking image sizes. */
const COLUMN_WIDTH = 768;

/**
 * Renders stored content as React elements, never through HTML strings, so text
 * can't become markup. Anything unknown is skipped; unsafe links render as text.
 * Content is validated when it's saved too (parseDoc); this is the second line.
 */
export function RichText({
  doc,
  className,
  mediaUrls,
  headingIds = false,
}: {
  doc: JSONContent;
  className?: string;
  /** Where to load uploaded images from (by storage key); images without one are left out. */
  mediaUrls?: MediaUrls | null;
  /** Articles: top-level headings get ids from their text (docHeadings), so they can be linked. */
  headingIds?: boolean;
}) {
  const media = mediaUrls ?? undefined;
  if (!headingIds) {
    return <div className={className}>{children(doc, media)}</div>;
  }
  const ids = docHeadings(doc).map((heading) => heading.id);
  let next = 0;
  const content = (doc.content ?? []).map((child, i) => renderNode(child, i, media, child.type === "heading" ? ids[next++] : undefined));
  return <div className={className}>{content}</div>;
}

function children(node: JSONContent, media: MediaUrls | undefined): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, i, media));
}

function renderNode(node: JSONContent, key: number, media: MediaUrls | undefined, id?: string): ReactNode {
  const inner = () => children(node, media);
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case "paragraph":
      return <p key={key}>{inner()}</p>;
    case "hardBreak":
      return <br key={key} />;
    case "bulletList":
      return <ul key={key}>{inner()}</ul>;
    case "orderedList": {
      const start = Number(node.attrs?.start);
      return (
        <ol key={key} start={Number.isInteger(start) && start > 1 ? start : undefined}>
          {inner()}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{inner()}</li>;
    case "heading":
      // Under the page's own title: level 3 when asked for, otherwise 2.
      return node.attrs?.level === 3 ? (
        <h3 key={key} id={id}>
          {inner()}
        </h3>
      ) : (
        <h2 key={key} id={id}>
          {inner()}
        </h2>
      );
    case "blockquote":
      return <blockquote key={key}>{inner()}</blockquote>;
    case "horizontalRule":
      return <hr key={key} />;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{inner()}</code>
        </pre>
      );
    case "table":
      // Wide tables scroll sideways inside the column instead of stretching the page.
      return (
        <div key={key} className="rich-table">
          <table>
            <tbody>{inner()}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{inner()}</tr>;
    case "tableHeader":
    case "tableCell": {
      const Cell = node.type === "tableHeader" ? "th" : "td";
      const { colspan, rowspan } = node.attrs ?? {};
      return (
        <Cell
          key={key}
          colSpan={isCellSpan(colspan) && colspan > 1 ? colspan : undefined}
          rowSpan={isCellSpan(rowspan) && rowspan > 1 ? rowspan : undefined}
        >
          {inner()}
        </Cell>
      );
    }
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
    case "image": {
      const { mediaId, width, align, alt, w, h } = node.attrs ?? {};
      if (!isMediaId(mediaId) || !isPixelSize(w) || !isPixelSize(h)) {
        return null;
      }
      const url = (size: number) => media?.[imageKey(mediaId, size)];
      const widths = imageWidths(w).filter(url);
      const src = url(widths.find((size) => size >= 960) ?? w);
      if (!src) {
        return null;
      }
      const share = Number(width) || 100;
      return (
        <figure key={key} className="rich-image" data-width={String(width)} data-align={String(align)}>
          <img
            src={src}
            srcSet={widths.map((size) => `${url(size)} ${size}w`).join(", ")}
            sizes={`(max-width: ${COLUMN_WIDTH}px) 100vw, ${Math.round((COLUMN_WIDTH * share) / 100)}px`}
            width={w}
            height={h}
            alt={typeof alt === "string" ? alt : ""}
            loading="lazy"
            decoding="async"
          />
        </figure>
      );
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
