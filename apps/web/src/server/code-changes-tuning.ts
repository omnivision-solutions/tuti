"use server";

import { TUNING_KEYS, tuningRange } from "@tuti/shared";

import type { FormState } from "./form-state";
import { updateCodeChangesTuning } from "./operations/code-changes-tuning";
import { asOwner, call } from "./operations/run";

/**
 * Saves Autopilot's Advanced tuning (see codeChangesTuning.update): each value sent, as a number (a probability in
 * percent on the form) or one of its options; "" for the server's. A value not sent keeps its own.
 */
export async function saveCodeChangesTuning(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const input = Object.fromEntries(
    TUNING_KEYS.flatMap((key) => {
      const field = formData.get(key);
      if (typeof field !== "string") {
        return [];
      }
      const text = field.trim();
      const number = Number(text);
      const percent = tuningRange(key).kind === "probability";
      return [[key, text === "" ? null : Number.isFinite(number) ? (percent ? number / 100 : number) : text]];
    }),
  );
  return asOwner(projectSlug, "Only project owners can change Autopilot's tuning", (context) => call(updateCodeChangesTuning, context, input));
}
