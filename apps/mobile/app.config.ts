import type { ExpoConfig } from "expo/config";

type Env = Record<string, string | undefined>;

// The Expo account and project a build belongs to come from the environment, never from this file: Tuti's builds get
// Tuti's, and a fork builds under its own account and app id.
export function appConfig(env: Env): ExpoConfig {
  // `||`: a variable that is set but empty (an unset CI variable) means the default too.
  const appId = env.APP_ID || "so.tuti.app";
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
      adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundColor: "#fbf9f3" },
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        { image: "./assets/splash-icon.png", imageWidth: 96, backgroundColor: "#fbf9f3", dark: { backgroundColor: "#0f1411" } },
      ],
    ],
    experiments: { reactCompiler: true },
    ...(env.EXPO_OWNER ? { owner: env.EXPO_OWNER } : {}),
    ...(env.EAS_PROJECT_ID ? { extra: { eas: { projectId: env.EAS_PROJECT_ID } } } : {}),
  };
}

export default appConfig(process.env);
