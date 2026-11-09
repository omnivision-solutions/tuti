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

/**
 * The portal's fonts as the style of its pages' wrapper (and its <body>, for what opens over the page): the team's
 * (Customize → Branding → Typography), else Inter, in place of the app's; the text's stack ends with the bundled symbols
 * font (app/layout.tsx), so a symbol none of them has never shows as an empty box. `--font-sans` and `--font-heading`
 * get it from globals.css's theme.
 */
export function portalFontStyle(fonts: { heading: PortalFont | null; body: PortalFont | null }) {
  const heading = fonts.heading ?? "inter";
  const body = fonts.body ?? "inter";
  return {
    "--font-sans": `var(${fontVariable(body)})`,
    fontFamily: `var(${fontVariable(body)}), var(--font-symbols)`,
    "--font-heading": `var(${fontVariable(heading)})`,
  };
}
