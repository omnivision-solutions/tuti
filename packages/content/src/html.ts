// Server only: happy-dom stands in for the browser's DOM (`@tuti/content/html`, never imported by client code).
/// <reference lib="dom" />

import { generateJSON } from "@tiptap/html/server";
import { Window } from "happy-dom";

import { type Doc, mediaIdsIn, parseDoc, toPlainText, updateImages } from "./document";
import { isSafeLink, parseVideoUrl } from "./links";
import { fileExtension, UPLOAD_FILE_TYPES } from "./media";
import { extensions, IMAGE_ALIGNMENTS, IMAGE_SIZES, isCodeFilename, MAX_ALT_LENGTH, MAX_CODE_TABS, newTabLabel, type Profile } from "./profiles";

/**
 * Another tool's HTML (Featurebase's: its articles' custom blocks are described in its "Content Components" docs) as
 * Tuti's content, for imports. The HTML is mapped onto the profile's own parse rules (the editor's), then checked
 * with `parseDoc` like anything saved:
 * - headings become h2 and h3 (an h1 an h2, everything below one level down); where the profile has none, bold lines
 * - callouts become quotes, accordions collapsible details, multi-language code code tabs (articles), columns their
 *   content in order; YouTube, Vimeo and Loom iframes video embeds, other iframes links
 * - images are copied with `media` and point at the copy; in articles, attached documents (Featurebase's file blocks,
 *   and links to its attachment host) become file attachments. One that can't be copied, or that the profile has no
 *   place for (images in comments, files outside articles, uploaded videos), is left out with its alt text kept, and
 *   listed in `leftOut` with its URL (an inbox import can take those as attachments)
 * - every link goes through `link` (another page's new address, or null to keep it) and is kept only if it's safe
 * - anything else (scripts, styles, attributes, Tuti's own data attributes) is dropped, its text kept
 */

export type LeftOutReason =
  /** The profile has no place for it. */
  | "unsupported"
  /** Not an image or file type Tuti takes, by its content. */
  | "type"
  /** Over the upload limit for its kind. */
  | "size"
  /** The project's media quota is full. */
  | "quota"
  /** Couldn't be fetched: a private address, an error, too slow. */
  | "unreachable";
export type LeftOut = { kind: "image" | "file" | "video"; url: string; reason: LeftOutReason };

/** What to copy: `key` is the same for the same file (its URL without a presigned URL's signature, which is new each time). */
export type MediaSource = { kind: "image" | "file"; url: string; key: string; name?: string };
/** The copy, READY: an image's size, a file's name (as kept) and size. */
export type ImportedMedia = { mediaId: string; width: number | null; height: number | null; filename: string | null; size: number };
export type MediaImporter = (source: MediaSource) => Promise<ImportedMedia | { leftOut: LeftOutReason }>;

export type HtmlOptions = {
  /** Copies an image or file into the project's media (packages/jobs import-media.ts: network I/O, never under the project lock). Without it, they're left out. */
  media?: MediaImporter;
  /** A link's new address, or null to keep it. */
  link?: (href: string) => string | null;
};

/** What to store: `doc` as `content`, `text` as `body`; `mediaIds` are the copies it uses. */
export type HtmlContent = { doc: Doc; text: string; mediaIds: string[]; leftOut: LeftOut[] };

const JUNK = "script, style, noscript, template, head, title, meta, link, base, svg, math, object, embed, canvas, audio, form, button, input, select, textarea";
/** Attributes read below; everything else (styles, ids, event handlers, Tuti's own `data-*`) goes. */
const KEPT = new Set(["href", "src", "alt", "colspan", "rowspan", "start", "data", "data-width", "data-align"]);
/** Featurebase's own storage: links there are its attachments. */
const ATTACHMENT_HOST = /(^|\.)featurebase-attachments\.com$/i;

/**
 * `html` as content of `profile`, its media copied. Images and files are copied one at a time, in order.
 * An error when the result isn't valid content for the profile (too long, say); what it copied is released
 * by the daily cleanup. With `media`, it does network I/O (mediaImporter's): call it before the import's transaction,
 * never inside one holding the project lock.
 */
export async function htmlToContent(profile: Profile, html: string, { media, link }: HtmlOptions = {}): Promise<HtmlContent | { error: string }> {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
    },
  });
  try {
    const document = window.document as unknown as Document;
    const body = document.body;
    body.innerHTML = html;
    const all = (selector: string) => [...body.querySelectorAll<HTMLElement>(selector)];
    const make = (tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]) => {
      const element = document.createElement(tag);
      Object.entries(attrs).forEach(([name, value]) => element.setAttribute(name, value));
      element.append(...children);
      return element;
    };
    /** `element` as a `tag` with the same content. */
    const rename = (element: Element, tag: string) => {
      const renamed = make(tag);
      renamed.append(...element.childNodes);
      element.replaceWith(renamed);
      return renamed;
    };
    const boldLine = (element: Element) => element.replaceWith(make("p", {}, make("strong", {}, ...element.childNodes)));
    const article = profile === "article";
    const rich = profile === "article" || profile === "changelog";
    const leftOut: LeftOut[] = [];

    all(JUNK).forEach((element) => element.remove());
    for (const element of all("*")) {
      for (const { name } of [...element.attributes]) {
        const keep =
          KEPT.has(name) || name.startsWith("data-featurebase-") || (name === "data-type" && element.tagName === "DIV") || (name === "class" && element.tagName === "CODE");
        if (!keep) {
          element.removeAttribute(name);
        }
      }
    }

    // Multi-language code: tabs labelled by name (articles, 2 to MAX_CODE_TABS of them), else one block after another.
    for (const element of all("multicode-component")) {
      let tabs: { name?: unknown; value?: unknown; language?: unknown }[] = [];
      try {
        const parsed: unknown = JSON.parse(element.getAttribute("data") ?? "[]");
        tabs = Array.isArray(parsed) ? parsed.filter((tab) => tab && typeof tab === "object") : [];
      } catch {}
      const grouped = article && tabs.length >= 2 && tabs.length <= MAX_CODE_TABS;
      const labels: string[] = [];
      const blocks = tabs.map((tab) => {
        const name = typeof tab.name === "string" ? tab.name.trim() : "";
        const label = isCodeFilename(name) ? name : grouped ? newTabLabel(labels) : "";
        labels.push(label);
        const language: Record<string, string> = typeof tab.language === "string" && /^[\w+#-]{1,30}$/.test(tab.language) ? { class: `language-${tab.language}` } : {};
        return make("pre", article && label ? { "data-filename": label } : {}, make("code", language, String(tab.value ?? "")));
      });
      element.replaceWith(...(grouped ? [make("div", { "data-code-tabs": "" }, ...blocks)] : blocks));
    }

    all("callout-component").forEach((element) => rename(element, "blockquote"));
    all("td, th").forEach((cell) => {
      for (const name of ["colspan", "rowspan"]) {
        const span = Number(cell.getAttribute(name));
        if (cell.hasAttribute(name)) {
          cell.setAttribute(name, String(Number.isInteger(span) ? Math.min(Math.max(span, 1), 20) : 1));
        }
      }
    });

    // Headings: h2 and h3. With an h1, every level moves down one, so the outline keeps its shape.
    const shift = body.querySelector("h1") ? 1 : 0;
    for (const heading of all("h1, h2, h3, h4, h5, h6")) {
      if (!rich || heading.closest("details, li")) {
        boldLine(heading);
      } else {
        rename(heading, `h${Math.min(Number(heading.tagName[1]) + shift, 3)}`);
      }
    }

    // Accordions: a summary and a body (articles), without accordions inside; elsewhere, the summary in bold then the body.
    for (const details of all("details")) {
      const summary = [...details.children].find((child) => child.tagName === "SUMMARY");
      if (!article || details.parentElement?.closest("details") || !summary?.textContent?.trim()) {
        if (summary) {
          boldLine(summary);
        }
        rename(details, "div");
        continue;
      }
      const content = make("div", { "data-details-content": "" }, ...[...details.childNodes].filter((child) => child !== summary));
      details.append(content);
    }

    for (const iframe of all("iframe")) {
      const src = iframe.getAttribute("src") ?? "";
      const video = profile !== "comment" ? parseVideoUrl(src) : null;
      if (video) {
        iframe.replaceWith(make("div", { "data-video": "", "data-provider": video.provider, "data-id": video.id }));
      } else if (isSafeLink(src)) {
        iframe.replaceWith(make("p", {}, make("a", { href: src }, src)));
      } else {
        iframe.remove();
      }
    }
    for (const video of all("video")) {
      const src = video.getAttribute("src") ?? video.querySelector("source")?.getAttribute("src") ?? "";
      leftOut.push({ kind: "video", url: src, reason: "unsupported" });
      video.remove();
    }

    for (const anchor of all("a[href]")) {
      const href = anchor.getAttribute("href")!;
      if (article && isAttachment(href)) {
        // The file after what the link held, unless that's only the file's name: an image (a thumbnail) or words of
        // their own stay.
        const words = anchor.textContent?.trim() ?? "";
        const name = fileName(href);
        const own = anchor.querySelector("img, file-preview-component") || (words && words !== name && words !== name.replace(/\.\w+$/, ""));
        anchor.replaceWith(...(own ? anchor.childNodes : []), make("file-preview-component", { src: href }));
        continue;
      }
      // Any other link into Featurebase's storage is presigned for an hour: listed as left out (an importer may bring
      // it in another way, as an attachment), its words kept.
      if (inAttachmentStorage(href)) {
        // An image or file linking to itself (its full size, say): copied or listed below, once.
        const inner = anchor.querySelector("img, file-preview-component")?.getAttribute("src");
        if (inner && sameFile(inner) === sameFile(href)) {
          anchor.replaceWith(...anchor.childNodes);
          continue;
        }
        leftOut.push({ kind: /\.(png|jpe?g|gif|webp)$/i.test(new URL(href).pathname) ? "image" : "file", url: href, reason: "unsupported" });
        anchor.replaceWith(...anchor.childNodes);
        continue;
      }
      const target = link?.(href) ?? href;
      if (isSafeLink(target)) {
        anchor.setAttribute("href", target);
      } else {
        anchor.removeAttribute("href");
      }
    }

    // Media, one at a time: the same file (its key) is copied once (the importer keeps them).
    const sizes = new Map<string, ImportedMedia>();
    for (const element of all("img, file-preview-component")) {
      const url = element.getAttribute("src") ?? "";
      const key = sameFile(url);
      const type = element.getAttribute("data-featurebase-content-filetype");
      const kind = element.tagName === "IMG" || type?.startsWith("image/") ? "image" : "file";
      const name = kind === "file" ? (element.getAttribute("data-featurebase-content-filename") ?? fileName(url)) : undefined;
      const alt = (element.getAttribute("alt") ?? "").trim().slice(0, MAX_ALT_LENGTH);
      const leaveOut = (reason: LeftOutReason) => {
        leftOut.push({ kind, url, reason });
        // Its words on a line of their own, where it was.
        const words = kind === "image" ? alt : (name ?? "");
        element.replaceWith(...(words ? [make("p", {}, words)] : []));
      };
      if (kind === "image" ? profile === "comment" : !article) {
        leaveOut("unsupported");
        continue;
      }
      const copy = media ? await media({ kind, url, key, ...(name !== undefined && { name }) }) : { leftOut: "unsupported" as const };
      if ("leftOut" in copy) {
        leaveOut(copy.leftOut);
        continue;
      }
      sizes.set(copy.mediaId, copy);
      if (kind === "image") {
        const width = Number.parseFloat(element.getAttribute("data-width") ?? "100");
        const nearest = IMAGE_SIZES.reduce((best, size) => (Math.abs(Number(size) - width) < Math.abs(Number(best) - width) ? size : best));
        const align = element.getAttribute("data-align");
        element.replaceWith(
          make(
            "figure",
            {
              "data-image": "",
              "data-media-id": copy.mediaId,
              "data-width": Number.isFinite(width) ? nearest : "100",
              "data-align": (IMAGE_ALIGNMENTS as readonly (string | null)[]).includes(align) ? align! : "center",
            },
            make("img", { alt }),
          ),
        );
      } else {
        element.replaceWith(make("div", { "data-file": "", "data-media-id": copy.mediaId, "data-name": copy.filename ?? name ?? "", "data-size": String(copy.size) }));
      }
    }
    // Blank lines kept as spacers (and paragraphs that only held a block now on its own).
    all("p")
      .filter((p) => !p.textContent?.trim())
      .forEach((p) => p.replaceWith(...p.querySelectorAll("figure, div[data-file], div[data-video]")));
    // Featurebase's custom blocks not handled above (and any element we don't know) keep their content only.

    const json = generateJSON(body.innerHTML, extensions(profile));
    updateImages(json, (mediaId) => ({ w: sizes.get(mediaId)?.width ?? null, h: sizes.get(mediaId)?.height ?? null }));
    const parsed = parseDoc(profile, json);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    return { doc: parsed.doc, text: toPlainText(parsed.doc), mediaIds: mediaIdsIn(parsed.doc), leftOut };
  } finally {
    await window.happyDOM.close();
  }
}

/**
 * One key for every URL of a file: a presigned URL (S3's, as Featurebase's are) without its query, which is new each
 * time it's read; any other URL as it is. Only from the URL, never from attributes the HTML's writer chose, so nobody
 * can pass their file off as another's.
 */
function sameFile(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has("X-Amz-Signature") ? `${parsed.origin}${parsed.pathname}` : url;
  } catch {
    return url;
  }
}

/** A link into Featurebase's storage. */
function inAttachmentStorage(href: string): boolean {
  try {
    return ATTACHMENT_HOST.test(new URL(href).hostname);
  } catch {
    return false;
  }
}

/** A link to a document in Featurebase's storage (an attachment), by its name's extension. */
const isAttachment = (href: string) => inAttachmentStorage(href) && fileExtension(fileName(href)) in UPLOAD_FILE_TYPES;

/** A file's name from its URL: Featurebase's storage keeps it base64url-encoded (`b64u-<name>.<ext>`). */
export function fileName(url: string): string {
  let last: string;
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  } catch {
    return "";
  }
  const encoded = /^b64u-([\w-]+)\.\w+$/.exec(last)?.[1];
  return encoded ? Buffer.from(encoded, "base64url").toString("utf8") : last;
}
