/** How many of a kind of page have a version in a language, and wait for one (and why): languages.get's. */
export type Translations = { translated: number; waiting: number; why: string | null };

/** Settings → Languages: a row's line under its name. Its mode, how many of the published pages have a version in it, and what waits. */
export function languageLine(language: { newPages: "automatic" | "manual"; articles: Translations; entries: Translations }, pages: number) {
  const mode = language.newPages === "automatic" ? "Automatic" : "Manual";
  if (pages === 0) {
    return mode;
  }
  const translated = Math.min(language.articles.translated + language.entries.translated, pages);
  const waiting = language.articles.waiting + language.entries.waiting;
  const why = language.articles.why ?? language.entries.why;
  return [
    mode,
    translated === pages ? (pages === 1 ? "1 page translated" : `all ${pages.toLocaleString("en")} pages translated`) : `${translated.toLocaleString("en")} of ${pages.toLocaleString("en")} translated`,
    ...(waiting > 0 ? [`${waiting.toLocaleString("en")} waiting${why ? `: ${why}` : ""}`] : []),
  ].join(" · ");
}

