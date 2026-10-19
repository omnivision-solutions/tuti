"use server";

import { redirect } from "next/navigation";

import type { FormState } from "./form-state";
import {
  createChangelogEntry,
  deleteChangelogEntry as deleteOperation,
  draftChangelogEntry as draftOperation,
  publishChangelogEntry as publishOperation,
  unpublishChangelogEntry as unpublishOperation,
  updateChangelogEntry,
} from "./operations/changelog";
import { asTeam, call } from "./operations/run";

/** The team's changelog actions (see the changelog.* operations). */

const DENIED = "Only the project's team can write the changelog";

/** Saves the editor's form: a new draft when `number` is null (then opens it), or changes to entry `number`. */
export async function saveChangelogEntry(
  projectSlug: string,
  number: number | null,
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const input = {
    title: String(formData.get("title") ?? ""),
    content: formData.get("content") || undefined,
    body: formData.get("content") ? undefined : "",
    tags: formData.getAll("tags").map(String) as ("new" | "improved" | "fixed" | "breaking")[],
    // Published entries show their posts read-only, so the form doesn't send them.
    posts: formData.has("postsEditable") ? formData.getAll("posts").map(Number) : undefined,
  };
  let created: number | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    if (number === null) {
      created = (await call(createChangelogEntry, context, input)).number;
    } else {
      await call(updateChangelogEntry, context, { number, ...input });
    }
  });
  if (created !== undefined) {
    redirect(`/app/${projectSlug}/changelog/${created}`);
  }
  return result;
}

/** Replaces a draft's text with an AI draft (see changelog.draft). */
export async function draftChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(draftOperation, context, { number: Number(number) }));
}

export async function publishChangelogEntry(projectSlug: string, number: number, announce = true): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(publishOperation, context, { number: Number(number), announce: announce === true }),
  );
}

export async function unpublishChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(unpublishOperation, context, { number: Number(number) }));
}

export async function deleteChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(deleteOperation, context, { number: Number(number) }));
  if (!result.error) {
    redirect(`/app/${projectSlug}/changelog`);
  }
  return result;
}
