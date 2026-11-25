import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { appConfig } from "../app.config";
import packageJson from "../package.json";

describe("the app's Expo config", () => {
  it("names no Expo account or project unless the environment does", () => {
    const config = appConfig({});
    expect(config.owner).toBeUndefined();
    expect(config.extra).toBeUndefined();
    expect(config.ios?.bundleIdentifier).toBe("so.tuti.app");
    expect(config.android?.package).toBe("so.tuti.app");
  });

  it("takes an empty variable as not set", () => {
    const config = appConfig({ EXPO_OWNER: "", EAS_PROJECT_ID: "", APP_ID: "" });
    expect(config.owner).toBeUndefined();
    expect(config.extra).toBeUndefined();
    expect(config.ios?.bundleIdentifier).toBe("so.tuti.app");
    expect(config.android?.package).toBe("so.tuti.app");
  });

  it("builds under the account, project and app id the environment gives", () => {
    const config = appConfig({ EXPO_OWNER: "acme", EAS_PROJECT_ID: "project-1", APP_ID: "com.acme.inbox" });
    expect(config.owner).toBe("acme");
    expect(config.extra).toEqual({ eas: { projectId: "project-1" } });
    expect(config.ios?.bundleIdentifier).toBe("com.acme.inbox");
    expect(config.android?.package).toBe("com.acme.inbox");
  });

  it("refuses a build on Expo's builders without the project, which would get no push token", () => {
    expect(() => appConfig({ EAS_BUILD: "true" })).toThrow(/EAS_PROJECT_ID/);
    expect(appConfig({ EAS_BUILD: "true", EAS_PROJECT_ID: "project-1" }).extra).toEqual({ eas: { projectId: "project-1" } });
  });

  it("takes Android's Firebase config from the environment only", () => {
    expect(appConfig({}).android?.googleServicesFile).toBeUndefined();
    expect(appConfig({ GOOGLE_SERVICES_JSON: "/builds/google-services.json" }).android?.googleServicesFile).toBe("/builds/google-services.json");
  });

  it("builds expo-notifications from its source, which the repository's patch changes (Android's prebuilt copy has no unlock requirement, nor iOS's the background time for an action)", () => {
    expect(packageJson.expo.autolinking.android.buildFromSource).toContain("expo-notifications");
    expect(packageJson.expo.autolinking.ios.buildFromSource).toContain("expo-notifications");
  });

  it("keeps both platforms' changes in the expo-notifications patch: the unlock requirement and an action's background time", () => {
    const patch = readFileSync(new URL("../../../patches/expo-notifications.patch", import.meta.url), "utf8");
    // Android: an action only on an unlocked phone.
    expect(patch).toContain("setAuthenticationRequired(true)");
    // iOS: a background task while the JavaScript acts, or iOS suspends the app before its request goes out.
    expect(patch).toContain("beginBackgroundTask");
  });
});
