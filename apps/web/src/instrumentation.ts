import { assertEnv } from "@tuti/shared";

// Runs once when the server starts (not during `next build`).
export function register() {
  assertEnv(["DATABASE_URL", "BETTER_AUTH_SECRET", "APP_URL", "PORTAL_URL_TEMPLATE"]);
}
