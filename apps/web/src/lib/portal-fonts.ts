/**
 * The fonts a portal can pick for its headings and its text (Customize → Branding → Typography).
 * Each is built into the app (components/portal-fonts.ts, next/font): served from the portal's own
 * host, so readers' browsers never ask Google for them, and only downloaded when a page uses it.
 */
export const PORTAL_FONTS = [
  { id: "inter", name: "Inter" },
  { id: "roboto", name: "Roboto" },
  { id: "open-sans", name: "Open Sans" },
  { id: "lato", name: "Lato" },
  { id: "montserrat", name: "Montserrat" },
  { id: "poppins", name: "Poppins" },
  { id: "source-sans-3", name: "Source Sans 3" },
  { id: "nunito", name: "Nunito" },
  { id: "work-sans", name: "Work Sans" },
  { id: "dm-sans", name: "DM Sans" },
  { id: "manrope", name: "Manrope" },
  { id: "ibm-plex-sans", name: "IBM Plex Sans" },
  { id: "space-grotesk", name: "Space Grotesk" },
  { id: "merriweather", name: "Merriweather" },
  { id: "lora", name: "Lora" },
  { id: "playfair-display", name: "Playfair Display" },
] as const;

export type PortalFont = (typeof PORTAL_FONTS)[number]["id"];

export const isPortalFont = (value: unknown): value is PortalFont => PORTAL_FONTS.some((font) => font.id === value);

/** The CSS variable a font's family is in (components/portal-fonts.ts sets it). */
export const fontVariable = (font: PortalFont) => `--portal-font-${font}`;
