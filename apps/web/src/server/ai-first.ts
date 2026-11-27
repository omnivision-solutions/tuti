"use server";

import type { FormState } from "./form-state";
import { updateAiFirst } from "./operations/ai-first";
import { asAdmin, call } from "./operations/run";

/** Settings → Workflows → AI answers first (aiFirst.update): the widget's and email's switches and the name its emails come from. */
export async function saveAiFirst(projectSlug: string, settings: { widget: boolean; email: boolean; name: string }): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change AI answers first", (context) =>
    call(updateAiFirst, context, { widget: settings?.widget === true, email: settings?.email === true, name: String(settings?.name ?? "") }),
  );
}
