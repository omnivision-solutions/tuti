import type { JSONContent } from "@tiptap/core";
import { Fragment, type ReactNode, useId } from "react";

import { docHeadings, type Heading, listStart, tocEntries } from "./document";
import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";
import { fileExtension, fileKey, fileSize, imageKey, imageWidths, type MediaUrls, videoKey } from "./media";
import { isCellSpan, isCodeFilename, isHostedVideo, isMediaId, isPixelSize } from "./profiles";

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
  link,
}: {
  doc: JSONContent;
  className?: string;
  /** Where to load uploaded images and files from (by storage key); those without one are left out. */
  mediaUrls?: MediaUrls | null;
  /** Articles: top-level headings get ids from their text (docHeadings), so they can be linked. */
  headingIds?: boolean;
  /** A safe link's own rendering (an article's link to another of the portal's articles); null for the usual new-tab link. */
  link?: LinkRenderer;
}) {
  const options: Options = { media: mediaUrls ?? undefined, link };
  const headings = docHeadings(doc);
  let next = 0;
  const content = (doc.content ?? []).map((child, i) =>
    child.type === "tableOfContents" ? (
      <TableOfContents key={i} headings={headings} links={headingIds} />
    ) : (
      renderNode(child, i, options, headingIds && child.type === "heading" ? headings[next++]?.id : undefined)
    ),
  );
  return <div className={className}>{content}</div>;
}

/**
 * A table of contents block: the headings, each h3 under its h2, as links to them when they have ids (`links`;
 * the editor's shows them as text). Nothing without headings, except as text: a diff shows it alone, without the
 * article's headings, and says what it is.
 */
export function TableOfContents({ headings, links = true }: { headings: Heading[]; links?: boolean }) {
  const entries = tocEntries(headings);
  if (entries.length === 0) {
    return links ? null : <p className="rich-toc">Table of contents</p>;
  }
  const item = (heading: Heading, nested?: ReactNode) => (
    <li key={heading.id}>
      {links ? <a href={`#${heading.id}`}>{heading.text}</a> : heading.text}
      {nested}
    </li>
  );
  return (
    <nav className="rich-toc" aria-label="In this article">
      <p>In this article</p>
      <ul>{entries.map((entry) => item(entry, entry.children.length > 0 && <ul>{entry.children.map((child) => item(child))}</ul>))}</ul>
    </nav>
  );
}

export type LinkRenderer = (href: string, text: ReactNode) => ReactNode | null;
type Options = { media?: MediaUrls; link?: LinkRenderer };

function children(node: JSONContent, options: Options): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, i, options));
}

function renderNode(node: JSONContent, key: number, options: Options, id?: string): ReactNode {
  const { media } = options;
  const inner = () => children(node, options);
  switch (node.type) {
    case "text":
      return renderText(node, key, options.link);
    case "paragraph":
      return <p key={key}>{inner()}</p>;
    case "hardBreak":
      return <br key={key} />;
    case "bulletList":
      return <ul key={key}>{inner()}</ul>;
    case "orderedList": {
      const start = listStart(node);
      return (
        <ol key={key} start={start > 1 ? start : undefined}>
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
    case "codeBlock": {
      const pre = (
        <pre key={key}>
          <code>{inner()}</code>
        </pre>
      );
      const filename = node.attrs?.filename;
      return isCodeFilename(filename) ? (
        <figure key={key} className="rich-code">
          <figcaption>{filename}</figcaption>
          {pre}
        </figure>
      ) : (
        pre
      );
    }
    case "codeTabs": {
      const tabs = (node.content ?? []).filter((tab) => tab.type === "codeBlock");
      // Remounted when its tabs change (a preview of another version), so the first tab is picked and one always is.
      return <CodeTabs key={`${key}-${JSON.stringify(tabs.map((tab) => tab.attrs?.filename ?? null))}`} tabs={tabs} />;
    }
    case "steps": {
      // A diff shows a step alone, keeping its number (`start`, never stored).
      const start = Number(node.attrs?.start);
      // role="list": Safari drops a list's semantics once its markers are hidden (the numbers are drawn in CSS).
      return (
        <ol key={key} className="rich-steps" role="list" style={Number.isInteger(start) && start > 1 ? { counterReset: `step ${start - 1}` } : undefined}>
          {inner()}
        </ol>
      );
    }
    case "step":
      return <li key={key}>{inner()}</li>;
    case "stepTitle":
      return (
        <p key={key} className="rich-step-title">
          {inner()}
        </p>
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
    // Native <details>: opens without JS, and the browser's find-in-page opens it to a match.
    case "details":
      return (
        // Open only where the app asks (diffs, `open` never stored): what changed inside must show.
        <details key={key} className="rich-details" open={node.attrs?.open === true || undefined}>
          {inner()}
        </details>
      );
    case "detailsSummary":
      return <summary key={key}>{inner()}</summary>;
    case "detailsContent":
      return (
        <div key={key} className="rich-details-body">
          {inner()}
        </div>
      );
    case "video": {
      const video = node.attrs ?? {};
      // An uploaded one plays from its signed URL, in the browser's own player; nothing loads until it's played.
      if (isHostedVideo(video)) {
        const src = media?.[videoKey(video.id)];
        return src ? (
          <div key={key} className="rich-video">
            <video src={src} controls preload="metadata" playsInline />
          </div>
        ) : null;
      }
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
    case "file": {
      // A download (the signed link saves it under its name): its type, name and size.
      const { mediaId, name, size } = node.attrs ?? {};
      const href = isMediaId(mediaId) ? media?.[fileKey(mediaId)] : undefined;
      if (!href || typeof name !== "string" || !name) {
        return null;
      }
      const type = fileExtension(name).toUpperCase() || "FILE";
      return (
        <a key={key} className="rich-file" href={href} download={name}>
          <span className="rich-file-type" aria-hidden>
            {type}
          </span>
          <span className="rich-file-name">{name}</span>
          {isPixelSize(size) && <span className="rich-file-size">{fileSize(size)}</span>}
        </a>
      );
    }
    default:
      return null;
  }
}

/**
 * Code tabs without client JS: a radio button per tab (arrow keys switch them), the CSS showing the code of the
 * one picked (`.rich-code-tabs`). Every tab's code is on the page.
 */
function CodeTabs({ tabs }: { tabs: JSONContent[] }) {
  const name = useId();
  return (
    <div className="rich-code-tabs">
      <div className="rich-code-tab-row">
        {tabs.map((tab, i) => (
          <label key={i}>
            <input type="radio" name={name} defaultChecked={i === 0} />
            {isCodeFilename(tab.attrs?.filename) ? tab.attrs.filename : `Tab ${i + 1}`}
          </label>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <pre key={i}>
          <code>{children(tab, {})}</code>
        </pre>
      ))}
    </div>
  );
}

function renderText(node: JSONContent, key: number, link?: LinkRenderer): ReactNode {
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
          element = link?.(mark.attrs.href, element) ?? (
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
