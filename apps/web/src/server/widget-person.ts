import { type Prisma, prisma } from "@tuti/db";

import { newVisitor, visitorHash } from "@/lib/visitor-session";
import { widgetUser } from "@/lib/widget-session";

import { canActIn } from "./membership";
import { getSession } from "./session";

/**
 * Who's writing in the widget's Messages (docs/plan.md, Support inbox): someone the page signed in
 * (its widget token, lib/widget-session.ts), someone signed in on the portal itself, or a
 * signed-out visitor (their visitor token, lib/visitor-session.ts). Never the reader cookie, which
 * only says who may read a private portal. Not a "use server" module: never callable from browsers.
 */

/** What the panel holds: a widget token when the page signed someone in, else a visitor token if they've written before. */
export type WidgetAuth = { token?: string | null; visitor?: string | null };

export type WidgetPerson = { projectId: string; where: Prisma.ConversationWhereInput; userId: string | null; visitorHash: string | null };

const signedIn = (projectId: string, userId: string): WidgetPerson => ({ projectId, where: { userId }, userId, visitorHash: null });
const visitor = (projectId: string, hash: string): WidgetPerson => ({ projectId, where: { visitorHash: hash, userId: null }, userId: null, visitorHash: hash });

/** Whoever the panel says is here, signed in first; null if nobody is (or the inbox is off). */
export async function widgetPerson(projectSlug: string, auth: WidgetAuth): Promise<WidgetPerson | null> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, supportInbox: true } });
  if (!project?.supportInbox) {
    return null;
  }
  if (auth.token) {
    const userId = widgetUser(project.id, String(auth.token));
    return userId ? signedIn(project.id, userId) : null;
  }
  const session = await getSession();
  if (session && (await canActIn(session.user.id, project.id))) {
    return signedIn(project.id, session.user.id);
  }
  const hash = auth.visitor ? visitorHash(project.id, String(auth.visitor)) : null;
  return hash ? visitor(project.id, hash) : null;
}

/** A new signed-out visitor: who they are from now on, and the token the panel keeps. */
export function newWidgetVisitor(projectId: string) {
  const fresh = newVisitor(projectId);
  return { person: visitor(projectId, fresh.hash), token: fresh.token };
}
