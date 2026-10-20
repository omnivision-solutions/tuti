"use server";

import type { FormState } from "./form-state";
import { addPortalReaders as addPortalReadersOperation, removePortalReader as removePortalReaderOperation, updatePortal } from "./operations/portal";
import { asAdmin, call } from "./operations/run";

const DENIED = "Only project owners and admins can change who sees the portal";

/** Settings → Portal access (see portal.update). */
export async function setPortalAccess(projectSlug: string, access: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) =>
    call(updatePortal, context, { access: access as "public" | "private" }),
  );
}

/** Settings → Portal access → Readers: the form's addresses and domains, separated by commas, spaces or lines (see portalReaders.add). */
export async function addPortalReaders(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState & { added?: string[]; emailed?: number }> {
  const emails = String(formData.get("emails") ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  let result: { added: string[]; emailed: number } | undefined;
  const state = await asAdmin(projectSlug, DENIED, async (context) => {
    result = await call(addPortalReadersOperation, context, { emails });
  });
  return { ...state, added: result?.added, emailed: result?.emailed };
}

export async function removePortalReader(projectSlug: string, email: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) => call(removePortalReaderOperation, context, { email: String(email) }));
}
