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

export const metadata: Metadata = {
  title: "Tuti",
  description: "Open-source feature voting & product feedback",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="en" className={`${figtree.variable} ${bricolage.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
