import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

export type SocialProvider = "google" | "github";

export const SOCIAL_PROVIDER_NAMES: Record<SocialProvider, string> = { google: "Google", github: "GitHub" };

const trim = (url: string) => url.replace(/\/$/, "");

/**
 * "Continue with Google" and "Continue with GitHub" for Tuti accounts (the app's sign-in and sign-up, not
 * portals), each on once its client ID and secret are set. Through Better Auth's generic OAuth, so tests point
 * them at local fakes (GOOGLE_URL, GITHUB_URL and GITHUB_API_URL). Someone whose verified email already has
 * an account signs in to it; Better Auth links only when that account's email is verified too, so nobody
 * can sign up with someone else's address first and wait for them to arrive.
 */
export function socialSignInConfig(appOrigin: string): GenericOAuthConfig[] {
  const env = process.env;
  const callback = (id: SocialProvider) => `${appOrigin}/api/auth/callback/${id}`;
  const config: GenericOAuthConfig[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    // Tests only: one host for Google's authorize and token endpoints.
    const fake = env.GOOGLE_URL && trim(env.GOOGLE_URL);
    config.push({
      providerId: "google",
      name: "Google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizationUrl: fake ? `${fake}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: fake ? `${fake}/token` : "https://oauth2.googleapis.com/token",
      // The ID token from the token endpoint (over TLS, for our client secret) has the email, whether
      // Google verified it, the name and the photo.
      scopes: ["openid", "email", "profile"],
      prompt: "select_account",
      redirectURI: callback("google"),
    });
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    const url = trim(env.GITHUB_URL || "https://github.com");
    const api = trim(env.GITHUB_API_URL || "https://api.github.com");
    config.push({
      providerId: "github",
      name: "GitHub",
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      authorizationUrl: `${url}/login/oauth/authorize`,
      tokenUrl: `${url}/login/oauth/access_token`,
      // An OAuth App needs these; a GitHub App ignores them and needs "Email addresses" (read).
      scopes: ["read:user", "user:email"],
      redirectURI: callback("github"),
      async getUserInfo({ accessToken }) {
        const get = async <T>(path: string) => {
          const response = await fetch(`${api}${path}`, {
            headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "Tuti" },
          });
          return response.ok ? ((await response.json()) as T) : null;
        };
        const [user, emails] = await Promise.all([
          get<{ id: number; login: string; name: string | null; avatar_url: string }>("/user"),
          get<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails"),
        ]);
        // Only an address GitHub verified: the primary one, else another.
        const email = emails?.find((e) => e.primary && e.verified) ?? emails?.find((e) => e.verified);
        if (!user || !email) {
          return null;
        }
        return { id: String(user.id), name: user.name || user.login, email: email.email, emailVerified: true, image: user.avatar_url };
      },
    });
  }
  return config;
}

/** The providers set up on this server, for the sign-in and sign-up pages. */
export const socialProviders = (): SocialProvider[] =>
  socialSignInConfig("").map((config) => config.providerId as SocialProvider);

/** What went wrong, for the page a failed Continue with … came back to. */
export function socialSignInError(error: unknown, via: unknown): string | undefined {
  if (typeof error !== "string" || !error) {
    return undefined;
  }
  const name = SOCIAL_PROVIDER_NAMES[via as SocialProvider] ?? "that account";
  if (error === "account_not_linked") {
    return `This email already has a Tuti account that isn't verified yet. Sign in with your password and verify your email, then you can continue with ${name}.`;
  }
  return via === "github"
    ? "Signing in with GitHub didn't work. It needs a verified email address on your GitHub account. Try again, or use your email."
    : `Signing in with ${name} didn't work. Try again, or use your email.`;
}
