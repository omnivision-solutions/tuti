"use server";

import { prisma } from "@tuti/db";
import { cookies } from "next/headers";

import { linksFrom } from "@/lib/forms";
import { ACTIVE_STATUSES, parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import type { WidgetIcon } from "@/lib/widget-icons";
import { widgetToken, widgetUser } from "@/lib/widget-session";
import { verifySsoToken } from "@/lib/sso";

import type { FormState } from "./form-state";
import { canActIn } from "./membership";
import { createPost as createPostOperation } from "./operations/create";
import { OperationError } from "./operations/define";
import { setVote } from "./operations/more";
import { asAdmin, call, postNumberOf } from "./operations/run";
import { readableProject, WIDGET_READER_COOKIE } from "./portal-access";
import { boardPosts } from "./post-lists";
import { getSession } from "./session";
import { updateWidgetSettings } from "./operations/widget";
import { type IdeaNews, ideaNews } from "./widget-home";

/**
 * The widget's actions: on customers' sites (see lib/widget-session.ts for its
 * tokens), and the team's launcher settings.
 */

// Lets the panel's pages show a private portal to whoever the page signed in (see portal-access.ts).
// Partitioned: kept per embedding site, never shared across sites; gone when the browser closes or the token expires.
const readerCookie = { httpOnly: true, sameSite: "none", secure: true, partitioned: true, path: "/" } as const;

/** The page has nobody signed in now: the panel's pages stop showing a private portal to whoever was. */
export async function widgetSignOut() {
  (await cookies()).set(WIDGET_READER_COOKIE, "", { ...readerCookie, maxAge: 0 });
}

/** Trades an SSO token from the project's own app for a widget token, and says who signed in. */
export async function widgetSignIn(
  projectSlug: string,
  ssoToken: string,
): Promise<{ id: string; token: string; name: string; named: boolean; email: string | null } | { error: string }> {
  const jar = await cookies();
  // Whoever the page signed in before isn't who's here now unless this token says so.
  jar.set(WIDGET_READER_COOKIE, "", { ...readerCookie, maxAge: 0 });
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, ssoSecret: true } });
  if (!project?.ssoSecret) {
    return { error: "Single sign-on isn't set up for this project" };
  }
  const verified = await verifySsoToken({ id: project.id, ssoSecret: project.ssoSecret }, String(ssoToken).slice(0, 8192));
  if ("error" in verified) {
    return { error: "Couldn't sign you in" };
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: verified.userId },
    select: { name: true, ssoIdentity: { select: { email: true } } },
  });
  const token = widgetToken(project.id, verified.userId);
  jar.set(WIDGET_READER_COOKIE, token, readerCookie);
  // Their account's id (whose conversation the docs' assistant shows), and the email the customer's
  // app gave, if any (what "Ask a person" starts with).
  // `named`: their app gave their name this time (Home greets them by it).
  return { id: verified.userId, token, name: user.name, named: verified.named, email: user.ssoIdentity?.email ?? null };
}

/** The news of the ideas of the person a widget token is for (Home's "Your ideas"); none for a token that doesn't check out. */
export async function widgetIdeaNews(projectSlug: string, token: string): Promise<IdeaNews[]> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  const userId = project && widgetUser(project.id, String(token));
  return project && userId ? ideaNews(project.id, userId) : [];
}

/** Posts feedback from the widget as the person its token is for (like the portal's createPost). */
export async function widgetCreatePost(projectSlug: string, token: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const value = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : undefined;
  };
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  const userId = project && token && (await widgetPerson(project.id, token));
  if (!project || !userId) {
    return { error: "Sign in to post feedback" };
  }
  try {
    await call(createPostOperation, { actor: { kind: "user", userId }, projectId: project.id }, {
      board: value("boardSlug") ?? "",
      title: value("title") ?? "",
      content: value("content") || undefined,
      body: value("body"),
    });
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  return {};
}

/**
 * Who the widget acts for: the person its token is for, else (on the portal's own site, where its
 * cookies come along) the portal's signed-in user; either only while they may act in the project, as
 * the portal's actions check (a token outlives a reader's access to a private portal).
 */
async function widgetPerson(projectId: string, token: string | null): Promise<string | null> {
  const userId = token ? widgetUser(projectId, String(token)) : (await getSession())?.user.id;
  return userId && (await canActIn(userId, projectId)) ? userId : null;
}

/**
 * The widget's ideas, across the project's boards: the trending ones not done yet, or `mine`, those
 * its person (widgetPerson) posted or voted for, every status, newest first; with whether they voted
 * for each. Nothing on a private portal whoever's asking may not read.
 */
export async function widgetIdeas(projectSlug: string, token: string | null, mine = false) {
  const project = await readableProject(projectSlug);
  const userId = project && (await widgetPerson(project.id, token));
  if (!project || (mine && !userId)) {
    return [];
  }
  const filters = parsePostFilters({}, TEAM_SORTS, mine ? "new" : "trending");
  const { posts } = await boardPosts({ projectId: project.id }, filters, userId ?? undefined, { statuses: mine ? undefined : ACTIVE_STATUSES, mine: mine === true });
  return posts.map((post) => ({
    id: post.id,
    number: post.number,
    title: post.title,
    status: post.status,
    voteCount: post.voteCount,
    board: post.board,
    voted: post.votes.length > 0,
  }));
}

export type WidgetIdea = Awaited<ReturnType<typeof widgetIdeas>>[number];

/** Votes for an idea from the widget, or takes the vote back, as its person (widgetPerson); with the idea's votes after. */
export async function widgetVote(projectSlug: string, token: string | null, postId: string, voted: boolean): Promise<{ votes?: number; error?: string }> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  const userId = project && (await widgetPerson(project.id, token));
  if (!project || !userId) {
    return { error: "Sign in to vote" };
  }
  try {
    const context = { actor: { kind: "user", userId }, projectId: project.id } as const;
    return { votes: (await call(setVote, context, { number: await postNumberOf(project.id, postId), voted: voted === true })).votes };
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/**
 * Saves the launcher settings form: name, colour, corner, quick links and icon (see widget.update). Empty
 * link rows are skipped; without the icon's fields (locked for want of the plan), the icon stays as it is.
 */
export async function saveWidgetSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (field: FormDataEntryValue | null | undefined) => (typeof field === "string" ? field : "");
  const input = {
    label: text(formData.get("label")),
    color: text(formData.get("color")),
    position: text(formData.get("position")) as "bottom-right" | "bottom-left",
    links: linksFrom(formData, "link"),
    ...(formData.has("icon") && { icon: text(formData.get("icon")) as WidgetIcon, iconImage: text(formData.get("iconImage")) || null }),
  };
  return asAdmin(projectSlug, "Only project owners and admins can change the widget", (context) =>
    call(updateWidgetSettings, context, input),
  );
}
