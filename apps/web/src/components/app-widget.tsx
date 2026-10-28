import { SLUG_PATTERN } from "@/lib/project-slugs";

/**
 * Tuti's own widget on the app's pages (the marketing site and the team app, never portals), when
 * APP_WIDGET_PROJECT names its project: tuti.so's help and feedback, as customers put it on theirs.
 */
export function AppWidget() {
  const slug = process.env.APP_WIDGET_PROJECT?.trim().toLowerCase();
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return null;
  }
  return <script src="/widget.js" data-project={slug} async />;
}
