import type { ExpoConfig } from "expo/config";

type Env = Record<string, string | undefined>;

// The Expo account and project a build belongs to come from the environment, never from this file: Tuti's builds get
// Tuti's, and a fork builds under its own account and app id.
export function appConfig(env: Env): ExpoConfig {
  // `||`: a variable that is set but empty (an unset CI variable) means the default too.
  const appId = env.APP_ID || "so.tuti.app";
  // Expo's builders read this file again, with only the EAS environment's variables: a build made without the project
  // gets no push token, so it notifies nothing. Set EAS_PROJECT_ID (and EXPO_OWNER) in each EAS environment.
  if (env.EAS_BUILD === "true" && !env.EAS_PROJECT_ID) {
    throw new Error("EAS_PROJECT_ID isn't set in this build's EAS environment: without it the app gets no push token");
  }
  return {
    name: "Tuti",
    slug: "tuti",
    scheme: "tuti",
    version: "0.1.0",
    orientation: "default",
    userInterfaceStyle: "automatic",
    icon: "./assets/icon.png",
    ios: { bundleIdentifier: appId, supportsTablet: true },
    android: {
      package: appId,
      // Firebase's config for this app id, which Android's push tokens need: a file EAS keeps with the build (M10), never this directory.
      ...(env.GOOGLE_SERVICES_JSON ? { googleServicesFile: env.GOOGLE_SERVICES_JSON } : {}),
      adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundColor: "#fbf9f3" },
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-web-browser",
      // The server's pushes name the `default` channel, which the app makes (src/lib/notifications.ts); also Firebase's own.
      ["expo-notifications", { icon: "./assets/notification-icon.png", color: "#12804a", defaultChannel: "default" }],
      // Photos for replies come from the system's picker: no camera or microphone, so the app never asks for them.
      ["expo-image-picker", { photosPermission: "Tuti attaches the photos you choose to your replies.", cameraPermission: false, microphonePermission: false }],
      [
        "expo-splash-screen",
        { image: "./assets/splash-icon.png", imageWidth: 96, backgroundColor: "#fbf9f3", dark: { backgroundColor: "#0f1411" } },
      ],
    ],
    experiments: { reactCompiler: true },
    // Over-the-air updates (EAS Update) reach only builds with the same native code: the runtime version is the
    // fingerprint of everything native (modules, their patches, this config). A native change needs a new build.
    runtimeVersion: { policy: "fingerprint" },
    ...(env.EXPO_OWNER ? { owner: env.EXPO_OWNER } : {}),
    ...(env.EAS_PROJECT_ID ? { extra: { eas: { projectId: env.EAS_PROJECT_ID } }, updates: { url: `https://u.expo.dev/${env.EAS_PROJECT_ID}` } } : {}),
  };
}

export default appConfig(process.env);
