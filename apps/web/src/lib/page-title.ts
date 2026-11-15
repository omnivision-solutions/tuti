/**
 * A record's text (a subject, a title, a project's name) as a page's `title`: Next.js puts it into the layout's
 * template with `String.replace`, which would read "$$" or "$&" in it as patterns ("Charged $$ twice" → "Charged $ twice").
 */
export const pageTitle = (text: string) => text.replaceAll("$", "$$$$");
