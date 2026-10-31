import { assertEnv, log } from "@tuti/shared";
import { assertSesSettings } from "@tuti/shared/ses";

// Runs once when the server starts (not during `next build`).
export async function register() {
  assertEnv(["DATABASE_URL", "BETTER_AUTH_SECRET", "APP_URL", "PORTAL_URL_TEMPLATE"]);
  assertSesSettings();
  // Without Hatchet (jobs inline), nothing runs on a schedule: the server applies Autopilot's due updates itself, every minute.
  // (Journeys turn it off, AUTOPILOT_TIMER=off, and run the minute by hand at /api/autopilot/due.)
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.JOBS_DRIVER === "inline" && process.env.AUTOPILOT_TIMER !== "off") {
    const { runDueAutopilot } = await import("@/server/operations/code-changes");
    const { sendAutopilotEmails } = await import("@tuti/jobs");
    const minute = async () => {
      await runDueAutopilot();
      await sendAutopilotEmails();
    };
    setInterval(() => void minute().catch((error) => log.error("Autopilot's minute failed", { error })), 60_000).unref();
  }
}
