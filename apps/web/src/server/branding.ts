"use server";

import { linksFrom } from "@/lib/forms";
import type { PortalFont } from "@/lib/portal-fonts";
import type { ColorScheme } from "@/lib/portal-look";

import type { FormState } from "./form-state";
import type { LicenseCheck } from "./license-renewal";
import { updateBranding } from "./operations/branding";
import { checkLicense } from "./operations/license";
import { asAdmin, call } from "./operations/run";

/**
 * Saves one part of the branding from Customize (see branding.update), named by the form's `part`: its
 * look (logos, favicon, colour; an empty image field removes that image), its links (empty rows are
 * skipped), "Powered by", content actions, the docs' home, or SEO. The other parts stay as they are.
 */
export async function saveBranding(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : "";
  };
  const part = text("part");
  const on = (name: string) => formData.get(name) === "on";
  const parts = {
    look: () => ({
      logo: text("logo") || null,
      logoDark: text("logoDark") || null,
      favicon: text("favicon") || null,
      color: text("color"),
      // Fields an older form doesn't have stay as they are.
      ...(formData.has("colorScheme") && { colorScheme: text("colorScheme") as ColorScheme }),
      ...(formData.has("logoText") && { logoText: text("logoText") }),
      ...(formData.has("logoLink") && { logoLink: text("logoLink").trim() || null }),
      ...(formData.has("headingFont") && {
        fonts: { heading: (text("headingFont") || null) as PortalFont | null, body: (text("bodyFont") || null) as PortalFont | null },
      }),
    }),
    links: () => ({
      headerLinks: linksFrom(formData, "headerLink"),
      footerLinks: linksFrom(formData, "footerLink"),
      sidebarLinks: linksFrom(formData, "sidebarLink"),
      ...(formData.has("contactUrl") && { contact: text("contactUrl").trim() ? { label: text("contactLabel"), url: text("contactUrl") } : null }),
    }),
    seo: () => ({ seoImage: text("seoImage") || null, seo: { title: text("seoTitle"), description: text("seoDescription") } }),
    poweredBy: () => ({ poweredBy: on("poweredBy") }),
    contentActions: () => ({
      contentActions: { menu: on("menu"), copyMarkdown: on("copyMarkdown"), chatGpt: on("chatGpt"), claude: on("claude"), updatedDate: on("updatedDate") },
    }),
    docsHome: () => ({ docsHome: { title: text("title"), subtitle: text("subtitle"), popular: on("popular") } }),
  };
  if (!Object.hasOwn(parts, part)) {
    return { error: "Unknown branding form" };
  }
  const input = parts[part as keyof typeof parts]();
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
