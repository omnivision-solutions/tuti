/** Fail fast on startup when required env vars are missing. */
export function assertEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
