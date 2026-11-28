import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";
import { previewToken } from "@/server/auth/preview-session";

import { portalAddress } from "./custom-domains";
import { portalHomePath } from "./portal-home";
import { sessionIn } from "./session";

/**
 * Customize's preview of page `path` of a portal (PortalSettingsPane's `preview`): the portal's Tuti
 * address (which the app may frame, and which doesn't send the preview on to the portal's own address
 * there), where readers find it, for the preview's address bar, and a token that reads the portal as
 * the team member looking (server/auth/preview-session.ts), so a private one shows too.
 */
export async function portalPreview(slug: string, path: string): Promise<Preview> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  const session = project && (await sessionIn(project.id));
  return previewOf({ id: project?.id ?? "", slug }, session?.user.id ?? null, path);
}

export type Preview = { origin: string; path: string; address: string; token?: string };

/** The preview for `viewer` (null: no token), as above: customize.preview's, and portalPreview's until its screens move. */
export async function previewOf(project: { id: string; slug: string }, viewer: string | null, path: string): Promise<Preview> {
  // The home ("/") sends people to the part it opens: the preview starts there.
  const page = path === "/" ? ((await portalHomePath(project.slug)) ?? path) : path;
  return {
    origin: new URL(portalUrl(project.slug)).origin,
    path: page,
    address: await portalAddress(project.slug),
    ...(viewer && project.id && { token: previewToken(project.id, viewer) }),
  };
}
