import type { LicenseCheck } from "@/server/license-renewal";

const CHECKED: Record<Exclude<LicenseCheck, "licensed">, string> = {
  not_licensed: "No licence for this project yet. Once you've bought one, check again.",
  in_use: "This project's licence is in use on another installation of Tuti. Email hello@tuti.so to move it here.",
  unreachable: "Couldn't reach tuti.so. Try again in a few minutes.",
  busy: "Checked a moment ago. Try again in a minute.",
};

/** When the check itself failed (the server action threw). */
export const LICENSE_UNREACHABLE = CHECKED.unreachable;

/**
 * What Check now in Customize → Powered by found: the badge can be hidden only when tuti.so just
 * said the project is licensed. A key still valid from before (tuti.so unreachable, or checked a
 * moment ago) keeps an already hidden badge hidden, but doesn't hide it from the dialog.
 */
export function licenseCheckOutcome(result: {
  error?: string;
  status?: LicenseCheck;
  licensedUntil?: Date | null;
}): { licensedUntil: Date } | { message: string } {
  if (result.status === "licensed" && result.licensedUntil) {
    return { licensedUntil: result.licensedUntil };
  }
  return { message: result.error ?? CHECKED[result.status === "licensed" || !result.status ? "unreachable" : result.status] };
}
