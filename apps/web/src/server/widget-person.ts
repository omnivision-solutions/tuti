import { type Prisma, prisma } from "@tuti/db";

import { newVisitor, visitorHash } from "@/lib/visitor-session";
import { widgetUser } from "@/lib/widget-session";

import type { InboxChange } from "./live";
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

/**
 * `where`: their conversations, for every reader (lists, counts, limits). `email`: the address the project's own app
 * signed them in with, whose conversations by email are theirs too (signedIn).
 */
export type WidgetPerson = { projectId: string; where: Prisma.ConversationWhereInput; userId: string | null; visitorHash: string | null; email: string | null };

/**
 * Someone signed in: their own conversations and, when the project's app signs them in (their SSO identity here, by
 * the widget's token or on the portal), the project's conversations with nobody Tuti knows (no user, nor a visitor) from that address, verified
 * (an email whose DMARC passed; what the widget and the API are given never is). Matching by email is refused for
 * signing in (lib/sso.ts), as a project could claim anyone's address; here it's the project's own conversations, by
 * its own word for the address, as received email already joins them (server/inbound.ts, userWithAddress). A portal
 * account's verified address alone doesn't: Tuti's word, not the project's, and its mail joins it as it comes.
 */
async function signedIn(projectId: string, userId: string): Promise<WidgetPerson> {
  const sso = await prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { email: true } });
  const email = sso?.email ?? null;
  const where = email ? { OR: [{ userId }, { userId: null, visitorHash: null, emailVerified: true, email }] } : { userId };
  return { projectId, where, userId, visitorHash: null, email };
}

/** Whether a live change (server/live.ts) is to one of their conversations, as `where` has them (an unverified one by their address only refetches). */
export function hears(who: WidgetPerson, change: InboxChange): boolean {
  if (change.projectId !== who.projectId) {
    return false;
  }
  if (!who.userId) {
    return change.visitorHash === who.visitorHash;
  }
  return change.userId === who.userId || (!!who.email && change.userId === null && change.visitorHash === null && change.email === who.email);
}

const visitor = (projectId: string, hash: string): WidgetPerson => ({
  projectId,
  where: { visitorHash: hash, userId: null },
  userId: null,
  visitorHash: hash,
  email: null,
});

/** Whoever the panel says is here, signed in first; null if nobody is (or the inbox is off). */
export async function widgetPerson(projectSlug: string, auth: WidgetAuth): Promise<WidgetPerson | null> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, supportInbox: true } });
  if (!project?.supportInbox) {
    return null;
  }
  if (auth.token) {
    const userId = widgetUser(project.id, String(auth.token));
    return userId ? await signedIn(project.id, userId) : null;
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
