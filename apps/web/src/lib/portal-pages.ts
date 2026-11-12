import { BookOpenIcon, CodeIcon, ListIcon, type LucideIcon, MessageSquareIcon, NavigationIcon, PaletteIcon, SearchIcon } from "lucide-react";

/**
 * Settings' Portal pages (how the portal looks, each beside a preview of it), in the menu's order. `slug`: the page's
 * path under /settings. Customize's before (/customize/<slug> sends people on to them). No server imports: AppWidget
 * reads it in the browser.
 */
export const PORTAL_PAGES: { slug: string; title: string; description: string; icon: LucideIcon }[] = [
  { slug: "branding", title: "Branding", description: "Your portal's colours, logo and fonts", icon: PaletteIcon },
  { slug: "navigation", title: "Navigation", description: "What your portal opens on, and the links around it", icon: NavigationIcon },
  { slug: "docs-home", title: "Docs home", description: "The top of your docs", icon: BookOpenIcon },
  { slug: "content-actions", title: "Content actions", description: "What readers can do with an article", icon: ListIcon },
  { slug: "widget", title: "Widget", description: "The button and panel on your site", icon: MessageSquareIcon },
  { slug: "seo", title: "SEO", description: "How your portal shows in search results and shared links", icon: SearchIcon },
  { slug: "custom-code", title: "Custom code", description: "Your own CSS and HTML on the portal", icon: CodeIcon },
];

/** A Portal page, by its slug. */
export function portalPage(slug: string) {
  return PORTAL_PAGES.find((page) => page.slug === slug)!;
}

/** Settings' Portal pages, whose previews show the project's own widget (AppWidget keeps Tuti's own out of them). */
export const PORTAL_PAGE_PATH = new RegExp(`^/app/[^/]+/settings/(${PORTAL_PAGES.map((page) => page.slug).join("|")})(/|$)`);
