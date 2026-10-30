import {
  BookOpenIcon,
  CodeIcon,
  ListIcon,
  type LucideIcon,
  MessageSquareIcon,
  NavigationIcon,
  PaletteIcon,
  SearchIcon,
} from "lucide-react";

/** Customize's sections, by group, in the menu's order. `slug` is the section's path under /customize. */
export const CUSTOMIZE_GROUPS: { title: string; sections: { slug: string; title: string; icon: LucideIcon }[] }[] = [
  {
    title: "Appearance",
    sections: [
      { slug: "branding", title: "Branding", icon: PaletteIcon },
      { slug: "navigation", title: "Navigation", icon: NavigationIcon },
      { slug: "docs-home", title: "Docs home", icon: BookOpenIcon },
    ],
  },
  {
    title: "Features",
    sections: [
      { slug: "content-actions", title: "Content actions", icon: ListIcon },
      { slug: "widget", title: "Widget", icon: MessageSquareIcon },
    ],
  },
  {
    title: "Advanced",
    sections: [
      { slug: "seo", title: "SEO", icon: SearchIcon },
      { slug: "custom-code", title: "Custom code", icon: CodeIcon },
    ],
  },
];

/** A section's title, for its page. */
export function sectionTitle(slug: string): string {
  return CUSTOMIZE_GROUPS.flatMap((group) => group.sections).find((section) => section.slug === slug)!.title;
}
