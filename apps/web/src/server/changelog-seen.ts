"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { markChangelogSeen as markSeenOperation } from "./operations/changelog-seen";
import { asAnyone, call } from "./operations/run";

/**
 * The signed-in person has seen the project's announcements up to `at` (the portal's
 * /changelog, or What's new in the widget on the portal's own site; see changelog.seen).
 */
export async function markChangelogSeen(projectSlug: string, at: string): Promise<FormState> {
  return asAnyone(
    "Sign in first",
    "Project not found",
    () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } }),
    (context) => call(markSeenOperation, context, { at: String(at) }),
  );
}
