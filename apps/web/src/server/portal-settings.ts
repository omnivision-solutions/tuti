"use server";

import { siteFormAddress } from "@/lib/site-mounts";

import type { FormState } from "./form-state";
import { removeDomain, setDomain, verifyDomain } from "./operations/domain";
import { createRedirect, deleteRedirect } from "./operations/redirects";
import { removeSite, setSite, verifySite } from "./operations/site";
import { OperationError } from "./operations/define";
import { asAdmin, call } from "./operations/run";

const DOMAIN_DENIED = "Only project owners and admins can change the portal's domain";

/** Settings → Domain (see domain.set, domain.verify and domain.remove). */
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
 * Settings → Domain → Sub-folder (see site.set, site.verify and site.remove): the address as one
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

const REDIRECTS_DENIED = "Only project owners and admins can change the portal's redirects";

/** Settings → Domain → Redirects: adds one (see redirects.create). */
export async function saveRedirect(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, REDIRECTS_DENIED, (context) =>
    call(createRedirect, context, { from: String(formData.get("from") ?? ""), to: String(formData.get("to") ?? "") }),
  );
}

/** Settings → Domain → Redirects: deletes one (see redirects.delete). */
export async function removeRedirect(projectSlug: string, id: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, REDIRECTS_DENIED, (context) => call(deleteRedirect, context, { id: String(id) }));
}
