import type { Metadata } from "next";
import { brandFonts } from "@tuti/ui/brand-fonts";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

export const metadata: Metadata = {
  title: "Tuti",
  description: "Open-source feature voting & product feedback",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="en" className={`${brandFonts} h-full antialiased`} suppressHydrationWarning>
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
