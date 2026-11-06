import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";
import { previewToken } from "@/lib/preview-session";

import { portalAddress } from "./custom-domains";
import { portalHomePath } from "./portal-home";
import { sessionIn } from "./session";

/**
 * Customize's preview of page `path` of a portal (CustomizeShell's `preview`): the portal's Tuti
 * address (which the app may frame, and which doesn't send the preview on to the portal's own address
 * there), where readers find it, for the preview's address bar, and a token that reads the portal as
 * the team member looking (lib/preview-session.ts), so a private one shows too.
 */
export async function portalPreview(slug: string, path: string): Promise<{ origin: string; path: string; address: string; token?: string }> {
  // The home ("/") sends people to the part it opens: the preview starts there.
  const page = path === "/" ? ((await portalHomePath(slug)) ?? path) : path;
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  const session = project && (await sessionIn(project.id));
  return {
    origin: new URL(portalUrl(slug)).origin,
    path: page,
    address: await portalAddress(slug),
    ...(session && project && { token: previewToken(project.id, session.user.id) }),
  };
}
