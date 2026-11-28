"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { markChangelogSeen as markSeenOperation } from "./operations/changelog-seen";
import { asAnyone, call } from "./operations/run";

/**
 * The signed-in person has seen the project's announcements up to `at` (the portal's
 * /changelog, or What's new in the widget on the portal's own site; see changelog.seen).
 * Sent as the page loads, so it doesn't refresh it: a refresh landing while a slow device
 * is still hydrating the page made React render it again, every tag in its head twice.
 * The header's "New" goes once it's recorded (useNewChangelog).
 */
export async function markChangelogSeen(projectSlug: string, at: string): Promise<FormState> {
  return asAnyone(
    "Sign in first",
    "Project not found",
    () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } }),
    (context) => call(markSeenOperation, context, { at: String(at) }),
    { refresh: false },
  );
}
