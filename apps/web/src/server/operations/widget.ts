import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/** The widget's launcher on customers' sites (Phase 9): label, colour, corner and quick links. */

/** The brand green (`--primary` in light mode). Picking it means "the default", which also has a dark-mode shade. */
export const DEFAULT_WIDGET_COLOR = "#12804a";
export const MAX_WIDGET_LINKS = 5;
export const MAX_WIDGET_LABEL_LENGTH = 30;
export const MAX_WIDGET_LINK_LABEL_LENGTH = 40;
const POSITIONS = ["bottom-right", "bottom-left"] as const;

const link = z.object({
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

export type WidgetLink = z.infer<typeof link>;
export type WidgetSettings = {
  label: string;
  /** `#rrggbb`, or null for the brand green. */
  color: string | null;
  position: (typeof POSITIONS)[number];
  links: WidgetLink[];
};

/** The project's launcher settings (the public part is served to the loader by /api/widget/latest). */
export async function widgetSettings(where: { id: string } | { slug: string }): Promise<WidgetSettings | null> {
  const project = await prisma.project.findUnique({
    where,
    select: { widgetLabel: true, widgetColor: true, widgetPosition: true, widgetLinks: true },
  });
  if (!project) {
    return null;
  }
  const links = z.array(link).safeParse(project.widgetLinks);
  return {
    label: project.widgetLabel,
    color: project.widgetColor,
    position: project.widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right",
    links: links.success ? links.data : [],
  };
}

/** Black or white, whichever reads better on a `#rrggbb` background (WCAG relative luminance). */
export function textColorOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  // Contrast with white is 1.05 / (L + 0.05), with black (L + 0.05) / 0.05; they're equal at L ≈ 0.179.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export const getWidgetSettings = defineOperation({
  name: "widget.get",
  summary: "Get the widget's launcher settings: label, colour, corner and quick links",
  method: "GET",
  path: "/widget",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => (await widgetSettings({ id: projectId }))!,
});

export const updateWidgetSettings = defineOperation({
  name: "widget.update",
  summary: `Set the widget's launcher: label, colour (#rrggbb, null for the brand green), corner, and up to ${MAX_WIDGET_LINKS} quick links (replaces the list)`,
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
    color: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^#[0-9a-f]{6}$/, "Pick a colour like #12804a")
      .nullable()
      .optional(),
    position: z.enum(POSITIONS, { error: "Pick bottom-right or bottom-left" }).optional(),
    links: z.array(link).max(MAX_WIDGET_LINKS, `Add up to ${MAX_WIDGET_LINKS} links`).optional(),
  }),
  example: { label: "Help & feedback", color: "#5b21b6", position: "bottom-left", links: [{ label: "Status", url: "https://status.example.com" }] },
  run: async ({ projectId }, input) => {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.label !== undefined && { widgetLabel: input.label }),
        ...(input.color !== undefined && { widgetColor: input.color === DEFAULT_WIDGET_COLOR ? null : input.color }),
        ...(input.position !== undefined && { widgetPosition: input.position }),
        ...(input.links !== undefined && { widgetLinks: input.links }),
      },
    });
    return (await widgetSettings({ id: projectId }))!;
  },
});
