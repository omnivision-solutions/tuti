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

    it("is none when GitHub can't be reached", async () => {
      vi.stubEnv("GITHUB_CLIENT_ID", "id");
      vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
      const github = socialSignInConfig("https://tuti.example").find((config) => config.providerId === "github")!;
      expect(await github.getUserInfo!({ accessToken: "token" } as never)).toBeNull();
    });

    it("is required: with none verified, no sign-in", async () => {
      expect(await githubUser([{ email: "e2e-main@example.com", primary: true, verified: false }])).toBeNull();
    });
  });

  it("says why it didn't work only when it knows", () => {
    expect(socialSignInError("account_not_linked", "google", true)).toMatchObject({ reset: true, message: expect.stringContaining("Continue with Google works too") });
    // Without email no reset (or verification) is possible: the password is the way in.
    expect(socialSignInError("account_not_linked", "google", false)).toEqual({ message: "This email already has a Tuti account. Sign in with its password." });
    expect(socialSignInError("unable_to_get_user_info", "github", true)?.message).toContain("an email address GitHub has verified");
    // Cancelled at the provider, or anything else: no reason made up.
    expect(socialSignInError("access_denied", "github", true)).toEqual({ message: "Signing in with GitHub didn't work. Try again, or use your email." });
    expect(socialSignInError(undefined, "google", true)).toBeUndefined();
  });
});
