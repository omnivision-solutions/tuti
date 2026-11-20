import { checkConfig } from "@tuti/shared/config";

// Runs once when the server starts: the same config file as the app (its analytics section), checked the same way.
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    checkConfig();
  }
}
