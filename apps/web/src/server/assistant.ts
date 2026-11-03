"use server";

import type { FormState } from "./form-state";
import { type AssistantLength, updateAssistantSettings } from "./operations/assistant";
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
