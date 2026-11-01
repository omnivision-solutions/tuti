"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useSelectedLayoutSegments } from "next/navigation";

/**
 * The marketing site (landing, pricing, sign-in…) is designed for light mode only, whatever the
 * visitor's own pick. Told apart by its route, not its path: a portal's home page is `/` on its own host too.
 */
export const forcedThemeFor = (segments: string[]) => (segments[0] === "(marketing)" ? "light" : undefined);

export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider forcedTheme={forcedThemeFor(useSelectedLayoutSegments())} {...props} />;
}
