"use server";

import { z } from "zod";

import { groupConditions } from "@/lib/group-conditions";
import { readerGroup } from "@/lib/reader-groups";

import type { FormState } from "./form-state";
import { getAdminProject } from "./membership";
import { createGroup, deleteGroup as deleteGroupOperation, ssoReaders, updateGroup, whoMatches } from "./operations/groups";
import { asAdmin, call } from "./operations/run";
import { getSession } from "./session";

/** Settings → Groups (see the groups.* operations). */

const DENIED = "Only project owners and admins can change the groups";

/** The conditions the dialog sends (JSON), checked by the operation: anything else is refused there. */
function conditionsFrom(formData: FormData): unknown {
  try {
    return JSON.parse(String(formData.get("conditions") ?? "[]"));
  } catch {
    return null;
  }
}

/** Adds a group (`key` null) or changes group `key`: its name, claim (empty: none), conditions and description. */
export async function saveGroup(projectSlug: string, key: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    name: String(formData.get("name") ?? ""),
    claim: String(formData.get("claim") ?? "") || null,
    description: String(formData.get("description") ?? ""),
    conditions: conditionsFrom(formData) as z.input<typeof groupConditions>,
  };
  return asAdmin(projectSlug, DENIED, (context) =>
    key === null ? call(createGroup, context, input) : call(updateGroup, context, { group: String(key), ...input }),
  );
}

export async function deleteGroup(projectSlug: string, key: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(deleteGroupOperation, context, { group: String(key) }));
}

const previewInput = z.object({ claim: readerGroup.nullable(), conditions: groupConditions });

/** The group dialog's preview: how many of the project's SSO users a group with these rules would have now, and a few names. */
export async function previewGroup(
  projectSlug: string,
  claim: string | null,
  conditions: z.input<typeof groupConditions>,
): Promise<{ error: string } | { readers: number; sample: string[] }> {
  const [session, project] = await Promise.all([getSession(), getAdminProject(projectSlug)]);
  if (!session || !project) {
    return { error: DENIED };
  }
  const input = previewInput.safeParse({ claim, conditions });
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  return whoMatches(input.data, await ssoReaders(project.id));
}
