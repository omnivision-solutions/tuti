/** Docs' reading mode: an article alone, without the docs tree and "On this page" beside it. Remembered per browser. */
export const DOCS_READING_KEY = "tuti:docs-reading";
/** On <html> while it's on; the docs layout's columns hide by it. */
export const DOCS_READING_ATTRIBUTE = "data-docs-reading";
/** Run before the page shows (the portal's layout), so a reader who turned it on never sees the columns flash. */
export const DOCS_READING_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(DOCS_READING_KEY)})==="1")document.documentElement.setAttribute("${DOCS_READING_ATTRIBUTE}","")}catch(e){}`;
