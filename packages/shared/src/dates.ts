/** A day, like "19 October 2026" (UTC, so server, browser and emails agree): the portal's and the emails' one format. */
export function formatDate(date: Date, language = "en"): string {
  return date.toLocaleDateString(dateLocale(language), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The locale a portal's language formats days in: English as the portal always has (day, month, year), the others their own. */
export const dateLocale = (language: string) => (language === "en" ? "en-GB" : language);
