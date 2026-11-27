import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandFonts } from "@tuti/ui/brand-fonts";

import { MESSAGES } from "@tuti/shared/messages";

import { PortalIntl } from "@/components/portal-language";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { languageFrom } from "@/lib/language-addresses";

import "./globals.css";

// Only what fits every page here, the teams' portals too: the app's own tags are in app/app/layout.tsx.
export const metadata: Metadata = {
  title: "Tuti",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // A portal page's address's language (proxy.ts says which); the app's own pages are English.
  const { language, defaultLanguage } = languageFrom(await headers());
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang={language ?? "en"} className={`${brandFonts} h-full antialiased`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {/* The portal's messages in English wherever no page gives the reader's (the app, the widget): components shared
              with the portal use them, and the team's words are in the project's default language. The portal's layout gives its
              own (PortalIntl). */}
          <PortalIntl language="en" teamLanguage={defaultLanguage ?? "en"} messages={MESSAGES.en}>
            {children}
          </PortalIntl>
          {/* Top center: the bottom right is the widget launcher's (components/app-widget.tsx), and the top right has pages' actions. */}
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
