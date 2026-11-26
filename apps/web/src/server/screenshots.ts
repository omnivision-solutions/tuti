"use server";

import type { FormState } from "./form-state";
import { asAdmin, call } from "./operations/run";
import { testScreenshotSettings, updateScreenshotSettings } from "./operations/screenshots";

const DENIED = "Only project owners and admins can change screenshots";

/** Saves Settings → Screenshots (screenshotSettings.update): only the picked sign-in's fields; a password or sign-in link left empty keeps the saved one. */
export async function saveScreenshotSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : undefined;
  };
  const signIn = text("signIn") as "none" | "password" | "link" | undefined;
  // The form keeps every sign-in's fields: only the one picked is sent (what's typed in the others is left behind).
  const input = {
    appUrl: text("appUrl") ?? "",
    signIn,
    username: signIn === "password" ? text("username") : undefined,
    password: signIn === "password" ? text("password") : undefined,
    signInLink: signIn === "link" ? text("signInLink") : undefined,
    about: text("about")?.replace(/\r\n/g, "\n"),
    window: text("window") as "desktop" | "phone" | undefined,
    // A checkbox: sent only when it's on.
    residentialProxy: formData.get("residentialProxy") === "on",
  };
  return asAdmin(projectSlug, DENIED, (context) => call(updateScreenshotSettings, context, input));
}

/** Settings → Screenshots' Test (screenshotSettings.test): the agent signs in and takes the screen it lands on, in the background. */
export async function testScreenshots(projectSlug: string): Promise<{ error?: string }> {
  return asAdmin(projectSlug, DENIED, (context) => call(testScreenshotSettings, context, {}));
}
