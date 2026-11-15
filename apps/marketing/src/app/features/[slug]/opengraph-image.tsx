import { MergeVisual, type Row, shareImage, WindowVisual } from "../../../og/og";
import { feature } from "../../features";
import { CONTENT } from "./content";

export const contentType = "image/png";

// One image per feature page (its slug from the page's generateStaticParams), with its own alt text.
export function generateImageMetadata({ params }: { params: { slug: string } }) {
  const f = feature(params.slug);
  return [{ id: "card", alt: f ? `Tuti ${f.name}: ${CONTENT[f.slug].headline}` : "Tuti", size: { width: 1200, height: 630 }, contentType }];
}

// Each feature's picture: a window onto it, in the home page's story (Lumen, pull request #230).
const WINDOWS: Record<string, { url: string; query?: string; answer?: string; rows: Row[] }> = {
  "help-center": {
    url: "help.lumen.app",
    query: "Search the help center",
    rows: [
      { text: "Sync with Google Calendar", pill: ["Updated", "done"] },
      { text: "Share a calendar", pill: ["Article", "open"] },
      { text: "Set up reminders", pill: ["Article", "open"] },
    ],
  },
  "ai-answers": {
    url: "help.lumen.app",
    query: "Does Lumen sync with Google?",
    answer: "Yes. Connect Google in Settings, and changes sync both ways.",
    rows: [{ text: "Sync with Google Calendar", pill: ["Source", "done"] }],
  },
  inbox: {
    url: "tuti.so/app/lumen/inbox",
    rows: [
      { text: "Can I export to CSV?", pill: ["Widget", "plan"] },
      { text: "Invoice for October", pill: ["Email", "open"] },
      { text: "Calendar not syncing", pill: ["AI answered", "done"] },
      { text: "Add a teammate", pill: ["Widget", "plan"] },
    ],
  },
  widget: {
    url: "lumen.app",
    query: "How do I share a calendar?",
    rows: [
      { text: "Help", pill: ["3 articles", "done"] },
      { text: "Messages", pill: ["Reply in 2m", "plan"] },
      { text: "What's new", pill: ["New", "prog"] },
    ],
  },
  feedback: {
    url: "help.lumen.app/feedback",
    rows: [
      { text: "Calendar sync", votes: 42, pill: ["In progress", "prog"] },
      { text: "Dark mode", votes: 31, pill: ["Planned", "plan"] },
      { text: "Export to CSV", votes: 18, pill: ["Open", "open"] },
    ],
  },
  roadmap: {
    url: "help.lumen.app/roadmap",
    rows: [
      { text: "Recurring events", pill: ["Done", "done"] },
      { text: "Google Calendar sync", pill: ["In progress", "prog"] },
      { text: "Dark mode", pill: ["Planned", "plan"] },
      { text: "Shared inboxes", pill: ["Planned", "plan"] },
    ],
  },
  changelog: {
    url: "help.lumen.app/changelog",
    rows: [
      { text: "Two-way Google Calendar sync", pill: ["New", "done"] },
      { text: "Fewer duplicate reminders", pill: ["Improved", "plan"] },
      { text: "Time zones on shared events", pill: ["Fixed", "prog"] },
    ],
  },
};

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const f = feature(slug)!;
  const window = WINDOWS[slug];
  return shareImage({
    eyebrow: f.name,
    headline: CONTENT[slug].headline,
    line: CONTENT[slug].sub,
    visual: window ? <WindowVisual {...window} /> : <MergeVisual />,
  });
}
