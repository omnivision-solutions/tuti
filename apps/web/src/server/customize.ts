import { portalUrl } from "@/lib/hosts";

import { portalAddress } from "./custom-domains";
import { portalHomePath } from "./portal-home";

/**
 * Customize's preview of page `path` of a portal (CustomizeShell's `preview`): the portal's Tuti
 * address (which the app may frame, and which doesn't send the preview on to the portal's own address
 * there), and where readers find it, for the preview's address bar.
 */
export async function portalPreview(slug: string, path: string): Promise<{ origin: string; path: string; address: string }> {
  // The home ("/") sends people to the part it opens: the preview starts there.
  const page = path === "/" ? ((await portalHomePath(slug)) ?? path) : path;
  return { origin: new URL(portalUrl(slug)).origin, path: page, address: await portalAddress(slug) };
}
