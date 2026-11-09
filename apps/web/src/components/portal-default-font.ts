import localFont from "next/font/local";

/**
 * Inter, the portal's default font (components/portal-look.tsx), preloaded: only the portal's own pages ((site)/layout.tsx)
 * import this, so the widget's page and the app never fetch it. The same file as components/portal-fonts.ts's Inter (one
 * download), whose instance stays unpreloaded for the pages that only pick it.
 */
export const portalDefaultFont = localFont({ src: "../fonts/inter.woff2", weight: "100 900", variable: "--portal-font-inter", preload: true });
