"use server";

import type { FormState } from "./form-state";
import { updateAiModels } from "./operations/ai-models";
import { asAdmin, call } from "./operations/run";
import type { InputOf } from "@/server/operations/define";

/** Saves a settings page's "AI model" setting as it's changed (see aiModels.update): its group's level, or the model of one of its roles ("off" and "" for Autopilot's Checks switch). */
export async function saveAiModel(projectSlug: string, input: InputOf<typeof updateAiModels>): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change AI models", (context) => call(updateAiModels, context, input));
}
