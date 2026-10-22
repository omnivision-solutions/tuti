"use server";

import { linksFrom } from "@/lib/forms";

import type { FormState } from "./form-state";
import type { LicenseCheck } from "./license-renewal";
import { updateBranding } from "./operations/branding";
import { checkLicense } from "./operations/license";
import { asAdmin, call } from "./operations/run";

/**
 * Saves one part of the branding from Customize (see branding.update), named by the form's `part`: its
 * look (logos, favicon, colour; an empty image field removes that image), its links (empty rows are
 * skipped) or "Powered by". The other parts stay as they are.
 */
export async function saveBranding(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : "";
  };
  const part = text("part");
  if (part !== "look" && part !== "links" && part !== "poweredBy") {
    return { error: "Unknown branding form" };
  }
  const input =
    part === "links"
      ? { headerLinks: linksFrom(formData, "headerLink"), footerLinks: linksFrom(formData, "footerLink") }
      : part === "poweredBy"
        ? { poweredBy: formData.get("poweredBy") === "on" }
        : { logo: text("logo") || null, logoDark: text("logoDark") || null, favicon: text("favicon") || null, color: text("color") };
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
