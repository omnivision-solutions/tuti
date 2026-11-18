import { notFound, redirect } from "next/navigation";

import { getMembership } from "@/server/membership";
import { OperationError } from "@/server/operations";
import { getApiReference } from "@/server/operations/api-references";
import { call } from "@/server/operations/run";
import { getSession } from "@/server/session";

/** The reference its Endpoints and Settings show, as the team sees it (apiReferences.get). */
export async function loadReference(slug: string, referenceSlug: string) {
  const [session, membership] = await Promise.all([getSession(), getMembership(slug)]);
  if (!session || !membership) {
    notFound();
  }
  return call(getApiReference, { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id }, { slug: referenceSlug }).catch((error: unknown) => {
    if (error instanceof OperationError) {
      // Deleted (here too, under More), or its address changed: the docs.
      redirect(`/app/${slug}/docs`);
    }
    throw error;
  });
}
