/**
 * Remembers the last project opened in /app (set by proxy.ts), so pages that
 * aren't about one project (account settings, new project) keep it selected in
 * the sidebar. Not sensitive: membership is checked wherever it's used.
 */
export const LAST_PROJECT_COOKIE = "tuti_last_project";
