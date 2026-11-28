import { prisma } from "@tuti/db";
import type { PlanKey } from "@tuti/shared";
import { planIncludes, readerEntriesFor } from "@tuti/shared";

import type { Session } from "./auth";
import { previewUser } from "./preview-session";
import { onTeam, sessionFrom } from "../session";

/*
 * Who may read a portal, and the team's preview of one: the one function proxy.ts's gate (a private portal, a language
 * that isn't live yet) and the server's readers decide with (docs/plan.md, "One way in"), so the two can't answer the
 * same person differently. Not a "use server" module: its exports must never be callable from browsers.
 */

/**
 * Who may read a project's portal (Settings → Access). Public: anyone. Private: only
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
export async function canReadPortal(where: { id: string } | { slug: string }, userId: string | null | undefined, session?: Session | null): Promise<boolean> {
  const project = await prisma.project.findUnique({ where, select: { id: true, portalAccess: true, plan: true } });
  // A missing project has nothing to hide; callers answer "not found" for it.
  if (!project || project.portalAccess === "PUBLIC") {
    return true;
  }
  return !!userId && (await isPrivateReader(project, userId, session));
}

/**
 * On the project's team (onTeam: never with a portal's session), or, on a plan with private portals, signed in by its SSO
 * or one of its readers (with that email verified). `session`: the request's, for proxy.ts.
 */
async function isPrivateReader(project: { id: string; plan: PlanKey }, userId: string, session?: Session | null): Promise<boolean> {
  const projectId = project.id;
  const readers = planIncludes(project.plan, "privatePortal");
  const [member, sso, reader] = await Promise.all([
    onTeam(projectId, userId, session),
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
  const session = await sessionFrom(headers);
  if (session && (await isPrivateReader(project, session.user.id, session))) {
    return "allowed";
  }
  return (await previewReader(project.id, preview)) ? "allowed" : "refused";
}

/**
 * Customize's preview of a portal (server/auth/preview-session.ts): this cookie, partitioned to the app's
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

/**
 * For proxy.ts: whether this request is the team's, who may open the addresses of a language that isn't live (docs/plan.md,
 * Languages): Customize's preview (its cookie), or a team member signed in to the app on Tuti's own portal (a portal's session
 * is a reader's, onTeam).
 */
export async function teamPreview(slug: string, headers: Headers, preview?: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  if (!project) {
    return false;
  }
  if (await previewReader(project.id, preview)) {
    return true;
  }
  const session = await sessionFrom(headers);
  return !!session && (await onTeam(project.id, session.user.id, session));
}

/** For proxy.ts: whether a preview token in a portal's address (`slug`'s) is one to keep as its cookie. */
export async function previewTokenFor(slug: string, token: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  return !!project && !!(await previewReader(project.id, token));
}
