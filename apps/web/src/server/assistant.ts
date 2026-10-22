"use server";

import type { FormState } from "./form-state";
import { type AssistantLength, confirmSupportEmailToken, updateAssistantSettings } from "./operations/assistant";
import { asAdmin, call } from "./operations/run";

/** Saves the AI answers card in Settings (see assistant.update): off-limits topics one per line, empty lines skipped. */
export async function saveAssistantSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : "";
  };
  const input = {
    tone: text("tone"),
    length: text("length") as AssistantLength,
    instructions: text("instructions"),
    offLimits: text("offLimits")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
  return asAdmin(projectSlug, "Only project owners and admins can change AI answers", (context) =>
    call(updateAssistantSettings, context, input),
  );
}

/** Saves the support email in Customize → AI answers (see assistant.update): a new address gets a confirmation link; empty turns "Ask a person" off. */
export async function saveSupportEmail(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const field = formData.get("supportEmail");
  return asAdmin(projectSlug, "Only project owners and admins can change AI answers", (context) =>
    call(updateAssistantSettings, context, { supportEmail: typeof field === "string" ? field : "" }),
  );
}

/**
 * "Confirm" on the page a support email confirmation link opens (/support-email). The emailed token
 * is the permission: whoever reads the address's mail may confirm it, signed in or not.
 */
export async function confirmSupportEmail(token: string): Promise<{ error: string } | { address: string; projectName: string }> {
  return (
    (await confirmSupportEmailToken(String(token))) ?? {
      error: "This link doesn't work any more: it was used, or a newer one was sent. Ask the team to send a new one.",
    }
  );
}
