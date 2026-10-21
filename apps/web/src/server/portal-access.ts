import { prisma } from "@tuti/db";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { auth } from "@/lib/auth";
import { inGroup, readerAttributes, storedConditions } from "@/lib/group-conditions";
import { PREVIEW } from "@/lib/portal-base";
import { readerEntriesFor } from "@/lib/reader-domains";
import { type Reader, SIGNED_OUT } from "@/lib/read-access";

import type { Actor } from "./operations/define";
import { widgetUser } from "@/lib/widget-session";

import { getSession } from "./session";

/**
 * Who may read a project's portal (Settings → Portal access). Public: anyone. Private: only
 * its team, the people its own app signs in (SSO) and the readers the team added by email (once
 * that email is verified); signing up, a sign-in link or any other Tuti account gets an account,
 * not a way in. proxy.ts applies this to every portal page and
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

/** On the project's team, signed in by its SSO, or one of its readers (with that email verified). */
async function isPrivateReader(projectId: string, userId: string): Promise<boolean> {
  const [member, sso, reader] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { id: true } }),
    invitedReader(projectId, userId),
  ]);
  return !!(member || sso || reader === "verified");
}

/**
 * Whether the user's email (or its domain) is on the project's readers: "verified" lets them read a private portal;
 * "unverified" doesn't yet (anyone can sign up with any address), which the sign-in page says.
 */
export async function invitedReader(projectId: string, userId: string): Promise<"verified" | "unverified" | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
  if (!user) {
    return null;
  }
  // The address itself, or its domain ("@acme.com").
  const reader = await prisma.portalReader.findFirst({ where: { projectId, email: { in: readerEntriesFor(user.email) } }, select: { id: true } });
  return reader ? (user.emailVerified ? "verified" : "unverified") : null;
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

/**
 * Who's reading, for what of the docs they may read (see lib/read-access.ts): null for the project's
 * team (everything); else whether they're signed in, and the keys of the groups their latest sign-in
 * through the project's SSO puts them in (by its `groups` or its `attributes`, see
 * lib/group-conditions.ts), none if it didn't sign them in. Once per request: pages ask many times.
 */
export const readerOf = cache(async (projectId: string, userId: string | null | undefined): Promise<Reader> => {
  if (!userId) {
    return SIGNED_OUT;
  }
  const [member, sso, groups] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { groups: true, attributes: true } }),
    prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, claim: true, conditions: true } }),
  ]);
  if (member) {
    return null;
  }
  if (!sso) {
    return { signedIn: true, groups: [] };
  }
  const reader = { groups: sso.groups, attributes: readerAttributes(sso.attributes) };
  return {
    signedIn: true,
    groups: groups.filter((group) => inGroup({ claim: group.claim, conditions: storedConditions(group.conditions) }, reader)).map((group) => group.key),
  };
});

/**
 * Whoever's reading on this request (the portal's user, or the widget's). The team previewing the
 * portal as a reader (PREVIEW) reads it as people signed out do; for anyone else the preview
 * changes nothing, so it never shows more than they may read.
 */
export async function currentReader(projectId: string): Promise<Reader> {
  const reader = await readerOf(projectId, await readerId(projectId));
  return reader === null && (await headers()).get(PREVIEW.header) === PREVIEW.value ? SIGNED_OUT : reader;
}

/** An operation's caller as a reader: API keys act for the team (everything). */
export async function actorReader(actor: Actor, projectId: string): Promise<Reader> {
  return actor.kind === "apiKey" ? null : readerOf(projectId, actor.userId);
}
