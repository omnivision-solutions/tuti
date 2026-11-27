"use server";

import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { asTeam, call } from "./operations/run";
import { getTranslation, keepTranslationUpToDate, publishTranslation, saveTranslation, VERSION_CHANGED } from "./operations/translations";

/** An article's versions in other languages, from its editor's language pill (docs/plan.md L11; the articles.*Translation operations). */

const DENIED = "Only the project's team can edit the docs";

/**
 * Saves the version's draft from its editor, against the `version` it was read at (the form's); with `intent` "publish",
 * publishes it too. What it says after, for the form's next save.
 */
export async function saveArticleVersion(projectSlug: string, articleSlug: string, language: string, _state: FormState, formData: FormData): Promise<FormState & { version?: string }> {
  let version: string | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    const at = { slug: articleSlug, language: language as "de" };
    let token = String(formData.get("version") ?? "");
    // Kept up to date with no text of its own yet (its first translation on its way or failing): the form shows the
    // English, and saving it as the team's would keep that English from ever being translated. Writing it turns Keep up
    // to date off first, as an entry's does (against the same read: refused if it changed).
    const read = await call(getTranslation, context, at);
    if (read.keepUpToDate && !read.publishedAt && !read.draft) {
      token = (await call(keepTranslationUpToDate, context, { ...at, keepUpToDate: false, version: token })).version;
    }
    const saved = await call(saveTranslation, context, {
      ...at,
      title: String(formData.get("title") ?? "") || undefined,
      content: formData.get("content") || undefined,
      version: token,
    });
    // Publish keeps every edit of the team's behind the source: nothing asks yet whether to take the new translation
    // instead (L11's publish dialog), and taking it unasked would replace their text.
    version =
      formData.get("intent") === "publish"
        ? (await call(publishTranslation, context, { ...at, version: saved.version, keep: saved.draft?.behind ?? [] })).version
        : saved.version;
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
