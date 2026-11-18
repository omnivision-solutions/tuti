"use server";

import type { FormState } from "./form-state";
import { type AssistantLength, updateAssistantSettings } from "./operations/assistant";
import { asAdmin, call } from "./operations/run";

/** Saves the AI answers form in Settings (see assistant.update): an `offLimits` field per topic, empty ones skipped. No tone: it's part of the instructions. */
export async function saveAssistantSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : "";
  };
  const input = {
    length: text("length") as AssistantLength,
    // A form sends a textarea's line breaks as CRLF: stored as the box shows and counts them.
    instructions: text("instructions").replace(/\r\n/g, "\n"),
    offLimits: formData
      .getAll("offLimits")
      .map((topic) => (typeof topic === "string" ? topic.trim() : ""))
      .filter(Boolean),
  };
  return asAdmin(projectSlug, "Only project owners and admins can change AI answers", (context) =>
    call(updateAssistantSettings, context, input),
  );
}
