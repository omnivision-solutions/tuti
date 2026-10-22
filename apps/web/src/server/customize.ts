import { portalUrl } from "@/lib/hosts";
import { CUSTOMIZE } from "@/lib/portal-base";

import { portalAddress } from "./custom-domains";

/**
 * Customize's preview of page `path` of a portal: the page at the portal's Tuti address (which the
 * app may frame, and which doesn't send it on to the portal's own address there), and where readers
 * find it, for the preview's address bar.
 */
export async function portalPreview(slug: string, path: string): Promise<{ src: string; address: string }> {
  const src = `${portalUrl(slug)}${path}?${new URLSearchParams({ [CUSTOMIZE.param]: CUSTOMIZE.value })}`;
  return { src, address: `${await portalAddress(slug)}${path === "/" ? "" : path}` };
}
