"use server";

import { readStorable } from "@tuti/jobs";
import { redirect } from "next/navigation";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import {
  deleteApiReference as deleteOperation,
  fetched,
  fetchedFromGithub,
  githubSource,
  replaceApiReference as replaceOperation,
  syncApiReference as syncOperation,
  updateApiReference,
} from "./operations/api-references";
import { listGithubRepositories } from "./operations/github";
import { asTeam, call } from "./operations/run";
import type { OutputOf } from "@/server/operations/define";

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

/** "Sync now" on a URL's reference: read it again. Says what changed for the toast, or why the read failed (the page says so too). */
export async function syncApiReferenceNow(projectSlug: string, slug: string): Promise<FormState & { added?: number; removed?: number; changed?: boolean }> {
  let answer: OutputOf<typeof syncOperation> | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    answer = await call(syncOperation, context, { slug: String(slug) });
  });
  if (result.error || !answer) {
    return result;
  }
  // No changes and no reason: another sync finished first (the page shows what it read), or the address changed meanwhile.
  return answer.changes ?? { error: answer.failure ?? "Another sync finished first. The page shows what it read." };
}

/** Settings' Source: the reference is read from `url` from now on, once it's read there (the toast says what that changed). */
export async function changeApiReferenceUrl(projectSlug: string, slug: string, url: string): Promise<FormState & { added?: number; removed?: number; changed?: boolean }> {
  let answer: OutputOf<typeof syncOperation> | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    answer = await call(syncOperation, context, { slug: String(slug), url: String(url) });
  });
  if (result.error || !answer) {
    return result;
  }
  // The address it already had is synced as it is: its failure is said, as Sync now's is.
  return answer.changes ?? { error: answer.failure ?? "Another sync finished first. The page shows what it read." };
}

/**
 * "Fetch" in the add dialog's URL panel: reads the address as adding it would (fetchSpec's limits), for the name it
 * suggests, or says why it can't be added. Nothing is stored.
 */
export async function previewApiReferenceUrl(projectSlug: string, url: string): Promise<FormState & { suggests?: string }> {
  let suggests: string | undefined;
  const address = String(url).trim();
  // As adding it would: refused, not cut short to another address.
  if (address.length > 2000) {
    return { error: "Keep the address to 2,000 characters" };
  }
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    // Refused before anything's fetched, it isn't counted (`fetched`).
    const spec = await fetched(address, context);
    const read = readStorable(spec.text, spec.url);
    if ("error" in read) {
      throw new OperationError(400, "invalid_input", read.error);
    }
    suggests = read.doc.title || new URL(address).hostname;
  });
  return result.error ? result : { suggests };
}

/**
 * Settings' Source: the reference is read from this file on GitHub from now on, once it's read there. Only the parts
 * given change (the repository, path or branch the team typed); the rest stay as the reference has them now.
 */
export async function changeApiReferenceGithub(
  projectSlug: string,
  slug: string,
  source: { repoId?: number; path?: string; ref?: string },
): Promise<FormState & { added?: number; removed?: number; changed?: boolean }> {
  let answer: OutputOf<typeof syncOperation> | undefined;
  const { repoId, path, ref } = source ?? {};
  const github = { ...(repoId !== undefined && { repoId: Number(repoId) }), ...(path !== undefined && { path: String(path) }), ...(ref !== undefined && { ref: String(ref) }) };
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    answer = await call(syncOperation, context, { slug: String(slug), github });
  });
  if (result.error || !answer) {
    return result;
  }
  return answer.changes ?? { error: answer.failure ?? "Another sync finished first. The page shows what it read." };
}

/** The add dialog's GitHub panel: the repositories the project added (githubRepositories.list), to pick one. */
export async function listApiReferenceRepositories(projectSlug: string): Promise<FormState & { repositories?: { id: number; fullName: string }[] }> {
  let repositories: { id: number; fullName: string }[] | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    ({ repositories } = await call(listGithubRepositories, context, {}));
  });
  return result.error ? result : { repositories };
}

/**
 * "Fetch" in the add dialog's GitHub panel: reads the file as adding it would (one of the project's repositories, 5 MB),
 * for the name it suggests and the branch it read (the repository's default one when none is given), or says why it
 * can't be added. Nothing is stored. The repositories to pick from are githubRepositories.list's.
 */
export async function previewApiReferenceGithub(
  projectSlug: string,
  source: { repoId: number; path: string; ref?: string },
): Promise<FormState & { suggests?: string; ref?: string }> {
  let answer: { suggests: string; ref: string } | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    // As adding it would check it, before anything's read.
    const checked = githubSource.safeParse({ repoId: Number(source?.repoId), path: String(source?.path ?? ""), ...(source?.ref ? { ref: String(source.ref) } : {}) });
    if (!checked.success) {
      throw new OperationError(400, "invalid_input", checked.error.issues[0]?.message ?? "Invalid input");
    }
    const file = await fetchedFromGithub(checked.data, context);
    const read = readStorable(file.text);
    if ("error" in read) {
      throw new OperationError(400, "invalid_input", read.error);
    }
    answer = { suggests: read.doc.title || checked.data.path.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), ref: file.ref };
  });
  return result.error ? result : answer!;
}

export async function deleteApiReference(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteOperation, context, { slug: String(slug) }));
}

/** What Settings changed: only those go to apiReferences.update, which checks each. */
export type ApiReferenceSettings = {
  name?: string;
  newSlug?: string;
  baseUrl?: string | null;
  treeStyle?: "folders" | "headings" | "entry";
  groupOrder?: string[];
  tryIt?: boolean;
};

/** Settings' Save, and its controls that save as they change. A new slug goes to Settings at the new address. */
export async function saveApiReferenceSettings(projectSlug: string, slug: string, changes: ApiReferenceSettings): Promise<FormState> {
  const { name, newSlug, baseUrl, treeStyle, groupOrder, tryIt } = changes ?? {};
  let saved: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    ({ slug: saved } = await call(updateApiReference, context, { slug: String(slug), name, newSlug, baseUrl, treeStyle, groupOrder, tryIt }));
  });
  // A new address leaves none at the old one: its Settings are at the new one.
  if (saved !== undefined && saved !== slug) {
    redirect(`/app/${projectSlug}/docs/references/${saved}/settings`);
  }
  return result;
}
