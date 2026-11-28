import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import type { Session } from "@/server/auth/auth";
import { inGroup, storedRule } from "@tuti/shared/group-conditions";
import { PREVIEW } from "@/lib/portal-base";
import { type Reader, SIGNED_OUT } from "@/lib/read-access";
import { storedProperties } from "@tuti/shared/user-properties";

import type { Actor } from "./operations/define";
import type { PostViewer } from "./post-visibility";
import { canReadPortal, PREVIEW_READER_COOKIE, previewReader, WIDGET_READER_COOKIE } from "@/server/auth/portal-readers";
import { widgetTokenUser } from "@/server/auth/widget-session";

import { onTeam, sessionIn } from "./session";

/**
 * Who's reading on a request, for the portal's pages and the readers' actions. Who may read a portal at all
 * (canReadPortal) and proxy.ts's gate are server/auth/portal-readers.ts, the one function both decide with.
 *
 * Not a "use server" module: its exports must never be callable from browsers.
 */

/**
 * Who's reading on this request: the team member previewing the portal in Customize (its cookie is only ever in
 * Customize's frame, which carries the portal's cookies too, so it comes first: a portal session there is a reader's,
 * see onTeam), the portal's signed-in user, or the person signed in to the widget. A portal session that may not read
 * the portal (a team member's on their own private portal) gives way to the widget's. `session` null: the widget's or
 * the preview's person, read with no portal session (onTeam).
 */
const reader = cache(async (projectId: string): Promise<{ userId: string | null; session?: null }> => {
  const jar = await cookies();
  const previewing = await previewReader(projectId, jar.get(PREVIEW_READER_COOKIE)?.value);
  if (previewing) {
    return { userId: previewing, session: null };
  }
  const session = await sessionIn(projectId);
  if (session && (await canReadPortal({ id: projectId }, session.user.id))) {
    return { userId: session.user.id };
  }
  const token = jar.get(WIDGET_READER_COOKIE)?.value;
  const widget = token ? await widgetTokenUser(projectId, token) : null;
  return widget ? { userId: widget, session: null } : { userId: session?.user.id ?? null };
});

/** Whether whoever's asking may read the project's portal. */
export async function mayRead(projectId: string): Promise<boolean> {
  const { userId, session } = await reader(projectId);
  return canReadPortal({ id: projectId }, userId, session);
}

/** The project, for readers' actions anyone may take (signed in or not): null if it's missing or they may not read it. */
export async function readableProject(slug: string): Promise<{ id: string } | null> {
  const project = await prisma.project.findUnique({ where: { slug: String(slug) }, select: { id: true } });
  return project && (await mayRead(project.id)) ? project : null;
}

/**
 * Who's reading, for what of the docs they may read (see lib/read-access.ts): null for the project's
 * team (everything; onTeam: never with a portal's session); else whether they're signed in, and the keys of the groups they're in as the
 * project's user (by their properties, see @tuti/shared/group-conditions): the one
 * its SSO signed them in as, or, signed in another way, the ones with their address once it's
 * verified (any of them puts them in a group). None for everyone else, and none on a plan without
 * reader groups. Once per request: pages ask many times.
 */
export const readerOf = cache(async (projectId: string, userId: string | null | undefined, session?: Session | null, asReader = false): Promise<Reader> => {
  if (!userId) {
    return SIGNED_OUT;
  }
  const [member, account, groups, project] = await Promise.all([
    // `asReader`: never the team (the widget's person: Actor's viaWidget).
    !asReader && onTeam(projectId, userId, session),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
    prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, conditions: true, match: true } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { plan: true } }),
  ]);
  if (member) {
    return null;
  }
  if (!project || !planIncludes(project.plan, "privatePortal")) {
    return { signedIn: true, groups: [] };
  }
  // SSO accounts' own addresses are placeholders, never verified. Emails are kept lowercase, but an
  // instance from before that (still running while a deploy overlaps it) may write one that isn't.
  const byEmail = account?.emailVerified ? [{ email: { equals: account.email, mode: "insensitive" as const } }] : [];
  const users = await prisma.ssoIdentity.findMany({ where: { projectId, OR: [{ userId }, ...byEmail] }, select: { properties: true } });
  const readers = users.map((user) => storedProperties(user.properties));
  return {
    signedIn: true,
    groups: groups.filter((group) => readers.some((properties) => inGroup(storedRule(group), properties))).map((group) => group.key),
  };
});

/**
 * Whoever's reading on this request (the portal's user, or the widget's). Previewing the portal as a reader (PREVIEW)
 * reads it as people signed out do, whoever's looking (a team member's portal session is a reader's too): it only ever
 * shows less.
 */
export async function currentReader(projectId: string): Promise<Reader> {
  const { userId, session } = await reader(projectId);
  const read = await readerOf(projectId, userId, session);
  return (await headers()).get(PREVIEW.header) === PREVIEW.value ? SIGNED_OUT : read;
}

/** currentReader on the portal at `slug` (signed out when there's no such project). */
export async function slugReader(slug: string): Promise<Reader> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  return project ? currentReader(project.id) : SIGNED_OUT;
}

/**
 * Whoever's reading on this request as a viewer of posts (post-visibility.ts): the team, as currentReader has it (the
 * team previewing the portal as a reader sees what people signed out do), or the portal's or widget's person.
 */
export async function currentPostViewer(projectId: string): Promise<PostViewer> {
  const [{ userId }, read] = await Promise.all([reader(projectId), currentReader(projectId)]);
  return read === null ? { team: true, userId } : { team: false, userId: read.signedIn ? userId : null };
}

/**
 * An operation's caller as a reader: API keys act for the team (everything); a visitor reads as people signed out do; the
 * widget's person as a reader, never the team.
 */
export async function actorReader(actor: Actor, projectId: string): Promise<Reader> {
  return actor.kind === "apiKey" ? null : actor.kind === "user" ? readerOf(projectId, actor.userId, undefined, !!actor.viaWidget) : readerOf(projectId, null);
}

