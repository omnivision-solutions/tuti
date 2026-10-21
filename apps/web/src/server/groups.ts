"use server";

import type { FormState } from "./form-state";
import { createGroup, deleteGroup as deleteGroupOperation, updateGroup } from "./operations/groups";
import { asAdmin, call } from "./operations/run";

/** Settings → Groups (see the groups.* operations). */

const DENIED = "Only project owners and admins can change the groups";

/** Adds a group (`claim` null) or changes group `claim`: its name, claim and description. */
export async function saveGroup(projectSlug: string, claim: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    name: String(formData.get("name") ?? ""),
    // Left empty on a new one: from the name.
    claim: String(formData.get("claim") ?? "") || undefined,
    description: String(formData.get("description") ?? ""),
  };
  return asAdmin(projectSlug, DENIED, (context) =>
    claim === null ? call(createGroup, context, input) : call(updateGroup, context, { group: String(claim), ...input }),
  );
}

export async function deleteGroup(projectSlug: string, claim: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(deleteGroupOperation, context, { group: String(claim) }));
}
