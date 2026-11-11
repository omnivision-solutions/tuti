"use server";

import type { Doc, MediaUrls } from "@tuti/content";
import { prisma } from "@tuti/db";
import { newestRevision } from "@tuti/jobs";
import { redirect } from "next/navigation";

import type { Listing } from "@/lib/article-listing";
import type { Access, WithoutAccess } from "@/lib/read-access";

import { displayDoc } from "./content";
import { mediaUrls } from "./media-urls";
import type { FormState } from "./form-state";
import { OperationError } from "./operations";
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
  restoreTakesOut,
  takesOutMessage,
  unpublishArticle as unpublishOperation,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { dismissDocsGap as dismissGapOperation } from "./operations/docs-insights";
import { asTeam, call } from "./operations/run";

/** The team's docs actions (see the articles.*, collections.* and tabs.* operations). */

const DENIED = "Only the project's team can edit the docs";

/** A form's "Who can read" (WhoCanRead): its access, with its ticked groups only for "groups", and "People without access". Checked by the operation. */
function accessFrom(formData: FormData): { access?: Access; groups?: string[]; noAccess?: WithoutAccess } {
  const access = (formData.get("access") || undefined) as Access | undefined;
  const noAccess = (formData.get("noAccess") || undefined) as WithoutAccess | undefined;
  return { ...(access && { access, groups: access === "groups" ? formData.getAll("groups").map(String) : [] }), ...(noAccess && { noAccess }) };
}

/** A form's text field, or undefined if the form hasn't got it (it stays as it is). */
const textField = (formData: FormData, key: string) => (formData.has(key) ? String(formData.get(key)) : undefined);

/** An article's collection and "Show the updated date" ("on" or "off") from a form, when it sends them (unchanged otherwise). */
function placeFrom(formData: FormData) {
  return {
    collection: formData.has("collection") ? String(formData.get("collection")) || null : undefined,
    showUpdatedDate: formData.has("showUpdatedDate") ? formData.get("showUpdatedDate") === "on" : undefined,
  };
}

/** The editor's `edited` field: a list, or nothing when it isn't one (the operation checks what's in it). */
function parseEdited(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** An article's newest saved version (its unpublished changes, else what's published), for an editor whose save was refused. */
export type NewestVersion = { revision: string | null; title: string; content: Doc; mediaUrls: MediaUrls | null; byAutopilot: boolean };

/**
 * The editor's save, as `saveArticle` returns it: refused because the article changed since the editor opened
 * (Autopilot's edit to the same part, or a teammate's save), with `newest`: that version, shown beside the text,
 * which the editor keeps.
 */
export type ArticleSaveState = FormState & {
  newest?: NewestVersion;
  /**
   * Saved: the version it left newest, and whether the text was merged onto Autopilot's edits since (not stored as
   * sent); merged, that version as saved, for an editor still typing to show beside its text.
   */
  saved?: {
    revision: string | null;
    merged: boolean;
    newVersion: boolean;
    title: string;
    version?: NewestVersion;
  };
};

/**
 * Saves the editor's form: a new draft when `slug` is null (with the place picked in its Settings
 * panel), or changes to article `slug`'s title and text. Opens its new address if it moved.
 */
export async function saveArticle(projectSlug: string, slug: string | null, _state: ArticleSaveState, formData: FormData): Promise<ArticleSaveState> {
  const input = {
    // A saved article's editor sends its title only once its user changed it (since it opened or last saved): one it
    // didn't send stays as it is now (a teammate's rename since included).
    ...((slug === null || formData.has("title")) && { title: String(formData.get("title") ?? "") }),
    content: formData.get("content") || undefined,
    body: formData.get("content") ? undefined : "",
    ...placeFrom(formData),
    ...(slug === null && formData.has("description") && { description: String(formData.get("description") ?? "") }),
    // The version the editor opened on, and after a refusal the newest it showed.
    ...(formData.get("revision") && { revision: String(formData.get("revision")) }),
    ...(formData.get("seen") && { seen: String(formData.get("seen")) }),
    ...(formData.get("own") && { own: String(formData.get("own")) }),
    // The sections its user changed since it last had the article (checked by the operation).
    ...(formData.get("edited") && { edited: parseEdited(String(formData.get("edited"))) }),
  };
  let saved: string | undefined;
  let version: ArticleSaveState["saved"];
  let newest: NewestVersion | undefined;
  let refused: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    try {
      if (slug === null) {
        saved = (await call(createArticle, context, { ...input, title: input.title ?? "" })).slug;
      } else {
        const updated = await call(updateArticle, context, { slug: String(slug), ...input });
        saved = updated.slug;
        // (Its title as the newest has it: an editor whose own is different doesn't take that version up as its own.)
        version = { revision: updated.revision, merged: updated.merged, newVersion: updated.newVersion, title: updated.changes?.title ?? updated.title };
        if (updated.merged && updated.newVersion && updated.revision) {
          // That revision's own text (a revision never changes): what the editor shows as seen.
          const row = await prisma.articleRevision.findUniqueOrThrow({
            where: { id: updated.revision },
            select: { articleId: true, title: true, body: true, content: true, createdAt: true },
          });
          const content = displayDoc(row);
          // Whose the parts it kept are: Autopilot's edits only (tagged revisions since the editor's version), or not.
          // (This article's: an id from elsewhere finds nothing.)
          const from = input.revision ? await prisma.articleRevision.findFirst({ where: { id: input.revision, articleId: row.articleId }, select: { id: true, createdAt: true } }) : null;
          // Between the two, ties in the same millisecond broken by id (as revisions are ordered everywhere).
          const since = await prisma.articleRevision.findMany({
            where: {
              articleId: row.articleId,
              AND: [
                from ? { OR: [{ createdAt: { gt: from.createdAt } }, { createdAt: from.createdAt, id: { gt: from.id } }] } : {},
                { OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: updated.revision } }] },
              ],
            },
            select: { codeChangeActionId: true, authorId: true },
          });
          const byAutopilot = since.some((one) => one.codeChangeActionId) && !since.some((one) => !one.codeChangeActionId && one.authorId && one.authorId !== (context.actor.kind === "user" ? context.actor.userId : context.actor.createdById));
          version.version = { revision: updated.revision, title: row.title, content, mediaUrls: await mediaUrls(content), byAutopilot };
        }
      }
    } catch (error) {
      if (slug !== null && error instanceof OperationError && ["autopilot_changed", "revision_required", "changed"].includes(error.code)) {
        refused = error.code;
        const article = await prisma.article.findFirst({
          where: { projectId: context.projectId, slug: String(slug), deletedAt: null },
          select: { id: true },
        });
        if (article) {
          // The revision before the text: a save between the two makes the text newer than it, never older, so a save
          // that says it saw this one is checked again rather than writing over what wasn't shown.
          const revision = await newestRevision(article.id);
          const shown = await prisma.articleChanges.findUnique({ where: { articleId: article.id }, select: { title: true, body: true, content: true } });
          const text = shown ?? (await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { title: true, body: true, content: true } }));
          const content = displayDoc(text);
          newest = { revision, title: text.title, content, mediaUrls: await mediaUrls(content), byAutopilot: error.code !== "changed" };
        }
      }
      throw error;
    }
  });
  if (saved !== undefined && saved !== slug) {
    redirect(`/app/${projectSlug}/docs/${saved}`);
  }
  // In the editor's words (not "reload it": that would lose the text; not the API's `revision`).
  const error = !newest
    ? result.error
    : refused === "changed"
      ? "Someone saved the article since you opened it. Your text is kept: compare it with the newest version, then save again."
      : refused === "revision_required"
        ? "Autopilot changed the article since you opened it. Your text is kept: compare it with the newest version, then save again."
        : result.error;
  return { ...result, ...(error && { error }), ...(newest && { newest }), ...(version && { saved: version }) };
}

/**
 * Saves the article's Settings panel: its collection and "Show the updated date" (as its Save does:
 * on a published article a new collection waits for "Publish changes"), who can read it, its listing,
 * a slug the team sets (or one from the title, unticked), its meta description, keywords (separated
 * by commas or lines) and "Block search indexing". Not its title or text. Opens its new address if it moved.
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
    ...placeFrom(formData),
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

/** Publish a draft; `edits`: the reviewed Autopilot edits going live with it; `revision`: the newest version the queue reviewed. */
export async function publishArticle(projectSlug: string, slug: string, edits?: string[], revision?: string): Promise<FormState & { code?: string }> {
  let code: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    try {
      await call(publishOperation, context, { slug: String(slug), ...(Array.isArray(edits) && { edits: edits.map(String) }), ...(revision !== undefined && { revision: String(revision) }) });
    } catch (error) {
      if (error instanceof OperationError) code = error.code;
      throw error;
    }
  });
  // The queue needs structured review reasons; preserve existing errors from callers without a revision.
  return code === "edits_required" || (revision !== undefined && code === "changed") ? { ...result, code } : result;
}

/** "Publish changes": a published article's unpublished changes go live, if they're still those saved at `savedAt` (the ones reviewed). */
export async function publishArticleChanges(projectSlug: string, slug: string, savedAt?: string): Promise<FormState & { code?: "changed" }> {
  let changed = false;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    try {
      await call(publishChangesOperation, context, { slug: String(slug), savedAt: savedAt === undefined ? undefined : String(savedAt) });
    } catch (error) {
      changed = error instanceof OperationError && error.code === "changed";
      throw error;
    }
  });
  return changed ? { ...result, code: "changed" } : result;
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
export async function restoreArticle(
  projectSlug: string,
  slug: string,
  revision: string,
  dismissEdits: string[] = [],
): Promise<FormState & { slug?: string; confirm?: { message: string; edits: string[] } }> {
  let restored: string | undefined;
  let confirm: { message: string; edits: string[] } | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    const dismiss = Array.isArray(dismissEdits) ? dismissEdits.map(String) : [];
    const restore = () => call(restoreOperation, context, { slug: String(slug), revision: String(revision), ...(dismiss.length > 0 && { dismissEdits: dismiss }) });
    try {
      restored = (await restore()).slug;
    } catch (error) {
      // It takes out Autopilot's waiting edits: said first, naming them, to restore anyway (dismissing those) or not.
      // The names and ids from one look, so what's confirmed is what's named (one landing after it is named next time).
      if (error instanceof OperationError && error.code === "edits_waiting") {
        const taken = await restoreTakesOut(context.projectId, String(slug), String(revision));
        if (taken.length > 0) {
          confirm = { message: takesOutMessage(taken), edits: taken.map((edit) => edit.actionId) };
          return;
        }
        // None left to name (decided meanwhile): restored as asked, refused again if one landed since.
        restored = (await restore()).slug;
        return;
      }
      throw error;
    }
  });
  return confirm ? { confirm } : { ...result, slug: restored };
}

/**
 * Adds a collection (`slug` null), in the one the form's `parent` names if any, else in the form's
 * `tab` (if the docs have tabs), or changes collection `slug`: its name, description, icon, the one
 * it's in (`parent`, empty for the top level) and who can read it. Only the fields the form has change
 * (a collection's settings page saves its details and its access apart).
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
