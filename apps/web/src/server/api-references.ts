"use server";

import type { FormState } from "./form-state";
import {
  deleteApiReference as deleteOperation,
  getApiReference,
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

/** The team has opened Endpoints: nothing there is new any more. */
export async function markApiReferenceSeen(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(updateApiReference, context, { slug: String(slug), seen: true }));
}

/** "Unpublish" and "Publish" under More. */
export async function setApiReferencePublished(projectSlug: string, slug: string, published: boolean): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(updateApiReference, context, { slug: String(slug), published: published === true }));
}

/**
 * "Upload new version": the form's `spec` file replaces the reference's spec. Says how many operations the new
 * one added and removed (by their keys), for the toast.
 */
export async function replaceApiReferenceSpec(projectSlug: string, slug: string, formData: FormData): Promise<FormState & { added?: number; removed?: number }> {
  const file = formData.get("spec");
  const counts = { added: 0, removed: 0 };
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    const keys = async () => new Set((await call(getApiReference, context, { slug: String(slug) })).operations.map((operation) => operation.key));
    const before = await keys();
    await call(replaceOperation, context, { slug: String(slug), spec: typeof file === "string" ? file : ((await file?.text()) ?? "") });
    const after = await keys();
    counts.added = [...after].filter((key) => !before.has(key)).length;
    counts.removed = [...before].filter((key) => !after.has(key)).length;
  });
  return result.error ? result : counts;
}

export async function deleteApiReference(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteOperation, context, { slug: String(slug) }));
}
