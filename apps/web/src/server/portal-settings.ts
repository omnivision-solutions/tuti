"use server";

import { siteFormAddress } from "@/lib/site-mounts";

import type { FormState } from "./form-state";
import { removeDomain, setDomain, verifyDomain } from "./operations/domain";
import { removeSite, setSite, verifySite } from "./operations/site";
import { addPortalReaders as addPortalReadersOperation, type PortalHomePage, removePortalReader as removePortalReaderOperation, updatePortal } from "./operations/portal";
import { OperationError } from "./operations/define";
import { asAdmin, call } from "./operations/run";

const DENIED = "Only project owners and admins can change who sees the portal";

/** Settings → Portal access (see portal.update). */
export async function setPortalAccess(projectSlug: string, access: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) =>
    call(updatePortal, context, { access: access as "public" | "private" }),
  );
}

/** Customize → Home page (see portal.update). */
export async function setPortalHome(projectSlug: string, home: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change the portal's home page", (context) =>
    call(updatePortal, context, { home: home as PortalHomePage }),
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

const DOMAIN_DENIED = "Only project owners and admins can change the portal's domain";

/** Customize → Address (see domain.set, domain.verify and domain.remove). */
export async function saveCustomDomain(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, DOMAIN_DENIED, (context) => call(setDomain, context, { hostname: String(formData.get("hostname") ?? "") }));
}

export async function verifyCustomDomain(projectSlug: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DOMAIN_DENIED, (context) => call(verifyDomain, context, {}));
}

export async function removeCustomDomain(projectSlug: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DOMAIN_DENIED, (context) => call(removeDomain, context, {}));
}

const SITE_DENIED = "Only project owners and admins can change where the portal is on your site";

/**
 * Customize → Address → Sub-folder (see site.set, site.verify and site.remove): the address as one
 * `url`, or the site and the path as two fields (`site`, `path`), put together.
 */
export async function saveSite(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => String(formData.get(name) ?? "");
  const address = formData.has("url") ? { url: field("url") } : siteFormAddress(field("site"), field("path"));
  return asAdmin(projectSlug, SITE_DENIED, async (context) => {
    if ("error" in address) {
      throw new OperationError(400, "invalid_input", address.error);
    }
    return call(setSite, context, { url: address.url });
  });
}

export async function verifySiteSetup(projectSlug: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, SITE_DENIED, (context) => call(verifySite, context, {}));
}

export async function removeSiteMount(projectSlug: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, SITE_DENIED, (context) => call(removeSite, context, {}));
}
