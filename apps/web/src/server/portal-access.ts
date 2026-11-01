import { type Plan, prisma } from "@tuti/db";
import { planIncludes, readerEntriesFor } from "@tuti/shared";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { auth } from "@/lib/auth";
import { inGroup, storedConditions } from "@/lib/group-conditions";
import { PREVIEW } from "@/lib/portal-base";
import { type Reader, SIGNED_OUT } from "@/lib/read-access";
import { storedProperties } from "@/lib/user-properties";

import type { Actor } from "./operations/define";
import { previewUser } from "@/lib/preview-session";
import { widgetUser } from "@/lib/widget-session";

import { getSession } from "./session";

/**
 * Who may read a project's portal (Settings → Portal access). Public: anyone. Private: only
 * its team, the people its own app signs in (SSO) and the readers the team added by email (once
 * that email is verified); signing up, a sign-in link or any other Tuti account gets an account,
 * not a way in. proxy.ts applies this to every portal page and
 * file, the widget panel and /api/widget/latest to themselves, and the readers' actions through
 * readableProject (or canActIn, for those that need an account). On a plan without private portals
 * (where plans are sold), a private portal stays private but only its team may read it, and content for
 * reader groups is the team's only, until the plan is back: nothing becomes more public.
 *
 * Not a "use server" module: its exports must never be callable from browsers.
 */
export async function canReadPortal(where: { id: string } | { slug: string }, userId: string | null | undefined): Promise<boolean> {
  const project = await prisma.project.findUnique({ where, select: { id: true, portalAccess: true, plan: true } });
  // A missing project has nothing to hide; callers answer "not found" for it.
  if (!project || project.portalAccess === "PUBLIC") {
    return true;
  }
  return !!userId && (await isPrivateReader(project, userId));
}

/** On the project's team, or, on a plan with private portals, signed in by its SSO or one of its readers (with that email verified). */
async function isPrivateReader(project: { id: string; plan: Plan }, userId: string): Promise<boolean> {
  const projectId = project.id;
  const readers = planIncludes(project.plan, "privatePortal");
  const [member, sso, reader] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    readers ? prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { id: true } }) : null,
    readers ? invitedReader(projectId, userId) : null,
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

/**
 * For proxy.ts: a request to a portal, with its cookies (`preview`: its PREVIEW_READER_COOKIE). A
 * public portal (or a missing one) needs no session.
 */
export async function portalVisitor(slug: string, headers: Headers, preview?: string): Promise<"public" | "allowed" | "refused"> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, portalAccess: true, plan: true } });
  if (!project || project.portalAccess === "PUBLIC") {
    return "public";
  }
  const session = await auth.api.getSession({ headers });
  if (session && (await isPrivateReader(project, session.user.id))) {
    return "allowed";
  }
  return (await previewReader(project.id, preview)) ? "allowed" : "refused";
}

/**
 * Customize's preview of a portal (lib/preview-session.ts): this cookie, partitioned to the app's
 * site, holds the token of the team member it reads the portal as.
 */
export const PREVIEW_READER_COOKIE = "tuti_preview_reader";

/** The team member a preview token reads the portal as: valid for this project, and still on its team. */
export async function previewReader(projectId: string, token: string | null | undefined): Promise<string | null> {
  const userId = token ? previewUser(projectId, token) : null;
  if (!userId) {
    return null;
  }
  const member = await prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } });
  return member ? userId : null;
}

/** For proxy.ts: whether a preview token in a portal's address (`slug`'s) is one to keep as its cookie. */
export async function previewTokenFor(slug: string, token: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  return !!project && !!(await previewReader(project.id, token));
}

/**
 * In the widget on a customer's site the portal's session cookie isn't sent; the person their app
 * signs in (Tuti.identify) gets this cookie instead (set by widgetSignIn: partitioned per embedding
 * site, holding their signed widget token), so the panel can show a private portal to them.
 */
export const WIDGET_READER_COOKIE = "tuti_widget_reader";

/**
 * Who's reading on this request: the portal's signed-in user, the person signed in to the widget, or
 * the team member previewing the portal in Customize.
 */
async function readerId(projectId: string): Promise<string | null> {
  const session = await getSession();
  if (session) {
    return session.user.id;
  }
  const jar = await cookies();
  const token = jar.get(WIDGET_READER_COOKIE)?.value;
  const widget = token ? widgetUser(projectId, token) : null;
  return widget ?? previewReader(projectId, jar.get(PREVIEW_READER_COOKIE)?.value);
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
 * team (everything); else whether they're signed in, and the keys of the groups they're in as the
 * project's user (by their properties, see lib/group-conditions.ts): the one
 * its SSO signed them in as, or, signed in another way, the ones with their address once it's
 * verified (any of them puts them in a group). None for everyone else, and none on a plan without
 * reader groups. Once per request: pages ask many times.
 */
export const readerOf = cache(async (projectId: string, userId: string | null | undefined): Promise<Reader> => {
  if (!userId) {
    return SIGNED_OUT;
  }
  const [member, account, groups, project] = await Promise.all([
    prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
    prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, conditions: true } }),
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
    groups: groups.filter((group) => readers.some((properties) => inGroup(storedConditions(group.conditions), properties))).map((group) => group.key),
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

/**
 * The addresses that are `userId`'s own: their account's once it's verified, and the one the project's
 * SSO gave them (their account's is a placeholder then). None for people signed out.
 */
export async function ownAddresses(projectId: string, userId: string | null | undefined): Promise<string[]> {
  if (!userId) {
    return [];
  }
  const [user, sso] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
    prisma.ssoIdentity.findFirst({ where: { userId, projectId }, select: { email: true } }),
  ]);
  return [user?.emailVerified ? user.email : null, sso?.email ?? null].filter((email) => email !== null).map((email) => email.toLowerCase());
}

/** Whoever's reading on this request (see currentReader), with their own addresses (see ownAddresses). */
export async function currentAsker(projectId: string): Promise<{ reader: Reader; addresses: string[] }> {
  const [reader, addresses] = await Promise.all([currentReader(projectId), readerId(projectId).then((id) => ownAddresses(projectId, id))]);
  return { reader, addresses };
}
