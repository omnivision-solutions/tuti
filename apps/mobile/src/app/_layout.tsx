import { SplashScreen, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useNotifications } from "@/components/notifications";
import { SessionProvider, useSession } from "@/lib/session";
import { useNavigationTheme } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    // The Inbox's rows swipe (react-native-gesture-handler), which needs its root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SessionProvider>
        <Navigator />
      </SessionProvider>
    </GestureHandlerRootView>
  );
}

// Signed out, only sign-in (where `tuti://sign-in` links land); signed in, everything else. A screen whose guard turns
// false is left for the first one that's allowed.
function Navigator() {
  const { session } = useSession();
  const theme = useNavigationTheme();
  useNotifications();
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
          <Stack.Screen name="index" options={{ title: "Inbox" }} />
          <Stack.Screen name="inbox/projects" options={{ title: "Projects", presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, sheetCornerRadius: Platform.OS === "android" ? 28 : undefined, headerShown: false }} />
          <Stack.Screen name="inbox/snooze" options={{ title: "Snooze", presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, sheetCornerRadius: 28, headerShown: false }} />
          <Stack.Screen name="conversation/[number]" options={{ title: "" }} />
          <Stack.Screen name="conversation/[number]/details" options={{ title: "Details", presentation: "formSheet", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, sheetCornerRadius: Platform.OS === "android" ? 28 : undefined, headerShown: false }} />
          <Stack.Screen name="notifications" options={{ title: "Notifications", headerLargeTitleEnabled: false }} />
        </Stack.Protected>
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
