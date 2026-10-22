import {
  DM_Sans,
  IBM_Plex_Sans,
  Inter,
  Lato,
  Lora,
  Manrope,
  Merriweather,
  Montserrat,
  Nunito,
  Open_Sans,
  Playfair_Display,
  Poppins,
  Roboto,
  Source_Sans_3,
  Space_Grotesk,
  Work_Sans,
} from "next/font/google";

import type { PortalFont } from "@/lib/portal-fonts";

/*
 * The portal fonts (lib/portal-fonts.ts), built in by next/font: their files are fetched at build
 * time and served from our own hosts. Not preloaded: a browser downloads one only when a page uses it.
 * Each sets its family in a CSS variable (fontVariable) on the elements with its class.
 */
const inter = Inter({ subsets: ["latin"], variable: "--portal-font-inter", preload: false });
const roboto = Roboto({ subsets: ["latin"], variable: "--portal-font-roboto", preload: false });
const openSans = Open_Sans({ subsets: ["latin"], variable: "--portal-font-open-sans", preload: false });
const lato = Lato({ subsets: ["latin"], weight: ["400", "700"], variable: "--portal-font-lato", preload: false });
const montserrat = Montserrat({ subsets: ["latin"], variable: "--portal-font-montserrat", preload: false });
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--portal-font-poppins", preload: false });
const sourceSans = Source_Sans_3({ subsets: ["latin"], variable: "--portal-font-source-sans-3", preload: false });
const nunito = Nunito({ subsets: ["latin"], variable: "--portal-font-nunito", preload: false });
const workSans = Work_Sans({ subsets: ["latin"], variable: "--portal-font-work-sans", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--portal-font-dm-sans", preload: false });
const manrope = Manrope({ subsets: ["latin"], variable: "--portal-font-manrope", preload: false });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--portal-font-ibm-plex-sans", preload: false });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--portal-font-space-grotesk", preload: false });
const merriweather = Merriweather({ subsets: ["latin"], weight: ["400", "700"], variable: "--portal-font-merriweather", preload: false });
const lora = Lora({ subsets: ["latin"], variable: "--portal-font-lora", preload: false });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--portal-font-playfair-display", preload: false });

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
  "playfair-display": playfair,
};

/** The classes that set every portal font's variable (cheap: the files only load when a family is used). */
export const PORTAL_FONT_CLASSES = Object.values(FONTS)
  .map((font) => font.variable)
  .join(" ");
