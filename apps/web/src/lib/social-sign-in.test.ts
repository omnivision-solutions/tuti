import { afterEach, describe, expect, it, vi } from "vitest";

import { socialProviders, socialSignInConfig, socialSignInError } from "./social-sign-in";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("social sign-in", () => {
  it("offers each provider once its client ID and secret are both set", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    expect(socialProviders()).toEqual(["github"]);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    expect(socialProviders()).toEqual(["google", "github"]);
    expect(socialSignInConfig("https://tuti.example")[0]!.redirectURI).toBe("https://tuti.example/api/auth/callback/google");
  });

  describe("Google's email", () => {
    const googleUser = async (claims: Record<string, unknown>) => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "id");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
      const google = socialSignInConfig("https://tuti.example").find((config) => config.providerId === "google")!;
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return google.getUserInfo!({ accessToken: "token", idToken: `${part({ alg: "RS256" })}.${part(claims)}.sig` } as never);
    };

    it("is the ID token's, once Google verified it", async () => {
      const user = await googleUser({ sub: "g-1", email: "e2e-gina@example.com", email_verified: true, name: "Gina" });
      expect(user).toMatchObject({ id: "g-1", email: "e2e-gina@example.com", emailVerified: true, name: "Gina" });
    });

    it("is required: an address Google hasn't verified, or none, signs nobody in", async () => {
      expect(await googleUser({ sub: "g-1", email: "e2e-gina@example.com", email_verified: false })).toBeNull();
      expect(await googleUser({ sub: "g-1", email: "e2e-gina@example.com" })).toBeNull();
      expect(await googleUser({ sub: "g-1" })).toBeNull();
    });
  });

  describe("GitHub's email", () => {
    const githubUser = async (emails: { email: string; primary: boolean; verified: boolean }[]) => {
      vi.stubEnv("GITHUB_CLIENT_ID", "id");
      vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
      vi.stubGlobal("fetch", async (url: string) =>
        Response.json(url.endsWith("/user/emails") ? emails : { id: 7, login: "octo", name: null, avatar_url: "https://avatars.example/7" }),
      );
      const github = socialSignInConfig("https://tuti.example").find((config) => config.providerId === "github")!;
      return github.getUserInfo!({ accessToken: "token" } as never);
    };

    it("is the primary address, once GitHub verified it", async () => {
      const user = await githubUser([
        { email: "e2e-other@example.com", primary: false, verified: true },
        { email: "e2e-main@example.com", primary: true, verified: true },
      ]);
      expect(user).toMatchObject({ id: "7", name: "octo", email: "e2e-main@example.com", emailVerified: true });
    });

    it("is another verified address when the primary one isn't verified", async () => {
      const user = await githubUser([
        { email: "e2e-main@example.com", primary: true, verified: false },
        { email: "e2e-other@example.com", primary: false, verified: true },
      ]);
      expect(user?.email).toBe("e2e-other@example.com");
    });

    it("is required: with none verified, no sign-in", async () => {
      expect(await githubUser([{ email: "e2e-main@example.com", primary: true, verified: false }])).toBeNull();
    });
  });

  it("explains an existing account that isn't verified, naming the provider", () => {
    expect(socialSignInError("account_not_linked", "google")).toContain("then you can continue with Google");
    expect(socialSignInError(undefined, "google")).toBeUndefined();
  });
});
