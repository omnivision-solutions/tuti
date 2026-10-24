import localFont from "next/font/local";

import type { PortalFont } from "@/lib/portal-fonts";

/*
 * The portal fonts (lib/portal-fonts.ts), built in by next/font from the files in src/fonts
 * (scripts/fetch-fonts.mjs) and served from our own hosts. Not preloaded: a browser downloads one
 * only when a page uses it. Each sets its family in a CSS variable (fontVariable) on the elements
 * with its class. Serif ones fall back to Times New Roman's metrics, the rest to Arial's, as
 * next/font/google did. Each family is named after its constant (`playfairDisplay`): next/font/local
 * names it so, and a family named otherwise wouldn't be the one its class and variable ask for.
 */
const inter = localFont({ src: "../fonts/inter.woff2", weight: "100 900", variable: "--portal-font-inter", preload: false });
const roboto = localFont({ src: "../fonts/roboto.woff2", weight: "100 900", variable: "--portal-font-roboto", preload: false });
const openSans = localFont({ src: "../fonts/open-sans.woff2", weight: "300 800", variable: "--portal-font-open-sans", preload: false });
const lato = localFont({
  src: [
    { path: "../fonts/lato-400.woff2", weight: "400" },
    { path: "../fonts/lato-700.woff2", weight: "700" },
  ],
  variable: "--portal-font-lato",
  preload: false,
});
const montserrat = localFont({ src: "../fonts/montserrat.woff2", weight: "100 900", variable: "--portal-font-montserrat", preload: false });
const poppins = localFont({
  src: [
    { path: "../fonts/poppins-400.woff2", weight: "400" },
    { path: "../fonts/poppins-500.woff2", weight: "500" },
    { path: "../fonts/poppins-600.woff2", weight: "600" },
    { path: "../fonts/poppins-700.woff2", weight: "700" },
  ],
  variable: "--portal-font-poppins",
  preload: false,
});
const sourceSans = localFont({ src: "../fonts/source-sans-3.woff2", weight: "200 900", variable: "--portal-font-source-sans-3", preload: false });
const nunito = localFont({ src: "../fonts/nunito.woff2", weight: "200 1000", variable: "--portal-font-nunito", preload: false });
const workSans = localFont({ src: "../fonts/work-sans.woff2", weight: "100 900", variable: "--portal-font-work-sans", preload: false });
const dmSans = localFont({ src: "../fonts/dm-sans.woff2", weight: "100 1000", variable: "--portal-font-dm-sans", preload: false });
const manrope = localFont({ src: "../fonts/manrope.woff2", weight: "200 800", variable: "--portal-font-manrope", preload: false });
const plexSans = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-400.woff2", weight: "400" },
    { path: "../fonts/ibm-plex-sans-500.woff2", weight: "500" },
    { path: "../fonts/ibm-plex-sans-600.woff2", weight: "600" },
    { path: "../fonts/ibm-plex-sans-700.woff2", weight: "700" },
  ],
  variable: "--portal-font-ibm-plex-sans",
  preload: false,
});
const spaceGrotesk = localFont({ src: "../fonts/space-grotesk.woff2", weight: "300 700", variable: "--portal-font-space-grotesk", preload: false });
const merriweather = localFont({
  src: [
    { path: "../fonts/merriweather-400.woff2", weight: "400" },
    { path: "../fonts/merriweather-700.woff2", weight: "700" },
  ],
  variable: "--portal-font-merriweather",
  preload: false,
  adjustFontFallback: "Times New Roman",
});
const lora = localFont({ src: "../fonts/lora.woff2", weight: "400 700", variable: "--portal-font-lora", preload: false, adjustFontFallback: "Times New Roman" });
const playfairDisplay = localFont({ src: "../fonts/playfair-display.woff2", weight: "400 900", variable: "--portal-font-playfair-display", preload: false, adjustFontFallback: "Times New Roman" });

const FONTS: Record<PortalFont, { variable: string }> = {
  inter,
  roboto,
  "open-sans": openSans,
  lato,
  montserrat,
  poppins,
  "source-sans-3": sourceSans,
  nunito,
  "work-sans": workSans,
  "dm-sans": dmSans,
  manrope,
  "ibm-plex-sans": plexSans,
  "space-grotesk": spaceGrotesk,
  merriweather,
  lora,
  "playfair-display": playfairDisplay,
};

/** The classes that set every portal font's variable (cheap: the files only load when a family is used). */
export const PORTAL_FONT_CLASSES = Object.values(FONTS)
  .map((font) => font.variable)
  .join(" ");
