/**
 * A record's text (a subject, a title, a project's name) as a page's `title`: Next.js puts it into the layout's
 * template with `String.replace`, which would read "$$" or "$&" in it as patterns ("Charged $$ twice" → "Charged $ twice").
 */
export const pageTitle = (text: string) => text.replaceAll("$", "$$$$");

/**
 * A record's text inside a layout's `template`: Next.js fills every "%s" in it, so one in the text ("100%sure") gets a
 * word joiner (U+2060, invisible) between its two characters.
 */
export const templateText = (text: string) => text.replaceAll("%s", "%\u2060s");
