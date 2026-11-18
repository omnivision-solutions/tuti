"use server";

import { AI_ROLE_NAMES } from "@tuti/shared";

import type { FormState } from "./form-state";
import { updateAiModels } from "./operations/ai-models";
import { asAdmin, call } from "./operations/run";

/** Saves Settings → AI models (see aiModels.update): each role's model id sent, empty for the default; a role not sent keeps its model. */
export async function saveAiModels(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const input = Object.fromEntries(
    AI_ROLE_NAMES.flatMap((feature) => {
      const field = formData.get(feature);
      return typeof field === "string" ? [[feature, field]] : [];
    }),
  );
  return asAdmin(projectSlug, "Only project owners and admins can change AI models", (context) => call(updateAiModels, context, input));
}

/** Saves a settings page's "AI model" setting as it's changed (see aiModels.update): its group's level, or the model of one of its roles. */
export async function saveAiModel(projectSlug: string, input: Parameters<typeof updateAiModels.run>[1]): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change AI models", (context) => call(updateAiModels, context, input));
}
