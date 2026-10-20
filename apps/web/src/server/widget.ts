"use server";

import { prisma } from "@tuti/db";

import { linksFrom } from "@/lib/forms";
import { widgetToken, widgetUser } from "@/lib/widget-session";
import { verifySsoToken } from "@/lib/sso";

import type { FormState } from "./form-state";
import { createPost as createPostOperation } from "./operations/create";
import { OperationError } from "./operations/define";
import { asAdmin, call } from "./operations/run";
import { updateWidgetSettings } from "./operations/widget";

/**
 * The widget's actions: on customers' sites (see lib/widget-session.ts for its
 * tokens), and the team's launcher settings.
 */

/** Trades an SSO token from the project's own app for a widget token, and says who signed in. */
export async function widgetSignIn(
  projectSlug: string,
  ssoToken: string,
): Promise<{ token: string; name: string } | { error: string }> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, ssoSecret: true } });
  if (!project?.ssoSecret) {
    return { error: "Single sign-on isn't set up for this project" };
  }
  const verified = await verifySsoToken({ id: project.id, ssoSecret: project.ssoSecret }, String(ssoToken).slice(0, 8192));
  if ("error" in verified) {
    return { error: "Couldn't sign you in" };
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: verified.userId }, select: { name: true } });
  return { token: widgetToken(project.id, verified.userId), name: user.name };
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

/** Saves the launcher settings form: label, colour, corner and quick links (see widget.update). Empty link rows are skipped. */
export async function saveWidgetSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (field: FormDataEntryValue | null | undefined) => (typeof field === "string" ? field : "");
  const input = {
    label: text(formData.get("label")),
    color: text(formData.get("color")),
    position: text(formData.get("position")) as "bottom-right" | "bottom-left",
    links: linksFrom(formData, "link"),
  };
  return asAdmin(projectSlug, "Only project owners and admins can change the widget", (context) =>
    call(updateWidgetSettings, context, input),
  );
}
