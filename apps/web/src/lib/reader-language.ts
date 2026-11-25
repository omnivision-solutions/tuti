import { isLanguage, type Language } from "@tuti/shared";

/** The reader's language on a portal, kept per browser (docs/plan.md, Languages: "The reader's language"). */
export const LANGUAGE_COOKIE = "tuti_language";

/** A portal's languages: its default one, and those of its others that are live. */
export type PortalLanguages = { default: Language; live: Language[] };

/**
 * The language a portal is shown in: the first of the reader's choices it has (this browser's, then a signed-in reader's
 * saved one), else its default. Only a live language or the default counts: one taken offline or removed falls back.
 */
export function readerLanguage(languages: PortalLanguages, choices: (string | null | undefined)[]): Language {
  return choices.find((code): code is Language => !!code && isLanguage(code) && (code === languages.default || languages.live.includes(code))) ?? languages.default;
}
