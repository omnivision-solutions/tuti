/** A day, like "19 October 2026" (UTC, so server, browser and emails agree): the portal's and the emails' one format. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
