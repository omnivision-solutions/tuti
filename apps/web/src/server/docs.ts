"use server";

import { redirect } from "next/navigation";

import type { Listing } from "@/lib/article-listing";

import type { FormState } from "./form-state";
import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle as deleteArticleOperation,
  deleteCollection as deleteCollectionOperation,
  deleteTab as deleteTabOperation,
  discardChanges as discardChangesOperation,
  publishArticle as publishOperation,
  publishChanges as publishChangesOperation,
  reorderArticle,
  reorderCollection,
  reorderTab,
  restoreArticle as restoreOperation,
  unpublishArticle as unpublishOperation,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { dismissDocsGap as dismissGapOperation } from "./operations/docs-insights";
import { asTeam, call } from "./operations/run";

/** The team's docs actions (see the articles.*, collections.* and tabs.* operations). */

const DENIED = "Only the project's team can edit the docs";

/** Saves the editor's form: a new draft when `slug` is null, or changes to article `slug`. Opens its new address if it moved. */
export async function saveArticle(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    title: String(formData.get("title") ?? ""),
    content: formData.get("content") || undefined,
    body: formData.get("content") ? undefined : "",
    collection: String(formData.get("collection") ?? "") || null,
    showUpdatedDate: formData.get("showUpdatedDate") === "on",
    // Checked by the operation (an unknown listing is a 400).
    listing: (formData.get("listing") || undefined) as Listing | undefined,
  };
  let saved: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    saved = (
      slug === null ? await call(createArticle, context, input) : await call(updateArticle, context, { slug: String(slug), ...input })
    ).slug;
  });
  if (saved !== undefined && saved !== slug) {
    redirect(`/app/${projectSlug}/docs/${saved}`);
  }
  return result;
}

export async function publishArticle(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(publishOperation, context, { slug: String(slug) }));
}

/** "Publish changes": a published article's unpublished changes go live, if they're still those saved at `savedAt` (the ones reviewed). */
export async function publishArticleChanges(projectSlug: string, slug: string, savedAt?: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(publishChangesOperation, context, { slug: String(slug), savedAt: savedAt === undefined ? undefined : String(savedAt) }),
  );
}

/** "Discard changes": back to the published version, if the changes are still those saved at `savedAt`. */
export async function discardArticleChanges(projectSlug: string, slug: string, savedAt?: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(discardChangesOperation, context, { slug: String(slug), savedAt: savedAt === undefined ? undefined : String(savedAt) }),
  );
}

export async function unpublishArticle(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(unpublishOperation, context, { slug: String(slug) }));
}

export async function deleteArticle(projectSlug: string, slug: string): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(deleteArticleOperation, context, { slug: String(slug) }));
  if (!result.error) {
    redirect(`/app/${projectSlug}/docs`);
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

/**
 * Adds a collection (`slug` null), in the one the form's `parent` names if any, else in the form's
 * `tab` (if the docs have tabs), or renames collection `slug` and changes its description.
 */
export async function saveCollection(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    // The ticked groups' claims, checked by the operation.
    groups: formData.getAll("groups").map(String),
    // A Lucide icon's name; empty for none.
    icon: String(formData.get("icon") ?? "") || null,
  };
  const parent = String(formData.get("parent") ?? "") || null;
  return asTeam(projectSlug, DENIED, (context) =>
    slug === null
      ? call(createCollection, context, { ...input, parent, tab: parent ? undefined : String(formData.get("tab") ?? "") || undefined })
      : call(updateCollection, context, { slug: String(slug), ...input }),
  );
}

/**
 * A drop or a move button in the docs' structure: collection `slug` into `parent` (null: the
 * top level; undefined: where it is), at the top level in `tab` (undefined: the one it's in), at `position`.
 */
export async function moveCollection(
  projectSlug: string,
  slug: string,
  parent: string | null | undefined,
  position?: number,
  tab?: string,
): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(reorderCollection, context, { slug: String(slug), parent, position, tab: tab === undefined ? undefined : String(tab) }),
  );
}

/** Adds a tab (`slug` null) or renames tab `slug`. */
export async function saveTab(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const name = String(formData.get("name") ?? "");
  return asTeam(projectSlug, DENIED, (context) =>
    slug === null ? call(createTab, context, { name }) : call(updateTab, context, { slug: String(slug), name }),
  );
}

/** A tab's up and down buttons: tab `slug` to `position`. */
export async function moveTab(projectSlug: string, slug: string, position: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(reorderTab, context, { slug: String(slug), position }));
}

export async function deleteTab(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteTabOperation, context, { slug: String(slug) }));
}

/** Like moveCollection, for article `slug`: into `collection` (null: none; undefined: where it is) at `position`. */
export async function moveArticle(projectSlug: string, slug: string, collection: string | null | undefined, position?: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(reorderArticle, context, { slug: String(slug), collection, position }));
}

export async function deleteCollection(projectSlug: string, slug: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(deleteCollectionOperation, context, { slug: String(slug) }));
}

/** "Dismiss" on a gap in the docs' insights (see docs.dismissGap). */
export async function dismissDocsGap(projectSlug: string, question: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(dismissGapOperation, context, { question: String(question) }));
}
