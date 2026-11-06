import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { z } from "zod";

import { MAX_WIDGET_HOME_TEXT, WIDGET_PARTS, type WidgetPart } from "@/lib/portal-look";
import { WIDGET_ICON_CHOICES, type WidgetIcon } from "@/lib/widget-icons";

import { attachMedia } from "../content";
import { type LastingImage, lastingImage } from "../media-urls";
import { saving } from "./create";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/** The widget's launcher on customers' sites (Phase 9): a round button with an icon; its name, colour, corner and quick links. */

/** The brand green (`--primary` in light mode). Picking it means "the default", which also has a dark-mode shade. */
export const DEFAULT_WIDGET_COLOR = "#12804a";
export const MAX_WIDGET_LINKS = 5;
export const MAX_WIDGET_LABEL_LENGTH = 30;
export const MAX_WIDGET_LINK_LABEL_LENGTH = 40;
const POSITIONS = ["bottom-right", "bottom-left"] as const;

/** A link for visitors: a label and a full https:// address (also the portal's header and footer links). */
export const httpsLink = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Give each link a label")
    .max(MAX_WIDGET_LINK_LABEL_LENGTH, `Keep link labels under ${MAX_WIDGET_LINK_LABEL_LENGTH} characters`),
  url: z
    .string()
    .trim()
    .max(500, "Keep links under 500 characters")
    .pipe(z.url({ protocol: /^https$/, error: "Links need a full https:// address" })),
});

export type WidgetLink = z.infer<typeof httpsLink>;

/** A colour as `#rrggbb`, lowercased: the only form stored, so it's safe to put into CSS. */
export const hexColor = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Pick a colour like #12804a");
export type WidgetSettings = {
  /** The button's name: read out by screen readers and its tooltip (it shows an icon, not text). */
  label: string;
  /** `#rrggbb`, or null for the brand green. */
  color: string | null;
  position: (typeof POSITIONS)[number];
  links: WidgetLink[];
  /** As set; on a plan without `launcherIcon` the launcher shows "chat" (see `servedIcon`). */
  icon: WidgetIcon;
  /** The uploaded icon, when `icon` is "image". */
  iconImage: LastingImage | null;
  /** Home's heading, and the greeting above it; empty for the defaults ("How can we help?", "Hi there 👋"). */
  title: string;
  greeting: string;
  /** The parts turned off. */
  hidden: WidgetPart[];
  /** The launcher on the project's own portal too. */
  onPortal: boolean;
  /** A new message in Messages goes to the docs' AI first, with "Ask a person" to pass it to the team. */
  aiFirst: boolean;
};

/** The project's launcher settings (the public part is served to the loader by /api/widget/latest). */
export async function widgetSettings(where: { id: string } | { slug: string }): Promise<WidgetSettings | null> {
  const project = await prisma.project.findUnique({
    where,
    select: {
      widgetLabel: true,
      widgetColor: true,
      widgetPosition: true,
      widgetLinks: true,
      widgetIcon: true,
      widgetIconImage: { select: { id: true, status: true, width: true, height: true } },
      widgetTitle: true,
      widgetGreeting: true,
      widgetHidden: true,
      widgetOnPortal: true,
      widgetAiFirst: true,
    },
  });
  if (!project) {
    return null;
  }
  const links = z.array(httpsLink).safeParse(project.widgetLinks);
  return {
    label: project.widgetLabel,
    color: project.widgetColor,
    position: project.widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right",
    links: links.success ? links.data : [],
    icon: (WIDGET_ICON_CHOICES as readonly string[]).includes(project.widgetIcon) ? (project.widgetIcon as WidgetIcon) : "chat",
    iconImage: lastingImage(project.widgetIconImage),
    title: project.widgetTitle,
    greeting: project.widgetGreeting,
    hidden: WIDGET_PARTS.filter((part) => project.widgetHidden.includes(part)),
    onPortal: project.widgetOnPortal,
    aiFirst: project.widgetAiFirst,
  };
}

/**
 * The icon the launcher shows: the one set, where the project's plan includes picking it (an image only
 * once it's processed); otherwise the chat bubble, the setting kept for when the plan is back.
 */
export function servedIcon(settings: WidgetSettings, plan: Parameters<typeof planIncludes>[0]): { icon: WidgetIcon; iconUrl: string | null } {
  if (!planIncludes(plan, "launcherIcon") || (settings.icon === "image" && !settings.iconImage)) {
    return { icon: "chat", iconUrl: null };
  }
  return { icon: settings.icon, iconUrl: settings.icon === "image" ? settings.iconImage!.url : null };
}

export { luminance, textColorOn } from "@/lib/colors";

export const getWidgetSettings = defineOperation({
  name: "widget.get",
  summary: "Get the widget's settings: the launcher's name (label), colour, corner and icon, and the panel's Home: quick links, heading (title), greeting and the parts turned off (hidden), whether the launcher shows on the project's own portal (onPortal), and whether a new message in Messages goes to the AI first (aiFirst)",
  method: "GET",
  path: "/widget",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => (await widgetSettings({ id: projectId }))!,
});

export const updateWidgetSettings = defineOperation({
  name: "widget.update",
  summary: `Set the widget's launcher, a round button: its name (label: read out by screen readers and its tooltip), colour (#rrggbb, null for the brand green), corner, up to ${MAX_WIDGET_LINKS} quick links (replaces the list), and its icon (${WIDGET_ICON_CHOICES.join(", ")}; "image" with iconImage, the id of an image uploaded in the app). Where plans are sold, an icon other than chat needs Pro (402 otherwise); on a lower plan the one set is kept and the launcher shows chat. The panel's Home: its heading (title) and the greeting above it (empty for "How can we help?" and "Hi there 👋", with the visitor's first name once their site signs them in), and the parts turned off (hidden, replaces the list: ${WIDGET_PARTS.join(", ")}), gone from Home and the tabs. onPortal: the launcher on every page of the project's own portal too (true for new projects). aiFirst: a new message in Messages goes to the docs' AI first, where the server has AI answers and the project has docs, with "Ask a person" to pass it to the team; one with files goes to the team (true for new projects)`,
  method: "PATCH",
  path: "/widget",
  scope: "write",
  access: "admin",
  input: z.object({
    label: z
      .string()
      .trim()
      .min(1, "Give the button a label")
      .max(MAX_WIDGET_LABEL_LENGTH, `Keep the label under ${MAX_WIDGET_LABEL_LENGTH} characters`)
      .optional(),
    color: hexColor.nullable().optional(),
    position: z.enum(POSITIONS, { error: "Pick bottom-right or bottom-left" }).optional(),
    links: z.array(httpsLink).max(MAX_WIDGET_LINKS, `Add up to ${MAX_WIDGET_LINKS} links`).optional(),
    icon: z.enum(WIDGET_ICON_CHOICES, { error: `Pick ${WIDGET_ICON_CHOICES.join(", ")}` }).optional(),
    iconImage: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().max(MAX_WIDGET_HOME_TEXT, `Keep the heading under ${MAX_WIDGET_HOME_TEXT} characters`).optional(),
    greeting: z.string().trim().max(MAX_WIDGET_HOME_TEXT, `Keep the greeting under ${MAX_WIDGET_HOME_TEXT} characters`).optional(),
    hidden: z.array(z.enum(WIDGET_PARTS, { error: `Parts are ${WIDGET_PARTS.join(", ")}` })).optional(),
    onPortal: z.boolean().optional(),
    aiFirst: z.boolean().optional(),
  }),
  example: {
    label: "Help & feedback",
    color: "#5b21b6",
    position: "bottom-left",
    links: [{ label: "Status", url: "https://status.example.com" }],
    icon: "help",
    title: "Questions about Acme?",
    hidden: ["whatsNew"],
  },
  run: async ({ projectId }, input) => {
    await saving(() =>
      prisma.$transaction(async (tx) => {
        // One save at a time per project, so two saves can't each keep an image the other replaced.
        await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
        const current = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { widgetIcon: true, widgetIconImageId: true } });
        // Removing the image of an image icon (the form still says "image") goes back to the chat bubble.
        const removed = input.iconImage === null && current.widgetIcon === "image" && (input.icon ?? "image") === "image";
        const icon = removed ? "chat" : (input.icon ?? current.widgetIcon);
        // Only an image icon keeps its image; a replaced one is released by the daily release-media job.
        const image = icon === "image" ? (input.iconImage !== undefined ? input.iconImage : current.widgetIconImageId) : null;
        if (icon === "image" && !image) {
          throw new OperationError(400, "invalid_input", "Upload an image for the icon");
        }
        // A new icon other than the chat bubble needs the plan (going back to it always works, and one kept
        // from a plan that ended stays); checked under the lock, so a plan ending meanwhile counts.
        if (icon !== "chat" && (icon !== current.widgetIcon || image !== current.widgetIconImageId)) {
          await requirePlan(projectId, "launcherIcon", tx);
        }
        if (image && image !== current.widgetIconImageId) {
          // Before the project points at it, so the cleanup can't take it meanwhile.
          await attachMedia(tx, projectId, [image], { images: true });
        }
        await tx.project.update({
          where: { id: projectId },
          data: {
            ...(input.label !== undefined && { widgetLabel: input.label }),
            ...(input.color !== undefined && { widgetColor: input.color === DEFAULT_WIDGET_COLOR ? null : input.color }),
            ...(input.position !== undefined && { widgetPosition: input.position }),
            ...(input.links !== undefined && { widgetLinks: input.links }),
            ...(input.title !== undefined && { widgetTitle: input.title }),
            ...(input.greeting !== undefined && { widgetGreeting: input.greeting }),
            ...(input.hidden !== undefined && { widgetHidden: WIDGET_PARTS.filter((part) => input.hidden!.includes(part)) }),
            ...(input.onPortal !== undefined && { widgetOnPortal: input.onPortal }),
            ...(input.aiFirst !== undefined && { widgetAiFirst: input.aiFirst }),
            ...((input.icon !== undefined || input.iconImage !== undefined) && { widgetIcon: icon, widgetIconImageId: image }),
          },
        });
      }),
    );
    return (await widgetSettings({ id: projectId }))!;
  },
});
