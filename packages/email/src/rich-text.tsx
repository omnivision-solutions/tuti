import { Button } from "@react-email/components";
import { type Doc, isMediaId, isSafeLink, isVideo } from "@tuti/content";
import { emailImageKey, EMAIL_IMAGE_WIDTH } from "@tuti/content/media";
import { Fragment, type ReactNode } from "react";

import { colors } from "./layout";

type Node = NonNullable<Doc["content"]>[number];
type Context = { media?: string; linkUrl: string; tight?: boolean };

/** Width of the text inside Layout's card (480 container − 2×24 padding − 2×24 card padding). */
const CONTENT_WIDTH = 384;

const text = { fontSize: 15, lineHeight: "24px", color: colors.text } as const;
const mono = { fontFamily: "SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13 } as const;

/**
 * Stored content (the same JSON as the page's RichText) as email-safe React: inline
 * styles only, no iframes or scripts, text never as HTML strings. Unknown nodes are
 * skipped and unsafe links render as text. Images use the email JPEG from the image
 * job (left out without `mediaBaseUrl`); videos become a link to `linkUrl`, the page
 * where they play (e.g. the changelog entry).
 */
export function EmailRichText({ doc, mediaBaseUrl, linkUrl }: { doc: Doc; mediaBaseUrl?: string | null; linkUrl: string }) {
  return <>{children(doc, { media: mediaBaseUrl ?? undefined, linkUrl })}</>;
}

function children(node: Node, ctx: Context): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, i, ctx));
}

function renderNode(node: Node, key: number, ctx: Context): ReactNode {
  const inner = (next: Context = ctx) => children(node, next);
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case "paragraph":
      return (
        <p key={key} style={{ ...text, margin: ctx.tight ? 0 : "0 0 16px" }}>
          {inner()}
        </p>
      );
    case "hardBreak":
      return <br key={key} />;
    case "bulletList":
      return (
        <ul key={key} style={{ ...text, margin: "0 0 16px", paddingLeft: 24 }}>
          {inner()}
        </ul>
      );
    case "orderedList": {
      const start = Number(node.attrs?.start);
      return (
        <ol key={key} start={Number.isInteger(start) && start > 1 ? start : undefined} style={{ ...text, margin: "0 0 16px", paddingLeft: 24 }}>
          {inner()}
        </ol>
      );
    }
    case "listItem":
      return (
        <li key={key} style={{ margin: "0 0 4px" }}>
          {inner({ ...ctx, tight: true })}
        </li>
      );
    case "heading": {
      const h3 = node.attrs?.level === 3;
      const style = { color: colors.text, fontWeight: 700, margin: "24px 0 8px", fontSize: h3 ? 16 : 19, lineHeight: h3 ? "24px" : "28px" };
      return h3 ? (
        <h3 key={key} style={style}>
          {inner()}
        </h3>
      ) : (
        <h2 key={key} style={style}>
          {inner()}
        </h2>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} style={{ margin: "0 0 16px", padding: "0 0 0 16px", borderLeft: `3px solid ${colors.border}` }}>
          {inner()}
        </blockquote>
      );
    case "horizontalRule":
      return <hr key={key} style={{ border: "none", borderTop: `1px solid ${colors.border}`, margin: "24px 0" }} />;
    case "codeBlock":
      return (
        <pre
          key={key}
          style={{ ...mono, lineHeight: "20px", color: colors.text, backgroundColor: colors.page, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12, margin: "0 0 16px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          <code>{inner()}</code>
        </pre>
      );
    case "video":
      // Mail clients don't play embeds: link to the page where it plays.
      return isVideo(node.attrs ?? {}) ? (
        <p key={key} style={{ margin: "0 0 16px" }}>
          <Button
            href={ctx.linkUrl}
            style={{ color: colors.green, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "10px 16px", fontSize: 15, fontWeight: 600 }}
          >
            Watch the video
          </Button>
        </p>
      ) : null;
    case "image": {
      const { mediaId, width, align, alt, w, h } = node.attrs ?? {};
      if (!ctx.media || !isMediaId(mediaId) || !Number.isInteger(w) || !Number.isInteger(h) || w <= 0) {
        return null;
      }
      // The email JPEG is at most EMAIL_IMAGE_WIDTH wide; show it at the image's share of the column.
      const shown = Math.min(w, EMAIL_IMAGE_WIDTH, Math.round((CONTENT_WIDTH * (Number(width) || 100)) / 100));
      return (
        <div key={key} style={{ margin: "0 0 16px", textAlign: align === "left" || align === "right" ? align : "center" }}>
          <img
            src={`${ctx.media}/${emailImageKey(mediaId)}`}
            alt={typeof alt === "string" ? alt : ""}
            width={shown}
            height={Math.round((h * shown) / w)}
            style={{ border: 0, maxWidth: "100%", height: "auto" }}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

function renderText(node: Node, key: number): ReactNode {
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
        element = <code style={{ ...mono, backgroundColor: colors.page, borderRadius: 4, padding: "1px 4px" }}>{element}</code>;
        break;
      case "link":
        if (isSafeLink(mark.attrs?.href)) {
          element = (
            <a href={mark.attrs.href} style={{ color: colors.green, textDecoration: "underline" }}>
              {element}
            </a>
          );
        }
        break;
    }
  }
  return <Fragment key={key}>{element}</Fragment>;
}
