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

/**
 * The languages readers get, of a project's others (`languages`, in the order added) on a plan allowing `limit` (the default
 * included; null, no limit): those set live, but past the limit (after a downgrade) only the oldest within it. Codes no
 * longer offered don't count.
 */
export function liveLanguages(languages: { code: string; live: boolean }[], limit: number | null): Language[] {
  return languages
    .filter(({ code }) => isLanguage(code))
    .filter(({ live }, index) => live && (limit === null || index < limit - 1))
    .map(({ code }) => code as Language);
}

/**
 * How each language is searched (docs/plan.md, Search in every language): its Postgres text search configuration, which
 * stems words ("Rechnungen" finds "Rechnung"), or `simple` where Postgres has no stemmer for it (Polish); null for
 * Japanese, Korean and Chinese, written without spaces between words, which match inside words by trigrams instead.
 */
export const SEARCH_CONFIGS: Record<Language, string | null> = {
  en: "english",
  de: "german",
  fr: "french",
  es: "spanish",
  "pt-BR": "portuguese",
  it: "italian",
  nl: "dutch",
  ja: null,
  ko: null,
  "zh-CN": null,
  pl: "simple",
};

/** A language's search configuration (SEARCH_CONFIGS); `simple` for a code it doesn't know. */
export const searchConfig = (language: string): string | null => (isLanguage(language) ? SEARCH_CONFIGS[language] : "simple");

/** A language's name in itself ("Deutsch" for de, "Français" for fr), as its speakers know it; the code where Intl doesn't know it. */
export function nativeLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}
