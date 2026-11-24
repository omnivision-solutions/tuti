import { describe, expect, it } from "vitest";
import { appConfig } from "../app.config";

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
});
