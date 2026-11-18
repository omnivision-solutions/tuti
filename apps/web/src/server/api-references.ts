"use server";

import type { FormState } from "./form-state";
import {
  deleteApiReference as deleteOperation,
  replaceApiReference as replaceOperation,
  updateApiReference,
} from "./operations/api-references";
import { asTeam, call } from "./operations/run";

/** The team's actions on an API reference's page (see the apiReferences.* operations). */

const DENIED = "Only the project's team can edit the docs";

/** A switch on Endpoints: operation or group `key` on or off the help center. */
export async function setApiReferenceShown(projectSlug: string, slug: string, what: "operation" | "group", key: string, on: boolean): Promise<FormState> {
  const keys = [String(key)];
  return asTeam(projectSlug, DENIED, (context) =>
    call(updateApiReference, context, { slug: String(slug), ...(what === "group" ? (on ? { showGroups: keys } : { hideGroups: keys }) : on ? { show: keys } : { hide: keys }) }),
  );
}

/** The team has opened Endpoints and seen operations `keys` as new: they aren't any more. What a read added since still is. */
export async function markApiReferenceSeen(projectSlug: string, slug: string, keys: string[]): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(updateApiReference, context, { slug: String(slug), seen: Array.isArray(keys) ? keys.map(String) : [] }));
}

/** "Unpublish" and "Publish" under More. */
export async function setApiReferencePublished(projectSlug: string, slug: string, published: boolean): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(updateApiReference, context, { slug: String(slug), published: published === true }));
}

/**
 * "Upload new version": the form's `spec` file replaces the reference's spec. Says how many operations the new
 * one added and removed, and whether anything changed, for the toast.
 */
export async function replaceApiReferenceSpec(projectSlug: string, slug: string, formData: FormData): Promise<FormState & { added?: number; removed?: number; changed?: boolean }> {
  const file = formData.get("spec");
  let changes = {};
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    ({ changes } = await call(replaceOperation, context, { slug: String(slug), spec: typeof file === "string" ? file : ((await file?.text()) ?? "") }));
  });
  return result.error ? result : changes;
}

export async function deleteApiReference(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteOperation, context, { slug: String(slug) }));
}
