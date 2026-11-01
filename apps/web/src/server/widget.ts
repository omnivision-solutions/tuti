"use server";

import { prisma } from "@tuti/db";
import { cookies } from "next/headers";

import { linksFrom } from "@/lib/forms";
import type { WidgetIcon } from "@/lib/widget-icons";
import { widgetToken, widgetUser } from "@/lib/widget-session";
import { verifySsoToken } from "@/lib/sso";

import type { FormState } from "./form-state";
import { createPost as createPostOperation } from "./operations/create";
import { OperationError } from "./operations/define";
import { asAdmin, call } from "./operations/run";
import { WIDGET_READER_COOKIE } from "./portal-access";
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
  const userId = project && widgetUser(project.id, token);
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
