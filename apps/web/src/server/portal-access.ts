import { prisma } from "@tuti/db";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { widgetUser } from "@/lib/widget-session";

import { getSession } from "./session";

/**
 * Who may read a project's portal (Settings → Portal access). Public: anyone. Private: only
 * its team and the people its own app signs in (SSO); signing up, a sign-in link or any other
 * Tuti account gets an account, not a way in. proxy.ts applies this to every portal page and
 * file, the widget panel and /api/widget/latest to themselves, and the readers' actions through
 * readableProject (or canActIn, for those that need an account).
 *
 * Not a "use server" module: its exports must never be callable from browsers.
 */
export async function canReadPortal(where: { id: string } | { slug: string }, userId: string | null | undefined): Promise<boolean> {
  const project = await prisma.project.findUnique({ where, select: { id: true, portalAccess: true } });
  // A missing project has nothing to hide; callers answer "not found" for it.
  if (!project || project.portalAccess === "PUBLIC") {
    return true;
  }
  return !!userId && (await isPrivateReader(project.id, userId));
}

/** On the project's team, or signed in by its SSO. */
async function isPrivateReader(projectId: string, userId: string): Promise<boolean> {
  const [member, sso] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { id: true } }),
  ]);
  return !!(member || sso);
}

/** For proxy.ts: a request to a portal, with its cookies. A public portal (or a missing one) needs no session. */
export async function portalVisitor(slug: string, headers: Headers): Promise<"public" | "allowed" | "refused"> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, portalAccess: true } });
  if (!project || project.portalAccess === "PUBLIC") {
    return "public";
  }
  const session = await auth.api.getSession({ headers });
  return session && (await isPrivateReader(project.id, session.user.id)) ? "allowed" : "refused";
}

/**
 * In the widget on a customer's site the portal's session cookie isn't sent; the person their app
 * signs in (Tuti.identify) gets this cookie instead (set by widgetSignIn: partitioned per embedding
 * site, holding their signed widget token), so the panel can show a private portal to them.
 */
export const WIDGET_READER_COOKIE = "tuti_widget_reader";

/** Who's reading on this request: the portal's signed-in user, or the person signed in to the widget. */
async function readerId(projectId: string): Promise<string | null> {
  const session = await getSession();
  if (session) {
    return session.user.id;
  }
  const token = (await cookies()).get(WIDGET_READER_COOKIE)?.value;
  return token ? widgetUser(projectId, token) : null;
}

/** Whether whoever's asking may read the project's portal. */
export async function mayRead(projectId: string): Promise<boolean> {
  return canReadPortal({ id: projectId }, await readerId(projectId));
}

/** The project, for readers' actions anyone may take (signed in or not): null if it's missing or they may not read it. */
export async function readableProject(slug: string): Promise<{ id: string } | null> {
  const project = await prisma.project.findUnique({ where: { slug: String(slug) }, select: { id: true } });
  return project && (await mayRead(project.id)) ? project : null;
}
