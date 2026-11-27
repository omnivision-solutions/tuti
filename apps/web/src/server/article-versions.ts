"use server";

import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { asTeam, call } from "./operations/run";
import { keepTranslationUpToDate, saveArticleVersionText, updateTranslationSections, VERSION_CHANGED } from "./operations/translations";

/** An article's versions in other languages, from its editor's language pill (docs/plan.md L11; the articles.*Translation operations). */

const DENIED = "Only the project's team can edit the docs";

/**
 * Saves the version's draft from its editor, against the `version` it was read at (the form's); with `intent` "publish",
 * publishes it too, keeping the team's edits behind English except the sections in `take` (the publish dialog's "take the
 * new translation"). One transaction (saveArticleVersionText): a refused step leaves none done. What it says after, for the
 * form's next save.
 */
export async function saveArticleVersion(projectSlug: string, articleSlug: string, language: string, _state: FormState, formData: FormData): Promise<FormState & { version?: string }> {
  let version: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    version = (
      await saveArticleVersionText(context.projectId, articleSlug, language as "de", {
        title: String(formData.get("title") ?? "") || undefined,
        content: formData.get("content") ?? undefined,
        version: String(formData.get("version") ?? ""),
        publish: formData.get("intent") === "publish",
        take: formData.getAll("take").map(String),
      })
    ).version;
  });
  if (result.error) {
    return result;
  }
  refresh();
  return { version };
}

/**
 * Keep up to date on (translated again) or off, against the `version` the page last read. Refused as changed meanwhile,
 * `changed` says so: the editor reads the page again, or, with edits typed, keeps them on screen.
 */
export async function keepArticleVersionUpToDate(projectSlug: string, articleSlug: string, language: string, on: boolean, version: string): Promise<FormState & { version?: string; changed?: boolean }> {
  let saved: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    saved = (await call(keepTranslationUpToDate, context, { slug: articleSlug, language: language as "de", keepUpToDate: on === true, version: String(version) })).version;
  });
  if (result.error === VERSION_CHANGED) {
    return { error: VERSION_CHANGED, changed: true };
  }
  if (result.error) {
    return result;
  }
  refresh();
  return { version: saved };
}

/** Update those sections: every section behind English translated again (in the background), the team's edits there replaced. */
export async function updateArticleVersionSections(projectSlug: string, articleSlug: string, language: string): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(updateTranslationSections, context, { slug: articleSlug, language: language as "de" }));
  if (result.error) {
    return result;
  }
  refresh();
  return {};
}
