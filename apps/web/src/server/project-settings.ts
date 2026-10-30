"use server";

import { revalidatePath } from "next/cache";

import type { FormState } from "./form-state";
import { updateProject } from "./operations/more";
import { asAdmin, call } from "./operations/run";

/** Saves Settings → General (see project.update): the project's name. */
export async function renameProject(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const result = await asAdmin(projectSlug, "Only project owners and admins can rename the project", (context) =>
    call(updateProject, context, { name: String(formData.get("name") ?? "") }),
  );
  if (!result.error) {
    // The name is in the sidebar's project switcher, on every page.
    revalidatePath("/app", "layout");
  }
  return result;
}
