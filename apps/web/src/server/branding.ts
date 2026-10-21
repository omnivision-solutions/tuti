"use server";

import { linksFrom } from "@/lib/forms";

import type { FormState } from "./form-state";
import { updateBranding } from "./operations/branding";
import { asAdmin, call } from "./operations/run";

/** Saves the Branding card in Settings (see branding.update): an empty image field removes that image, empty link rows are skipped, an empty licence key keeps the current one. */
export async function saveBranding(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : "";
  };
  const input = {
    logo: text("logo") || null,
    logoDark: text("logoDark") || null,
    favicon: text("favicon") || null,
    color: text("color"),
    headerLinks: linksFrom(formData, "headerLink"),
    footerLinks: linksFrom(formData, "footerLink"),
    poweredBy: formData.get("poweredBy") === "on",
    // Empty keeps the current key.
    licenseKey: text("licenseKey").trim() || undefined,
  };
  return asAdmin(projectSlug, "Only project owners and admins can change the branding", (context) =>
    call(updateBranding, context, input),
  );
}
