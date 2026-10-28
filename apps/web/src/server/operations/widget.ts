import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { z } from "zod";

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
  summary: "Get the widget's launcher settings: its name (label), colour, corner, icon and quick links",
  method: "GET",
  path: "/widget",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => (await widgetSettings({ id: projectId }))!,
});

export const updateWidgetSettings = defineOperation({
  name: "widget.update",
  summary: `Set the widget's launcher, a round button: its name (label: read out by screen readers and its tooltip), colour (#rrggbb, null for the brand green), corner, up to ${MAX_WIDGET_LINKS} quick links (replaces the list), and its icon (${WIDGET_ICON_CHOICES.join(", ")}; "image" with iconImage, the id of an image uploaded in the app). Where plans are sold, an icon other than chat needs Pro (402 otherwise); on a lower plan the one set is kept and the launcher shows chat`,
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
  }),
  example: { label: "Help & feedback", color: "#5b21b6", position: "bottom-left", links: [{ label: "Status", url: "https://status.example.com" }], icon: "help" },
  run: async ({ projectId }, input) => {
    // Going back to the chat bubble (or removing the image) always works; anything else needs the plan.
    if ((input.icon !== undefined && input.icon !== "chat") || input.iconImage) {
      await requirePlan(projectId, "launcherIcon");
    }
    await saving(() =>
      prisma.$transaction(async (tx) => {
        // One save at a time per project, so two saves can't each keep an image the other replaced.
        await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
        const current = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { widgetIcon: true, widgetIconImageId: true } });
        const icon = input.icon ?? current.widgetIcon;
        // Only an image icon keeps its image; a replaced one is released by the daily release-media job.
        const image = icon === "image" ? (input.iconImage !== undefined ? input.iconImage : current.widgetIconImageId) : null;
        if (icon === "image" && !image) {
          throw new OperationError(400, "invalid_input", "Upload an image for the icon");
        }
        if (image && image !== current.widgetIconImageId) {
          // Before the project points at it, so the cleanup can't take it meanwhile.
          await attachMedia(tx, projectId, [image]);
        }
        await tx.project.update({
          where: { id: projectId },
          data: {
            ...(input.label !== undefined && { widgetLabel: input.label }),
            ...(input.color !== undefined && { widgetColor: input.color === DEFAULT_WIDGET_COLOR ? null : input.color }),
            ...(input.position !== undefined && { widgetPosition: input.position }),
            ...(input.links !== undefined && { widgetLinks: input.links }),
            ...((input.icon !== undefined || input.iconImage !== undefined) && { widgetIcon: icon, widgetIconImageId: image }),
          },
        });
      }),
    );
    return (await widgetSettings({ id: projectId }))!;
  },
});
