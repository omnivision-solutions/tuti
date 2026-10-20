"use server";

import { updatePortal } from "./operations/portal";
import { asAdmin, call } from "./operations/run";

/** Settings → Portal access (see portal.update). */
export async function setPortalAccess(projectSlug: string, access: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change who sees the portal", (context) =>
    call(updatePortal, context, { access: access as "public" | "private" }),
  );
}
