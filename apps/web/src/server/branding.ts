"use server";

import { linksFrom } from "@/lib/forms";

import type { FormState } from "./form-state";
import type { LicenseCheck } from "./license-renewal";
import { updateBranding } from "./operations/branding";
import { checkLicense } from "./operations/license";
import { asAdmin, call } from "./operations/run";

/** Saves the Branding card in Settings (see branding.update): an empty image field removes that image, empty link rows are skipped. */
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
  };
  return asAdmin(projectSlug, "Only project owners and admins can change the branding", (context) =>
    call(updateBranding, context, input),
  );
}

/** Check now in the licence dialog (see license.check): what tuti.so said, and until when the project is licensed. */
export async function checkBrandingLicense(projectSlug: string): Promise<{ error?: string; status?: LicenseCheck; licensedUntil?: Date | null }> {
  let result: { status: LicenseCheck; licensedUntil: Date | null } | undefined;
  const state = await asAdmin(projectSlug, "Only project owners and admins can check the licence", async (context) => {
    result = await call(checkLicense, context, {});
  });
  return { ...state, ...result };
}
