"use server";

import { AI_FEATURES } from "@tuti/shared";

import type { FormState } from "./form-state";
import { updateAiModels } from "./operations/ai-models";
import { asAdmin, call } from "./operations/run";

/** Saves Settings → AI models (see aiModels.update): each feature's model id, empty for the default. */
export async function saveAiModels(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const input = Object.fromEntries(
    AI_FEATURES.map((feature) => {
      const field = formData.get(feature);
      return [feature, typeof field === "string" ? field : ""];
    }),
  );
  return asAdmin(projectSlug, "Only project owners and admins can change AI models", (context) => call(updateAiModels, context, input));
}
