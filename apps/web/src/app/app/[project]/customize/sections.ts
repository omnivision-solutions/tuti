import {
  BookOpenIcon,
  CodeIcon,
  HeartIcon,
  HouseIcon,
  ListIcon,
  type LucideIcon,
  MessageSquareIcon,
  NavigationIcon,
  PaletteIcon,
  SearchIcon,
} from "lucide-react";

/** Customize's sections, by group, in the menu's order. `slug` is the section's path under /customize. */
export const CUSTOMIZE_GROUPS: { title: string; sections: { slug: string; title: string; description: string; icon: LucideIcon }[] }[] = [
  {
    title: "Appearance",
    sections: [
      { slug: "branding", title: "Branding", description: "Colour scheme, logos and favicon", icon: PaletteIcon },
      { slug: "docs-home", title: "Docs home", description: "The heading above your docs' search box, and popular articles", icon: BookOpenIcon },
      { slug: "navigation", title: "Navigation", description: "Links in the header, footer and docs sidebar, and a Contact us button", icon: NavigationIcon },
      { slug: "home-page", title: "Home page", description: "What your portal's address opens", icon: HouseIcon },
    ],
  },
  {
    title: "Features",
    sections: [
      { slug: "content-actions", title: "Content actions", description: "What readers can do with an article: copy it, or ask an AI about it", icon: ListIcon },
      { slug: "widget", title: "Widget", description: "The button on your site that opens feedback and docs", icon: MessageSquareIcon },
    ],
  },
  {
    title: "Advanced",
    sections: [
      { slug: "seo", title: "SEO", description: "How your portal shows in search results and shared links", icon: SearchIcon },
      { slug: "custom-code", title: "Custom code", description: "Your own CSS, and HTML such as analytics", icon: CodeIcon },
      { slug: "powered-by", title: "Powered by", description: "The “Powered by tuti” badge", icon: HeartIcon },
    ],
  },
];

/** A section's title, for its page. */
export function sectionTitle(slug: string): string {
  return CUSTOMIZE_GROUPS.flatMap((group) => group.sections).find((section) => section.slug === slug)!.title;
}
