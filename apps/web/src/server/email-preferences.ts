"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { updateEmailPreferences } from "./operations/email-preferences";
import { asAnyone, call } from "./operations/run";

/** One of the signed-in person's email settings on a portal's Account; see the emailPreferences.update operation. */
export async function setEmailPreference(
  projectSlug: string,
  setting: "ownPosts" | "followedPosts" | "unsubscribed" | "changelog",
  on: boolean,
): Promise<FormState & { changelog?: boolean }> {
  const saved: { changelog?: boolean } = {};
  const state = await asAnyone(
    "Sign in first",
    "Project not found",
    () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } }),
    async (context) => {
      saved.changelog = (await call(updateEmailPreferences, context, { [String(setting)]: on === true })).changelog;
    },
  );
  // Stopping the project's emails, or not, changes whether the changelog reaches them (changelogReach): its switch shows it.
  return setting === "unsubscribed" && !state.error ? { ...state, changelog: saved.changelog } : state;
}
