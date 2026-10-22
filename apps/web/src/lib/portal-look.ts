/**
 * How a portal looks, as its pages show it (from branding.ts and the other look settings), and the
 * messages Customize's preview and the portal it frames send each other (components/portal-look.tsx,
 * components/customize-shell.tsx). No server imports here: both sides run in the browser.
 */

/**
 * The name of Customize's preview frame. A page in a frame of that name (the name stays as the frame
 * goes from page to page, redirects too) takes the app's messages: from the app's origin only, which
 * alone may frame portal pages (proxy.ts).
 */
export const PREVIEW_FRAME = "tuti-preview";

export type LookImage = { url: string; width?: number; height?: number };
export type LookLink = { label: string; url: string };

/** What readers can do with an article: the "Copy page" menu at all (`menu`), what's in it, and the "Updated" date. */
export type ContentActions = { menu: boolean; copyMarkdown: boolean; chatGpt: boolean; claude: boolean; updatedDate: boolean };

/** The docs' home: a title and subtitle above its search box (empty: "Docs" and the default line), and its most-read articles. */
export type DocsHome = { title: string; subtitle: string; popular: boolean };

export const DOCS_TITLE_MAX = 80;
export const DOCS_SUBTITLE_MAX = 200;

export type PortalLook = {
  /** `#rrggbb`, or null for the brand green. */
  color: string | null;
  logo: LookImage | null;
  logoDark: LookImage | null;
  headerLinks: LookLink[];
  footerLinks: LookLink[];
  poweredBy: boolean;
  contentActions: ContentActions;
  docsHome: DocsHome;
};

/** A portal's look with nothing set (outside a portal's pages, what its parts fall back to). */
export const DEFAULT_LOOK: PortalLook = {
  color: null,
  logo: null,
  logoDark: null,
  headerLinks: [],
  footerLinks: [],
  poweredBy: true,
  contentActions: { menu: true, copyMarkdown: true, chatGpt: true, claude: true, updatedDate: true },
  docsHome: { title: "", subtitle: "", popular: false },
};

/** The app → the frame: a change not saved yet (`look`, merged over what's saved), or light or dark mode. */
export type ToPortal = { type: "tuti:look"; look: Partial<PortalLook> } | { type: "tuti:theme"; theme: "light" | "dark" };

/** The frame → the app: a page is open (on load, and on each page after it), at `path`. */
export type FromPortal = { type: "tuti:ready"; path: string };

export function isToPortal(data: unknown): data is ToPortal {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const message = data as ToPortal;
  return (message.type === "tuti:look" && typeof message.look === "object" && message.look !== null) || (message.type === "tuti:theme" && (message.theme === "light" || message.theme === "dark"));
}

export function isFromPortal(data: unknown): data is FromPortal {
  return typeof data === "object" && data !== null && (data as FromPortal).type === "tuti:ready" && typeof (data as FromPortal).path === "string";
}

const web = (url: unknown) => typeof url === "string" && /^https?:\/\//i.test(url);
const isLinks = (list: unknown): list is LookLink[] =>
  Array.isArray(list) && list.every((link) => typeof link?.label === "string" && typeof link?.url === "string");
const isImage = (value: unknown): value is LookImage | null => value === null || (typeof (value as LookImage)?.url === "string" && web((value as LookImage).url));
const booleans = <K extends string>(value: unknown, keys: readonly K[]) =>
  typeof value === "object" && value !== null && keys.every((key) => typeof (value as Record<string, unknown>)[key] === "boolean");

/**
 * A change from the app, as saving would allow it: only what a look has, web addresses for links and
 * images, a `#rrggbb` colour, text within its limits. Anything else is left out, so what's saved stays.
 */
export function webOnly(look: Partial<PortalLook>): Partial<PortalLook> {
  const checked: Partial<PortalLook> = {};
  if (look.color === null || (typeof look.color === "string" && /^#[0-9a-f]{6}$/i.test(look.color))) {
    checked.color = look.color;
  }
  for (const key of ["logo", "logoDark"] as const) {
    if (look[key] !== undefined) {
      checked[key] = isImage(look[key]) ? look[key] : null;
    }
  }
  for (const key of ["headerLinks", "footerLinks"] as const) {
    if (isLinks(look[key])) {
      checked[key] = look[key].filter((link) => web(link.url));
    }
  }
  if (typeof look.poweredBy === "boolean") {
    checked.poweredBy = look.poweredBy;
  }
  if (booleans(look.contentActions, ["menu", "copyMarkdown", "chatGpt", "claude", "updatedDate"] as const)) {
    checked.contentActions = look.contentActions;
  }
  const home = look.docsHome;
  if (home && typeof home.title === "string" && typeof home.subtitle === "string" && typeof home.popular === "boolean") {
    checked.docsHome = { title: home.title.slice(0, DOCS_TITLE_MAX), subtitle: home.subtitle.slice(0, DOCS_SUBTITLE_MAX), popular: home.popular };
  }
  return checked;
}
