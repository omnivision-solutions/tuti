"use server";

import { redirect } from "next/navigation";

import type { Listing } from "@/lib/article-listing";
import type { Access } from "@/lib/read-access";

import type { FormState } from "./form-state";
import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle as deleteArticleOperation,
  type DocsLanding,
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

/** A form's "Who can read" (WhoCanRead): its access, with its ticked groups only for "groups". Checked by the operation. */
function accessFrom(formData: FormData): { access?: Access; groups?: string[] } {
  const access = (formData.get("access") || undefined) as Access | undefined;
  return access === undefined ? {} : { access, groups: access === "groups" ? formData.getAll("groups").map(String) : [] };
}

/** A form's text field, or undefined if the form hasn't got it (it stays as it is). */
const textField = (formData: FormData, key: string) => (formData.has(key) ? String(formData.get(key)) : undefined);

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
    redirect(`/app/${projectSlug}/docs/${saved}`);
  }
  return result;
}

/**
 * Saves the article's Settings dialog: who can read it, its listing, a slug the team sets (or one
 * from the title, unticked), its meta description, keywords (separated by commas or lines) and
 * "Block search indexing". Not its title or text. Opens its new address if it moved.
 */
export async function saveArticleSettings(projectSlug: string, slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    slug: String(slug),
    // Checked by the operation (an unknown listing is a 400).
    listing: (formData.get("listing") || undefined) as Listing | undefined,
    ...accessFrom(formData),
    newSlug: formData.get("customSlug") === "on" ? String(formData.get("newSlug") ?? "").trim() : null,
    description: String(formData.get("description") ?? ""),
    keywords: String(formData.get("keywords") ?? "")
      .split(/[,\n]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean),
    noindex: formData.get("noindex") === "on",
  };
  let saved: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    saved = (await call(updateArticle, context, input)).slug;
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
 * `tab` (if the docs have tabs), or changes collection `slug`: its name, description, icon, the one
 * it's in (`parent`, empty for the top level) and who can read it. Only the fields the form has change
 * (a collection's page saves its Settings and its Access apart).
 */
export async function saveCollection(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    name: textField(formData, "name"),
    description: textField(formData, "description"),
    ...accessFrom(formData),
    // A Lucide icon's name; empty for none.
    icon: formData.has("icon") ? String(formData.get("icon")) || null : undefined,
  };
  const parent = String(formData.get("parent") ?? "") || null;
  return asTeam(projectSlug, DENIED, (context) =>
    slug === null
      ? call(createCollection, context, { ...input, name: input.name ?? "", parent, tab: parent ? undefined : String(formData.get("tab") ?? "") || undefined })
      : call(updateCollection, context, { slug: String(slug), ...input, parent: formData.has("parent") ? parent : undefined }),
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

/** Adds a tab (`slug` null), or saves tab `slug`'s settings (its name and landing page) or who can read it: the fields the form has. */
export async function saveTab(projectSlug: string, slug: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const name = textField(formData, "name");
  // Its settings: checked by the operation (an unknown landing is a 400; "page" needs a page).
  const landing = (formData.get("landing") || undefined) as DocsLanding | undefined;
  const landingPage = landing === "page" ? String(formData.get("landingPage") ?? "") || undefined : undefined;
  return asTeam(projectSlug, DENIED, (context) =>
    slug === null ? call(createTab, context, { name: name ?? "" }) : call(updateTab, context, { slug: String(slug), name, landing, landingPage, ...accessFrom(formData) }),
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
