import { SplashScreen, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { SessionProvider, useSession } from "@/lib/session";
import { useNavigationTheme } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <SessionProvider>
      <Navigator />
    </SessionProvider>
  );
}

// Signed out, only sign-in (where `tuti://sign-in` links land); signed in, everything else. A screen whose guard turns
// false is left for the first one that's allowed.
function Navigator() {
  const { session } = useSession();
  const theme = useNavigationTheme();
  if (session !== undefined) {
    SplashScreen.hide();
  }
  return (
    <ThemeProvider value={theme}>
      <Stack screenOptions={{ headerLargeTitleEnabled: true, headerShadowVisible: false }}>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="index" options={{ title: "Projects" }} />
          <Stack.Screen name="conversation/[number]" options={{ title: "" }} />
        </Stack.Protected>
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
