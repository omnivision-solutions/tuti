"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { usePathname } from "next/navigation";

export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  // The landing page is designed for light mode only, whatever the visitor's own pick.
  const forcedTheme = usePathname() === "/" ? "light" : undefined;
  return <NextThemesProvider forcedTheme={forcedTheme} {...props} />;
}
