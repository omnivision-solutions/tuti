/** Only same-site paths, so redirect parameters can't be used as open redirects. */
export function safeRedirectPath(redirect: string | undefined, fallback: string): string {
  if (!redirect || !redirect.startsWith("/") || redirect.startsWith("//") || redirect.includes("\\")) {
    return fallback;
  }
  return redirect;
}
