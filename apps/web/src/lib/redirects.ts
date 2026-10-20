/** Only same-site paths, so redirect parameters can't be used as open redirects. */
export function safeRedirectPath(redirect: string | undefined, fallback: string): string {
  if (
    !redirect ||
    !redirect.startsWith("/") ||
    redirect.startsWith("//") ||
    redirect.includes("\\") ||
    // Browsers drop tabs and newlines from URLs: "/\t/evil.example" would become "//evil.example".
    /[\u0000-\u001f\u007f]/.test(redirect)
  ) {
    return fallback;
  }
  return redirect;
}
