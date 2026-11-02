"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { updateEmailPreferences } from "./operations/email-preferences";
import { asAnyone, call } from "./operations/run";

/** One of the signed-in person's email settings on a portal's Account; see the emailPreferences.update operation. */
export async function setEmailPreference(
  projectSlug: string,
  setting: "ownPosts" | "followedPosts" | "unsubscribed",
  on: boolean,
): Promise<FormState> {
  return asAnyone(
    "Sign in first",
    "Project not found",
    () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } }),
    (context) => call(updateEmailPreferences, context, { [String(setting)]: on === true }),
  );
}
