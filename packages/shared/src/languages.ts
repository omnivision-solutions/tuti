/**
 * The languages a project's portal can be in (docs/plan.md, Languages): only those the portal's own text has message
 * files for (L4), so a language is never half translated by the portal itself. English is the text they're written
 * from. Any of them can be a project's default language, or one of its others.
 */
export const LANGUAGES = {
  en: { name: "English", native: "English" },
  de: { name: "German", native: "Deutsch" },
  fr: { name: "French", native: "Français" },
  es: { name: "Spanish", native: "Español" },
  "pt-BR": { name: "Portuguese (Brazil)", native: "Português (Brasil)" },
  it: { name: "Italian", native: "Italiano" },
  nl: { name: "Dutch", native: "Nederlands" },
  ja: { name: "Japanese", native: "日本語" },
  ko: { name: "Korean", native: "한국어" },
  "zh-CN": { name: "Chinese (Simplified)", native: "简体中文" },
  pl: { name: "Polish", native: "Polski" },
} as const;

export type Language = keyof typeof LANGUAGES;

export const LANGUAGE_CODES = Object.keys(LANGUAGES) as [Language, ...Language[]];

/** A project's default language until its team picks another. */
export const DEFAULT_LANGUAGE: Language = "en";

export const isLanguage = (code: string): code is Language => Object.hasOwn(LANGUAGES, code);
