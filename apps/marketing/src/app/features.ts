import { BookOpenIcon, InboxIcon, LightbulbIcon, type LucideIcon, MapIcon, MegaphoneIcon, MessageCircleIcon, SparklesIcon, ZapIcon } from "lucide-react";

/** Tuti's features, each with its own page (features/[slug]): the header's Features menu and the footer list them, by group. */
export type Feature = { slug: string; name: string; icon: LucideIcon; line: string; group: (typeof GROUPS)[number] };

export const GROUPS = ["Help center", "Support", "Feedback"] as const;

export const FEATURES: Feature[] = [
  { slug: "help-center", name: "Help center", icon: BookOpenIcon, line: "Answers on your domain, in your brand", group: "Help center" },
  { slug: "ai-answers", name: "AI answers", icon: SparklesIcon, line: "Cited answers from your articles", group: "Help center" },
  { slug: "autopilot", name: "Autopilot", icon: ZapIcon, line: "Everything customers see, kept in sync", group: "Help center" },
  { slug: "inbox", name: "Inbox", icon: InboxIcon, line: "Widget messages and email, one place", group: "Support" },
  { slug: "widget", name: "Widget", icon: MessageCircleIcon, line: "Help, messages and news inside your app", group: "Support" },
  { slug: "feedback", name: "Feedback", icon: LightbulbIcon, line: "Feature requests customers vote on", group: "Feedback" },
  { slug: "roadmap", name: "Roadmap", icon: MapIcon, line: "Show what's planned and in progress", group: "Feedback" },
  { slug: "changelog", name: "Changelog", icon: MegaphoneIcon, line: "Tell everyone what shipped", group: "Feedback" },
];

export const feature = (slug: string) => FEATURES.find((f) => f.slug === slug);
