/**
 * The widget launcher's built-in icons, as the paths of a 24×24 stroked SVG (lucide's message-circle,
 * circle-question-mark, megaphone and lightbulb): drawn by the loader on customers' sites and by
 * Customize's preview. "chat" is the default, and what a project whose plan doesn't include picking one shows.
 */
export const WIDGET_ICONS = {
  chat: [
    "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
  ],
  help: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
  megaphone: [
    "M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
    "M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14",
    "M8 6v8",
  ],
  lightbulb: [
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
    "M9 18h6",
    "M10 22h4",
  ],
} as const;

export type WidgetIconName = keyof typeof WIDGET_ICONS;
/** A built-in icon, or "image" for the team's upload. */
export type WidgetIcon = WidgetIconName | "image";
export const WIDGET_ICON_CHOICES = ["chat", "help", "megaphone", "lightbulb", "image"] as const satisfies readonly WidgetIcon[];
