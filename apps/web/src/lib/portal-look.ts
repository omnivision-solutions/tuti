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

export type PortalLook = {
  /** `#rrggbb`, or null for the brand green. */
  color: string | null;
  logo: LookImage | null;
  logoDark: LookImage | null;
  headerLinks: LookLink[];
  footerLinks: LookLink[];
  poweredBy: boolean;
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

/** A change from the app, with only web addresses for links and images and a `#rrggbb` colour (as saving would allow). */
export function webOnly(look: Partial<PortalLook>): Partial<PortalLook> {
  const links = (list: PortalLook["headerLinks"] | undefined) => list?.filter((link) => web(link.url));
  const image = (value: LookImage | null | undefined) => (value === undefined ? undefined : value && web(value.url) ? value : null);
  const color = look.color === undefined || look.color === null || /^#[0-9a-f]{6}$/i.test(look.color) ? look.color : undefined;
  const checked = { ...look, color, headerLinks: links(look.headerLinks), footerLinks: links(look.footerLinks), logo: image(look.logo), logoDark: image(look.logoDark) };
  return Object.fromEntries(Object.entries(checked).filter(([, value]) => value !== undefined));
}
