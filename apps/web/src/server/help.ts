"use server";

import { redirect } from "next/navigation";

import type { FormState } from "./form-state";
import {
  createArticle,
  createCollection,
  deleteArticle as deleteArticleOperation,
  deleteCollection as deleteCollectionOperation,
  publishArticle as publishOperation,
  restoreArticle as restoreOperation,
  unpublishArticle as unpublishOperation,
  updateArticle,
  updateCollection,
} from "./operations/help";
import { dismissHelpGap as dismissGapOperation } from "./operations/help-insights";
import { asTeam, call } from "./operations/run";

/** The team's help center actions (see the articles.* and collections.* operations). */

const DENIED = "Only the project's team can edit the help center";

/** Saves the editor's form: a new draft when `slug` is null, or changes to article `slug`. Opens its new address if it moved. */
export async function saveArticle(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    title: String(formData.get("title") ?? ""),
    content: formData.get("content") || undefined,
    body: formData.get("content") ? undefined : "",
    collection: String(formData.get("collection") ?? "") || null,
    showUpdatedDate: formData.get("showUpdatedDate") === "on",
  };
  let saved: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    saved = (
      slug === null ? await call(createArticle, context, input) : await call(updateArticle, context, { slug: String(slug), ...input })
    ).slug;
  });
  if (saved !== undefined && saved !== slug) {
    redirect(`/app/${projectSlug}/help/${saved}`);
  }
  return result;
}

export async function publishArticle(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(publishOperation, context, { slug: String(slug) }));
}

export async function unpublishArticle(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(unpublishOperation, context, { slug: String(slug) }));
}

export async function deleteArticle(projectSlug: string, slug: string): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(deleteArticleOperation, context, { slug: String(slug) }));
  if (!result.error) {
    redirect(`/app/${projectSlug}/help`);
  }
  return result;
}

/**
 * Restores version `revision` of article `slug`, or the deleted article `slug` (its newest
 * `revision` says which, if several had that slug) as a draft. Returns the article's slug now.
 */
export async function restoreArticle(projectSlug: string, slug: string, revision: string): Promise<FormState & { slug?: string }> {
  let restored: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    restored = (await call(restoreOperation, context, { slug: String(slug), revision: String(revision) })).slug;
  });
  return { ...result, slug: restored };
}

/** Adds a collection (`slug` null) or renames collection `slug` and changes its description. */
export async function saveCollection(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = { name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? "") };
  return asTeam(projectSlug, DENIED, (context) =>
    slug === null ? call(createCollection, context, input) : call(updateCollection, context, { slug: String(slug), ...input }),
  );
}

export async function deleteCollection(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteCollectionOperation, context, { slug: String(slug) }));
}

/** "Dismiss" on a gap in the help center's insights (see help.dismissGap). */
export async function dismissHelpGap(projectSlug: string, question: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(dismissGapOperation, context, { question: String(question) }));
}
