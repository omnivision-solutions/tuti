import { assertEnv } from "@tuti/shared";

// Runs once when the server starts (not during `next build`).
export function register() {
  assertEnv(["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]);
}
