"use server";

import type { Language } from "@tuti/shared";

import type { FormState } from "./form-state";
import { OperationError } from "./operations/define";
import { getLanguages, updateLanguages } from "./operations/languages";
import { asAdmin, call } from "./operations/run";

/** Settings → Languages (see the languages.* operations). */

const DENIED = "Only project owners and admins can change the languages";

type Context = Parameters<Parameters<typeof asAdmin>[2]>[0];

/**
 * Saves the other languages as `change` makes them from the saved ones (each as `{ code }`: fields left out keep their
 * value). ponytail: read then write, so a language a teammate adds in between can be lost; one call to an operation that
 * adds or changes a single language closes that, if it ever matters.
 */
async function saveLanguages(context: Context, change: (codes: Language[]) => { code: Language }[]) {
  const { languages } = await call(getLanguages, context, {});
  await call(updateLanguages, context, { languages: change(languages.map(({ code }) => code)) });
}

/** The language the team writes in (only while it's the only one). */
export async function setDefaultLanguage(projectSlug: string, code: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateLanguages, context, { default: code as Language }));
}

/** Adds a language: offline, Automatic for new pages. */
export async function addLanguage(projectSlug: string, code: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => saveLanguages(context, (codes) => [...codes.map((saved) => ({ code: saved })), { code: code as Language }]));
}

export type LanguageChanges = { newPages?: "automatic" | "manual"; instructions?: string; productAvailable?: boolean; live?: boolean };

/** Changes one language: Go live or Take offline, New pages, its instructions and "Our product is available in …". */
export async function updateLanguage(projectSlug: string, code: string, changes: LanguageChanges): Promise<FormState> {
  const { newPages, instructions, productAvailable, live } = changes;
  return asAdmin(projectSlug, DENIED, (context) =>
    saveLanguages(context, (codes) => {
      if (!codes.includes(code as Language)) {
        throw new OperationError(404, "not_found", "That language was removed");
      }
      return codes.map((saved) => (saved === code ? { code: saved, newPages, instructions, productAvailable, live } : { code: saved }));
    }),
  );
}

/** Removes a language: its pages are no longer served in it. */
export async function removeLanguage(projectSlug: string, code: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => saveLanguages(context, (codes) => codes.filter((saved) => saved !== code).map((saved) => ({ code: saved }))));
}
