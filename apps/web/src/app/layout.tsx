import type { Metadata } from "next";
import localFont from "next/font/local";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

// Brand type (docs/design.md): Figtree for text, Bricolage Grotesque for headings. The files are in
// src/fonts (scripts/fetch-fonts.mjs), so builds don't download them.
const figtree = localFont({ src: "../fonts/figtree.woff2", weight: "300 900", variable: "--font-sans" });

const bricolage = localFont({ src: "../fonts/bricolage-grotesque.woff2", weight: "200 800", variable: "--font-heading" });

const geistMono = localFont({ src: "../fonts/geist-mono.woff2", weight: "100 900", variable: "--font-geist-mono" });

// Symbols none of the fonts has (an AI-written "⋯", arrows, ✓): Noto Sans Math, cut down to these ranges
// (scripts/fetch-fonts.mjs, SYMBOLS), after each font in its stack (globals.css, PortalLook), so after the fallback each
// font has (next/font's local Arial: where the device has it, its arrows and math signs come first). Not preloaded: only a page
// that has one of them downloads it. Not the symbols phones draw as colour emoji (☀, ▶️, ↩️…): those stay the device's.
// No fallback of its own: past it is the device's fonts.
const symbols = localFont({
  src: "../fonts/noto-sans-math.woff2",
  variable: "--font-symbols",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+2190-2193, U+219A-21A8, U+21AB-22FF, U+25A0-25A9, U+25AC-25B5, U+25B7-25BF, U+25C1-25FA, U+2713" }],
});

export const metadata: Metadata = {
  title: "Tuti",
  description: "Open-source feature voting & product feedback",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="en" className={`${figtree.variable} ${bricolage.variable} ${geistMono.variable} ${symbols.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          {/* Top center: the bottom right is the widget launcher's (components/app-widget.tsx), and the top right has pages' actions. */}
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
