import { DarkTheme, DefaultTheme, type Theme } from "expo-router";
import { useColorScheme } from "react-native";

// The web app's colours (packages/ui/src/globals.css, light and `.dark`), as hex: React Native doesn't read oklch.
// A screen takes its colours from `useColors()`, never a literal, so both appearances follow the phone's.
const light = {
  page: "#fbf9f3", // --background
  text: "#1c1917", // --foreground
  card: "#ffffff",
  primary: "#12804a",
  onPrimary: "#ffffff",
  secondary: "#f3f0ea",
  muted: "#5c544e", // --muted-foreground
  border: "#ded9ce",
  input: "#d1ccbf",
  error: "#be1218", // --destructive-foreground
  soft: "#e8f5ec",
  onSoft: "#0f5e37",
};
export type Colors = typeof light;

const dark: Colors = {
  page: "#0f1411",
  text: "#f1f5f2",
  card: "#1b231f",
  primary: "#3dcf7f",
  onPrimary: "#06210f",
  secondary: "#232d28",
  muted: "#bcc7c1",
  border: "#38453e",
  input: "#45544c",
  error: "#ff8d8b",
  soft: "#173323",
  onSoft: "#8fe6b3",
};

export const useColors = (): Colors => (useColorScheme() === "dark" ? dark : light);

/** The navigation's colours (headers, screen backgrounds), for the root layout's ThemeProvider. */
export function useNavigationTheme(): Theme {
  const isDark = useColorScheme() === "dark";
  const colors = isDark ? dark : light;
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: { ...base.colors, primary: colors.primary, background: colors.page, card: colors.page, text: colors.text, border: colors.border },
  };
}
