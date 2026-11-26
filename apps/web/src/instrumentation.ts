import { assertEnv, billingConfig, checkAiProvider, checkConfig, log } from "@tuti/shared";
import { assertSesSettings } from "@tuti/shared/ses";

// Runs once when the server starts (not during `next build`).
export async function register() {
  assertEnv(["DATABASE_URL", "BETTER_AUTH_SECRET", "APP_URL", "PORTAL_URL_TEMPLATE"]);
  assertSesSettings();
  // Once, where the server's code runs (not again for the edge runtime): a bad value stops start-up, the values are logged.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    checkConfig();
    billingConfig();
    // Not awaited: a slow or wrong AI provider is logged, never holds up the start (AI is optional).
    void checkAiProvider();
  }
  // Without Hatchet (jobs inline), nothing runs on a schedule: the server applies Autopilot's due updates itself, every minute,
  // emails posts' authors the comments due to them (comment-emails-due), and every 10 minutes analyses again what the AI
  // provider didn't answer, once it's due (code-change-retries). Imports whose wait is over, or that are stuck, go on
  // each minute (resume-imports), and those that haven't moved for a day are failed, their keys cleared, each hour.
  // (Journeys turn it off, AUTOPILOT_TIMER=off, and run the minute by hand at /api/autopilot/due.)
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.JOBS_DRIVER === "inline" && process.env.AUTOPILOT_TIMER !== "off") {
    const { runDueAutopilot } = await import("@/server/operations/code-changes");
    const { handlers, sendAutopilotDigests, sendAutopilotEmails } = await import("@tuti/jobs");
    const minute = async () => {
      await runDueAutopilot();
      await sendAutopilotEmails();
      await sendAutopilotDigests();
    };
    setInterval(() => void minute().catch((error) => log.error("Autopilot's minute failed", { error })), 60_000).unref();
    setInterval(() => void handlers.commentEmailsDue({}, log).catch((error) => log.error("Comment emails' minute failed", { error })), 60_000).unref();
    setInterval(() => void handlers.retryCodeChanges({}, log).catch((error) => log.error("Autopilot's retries failed", { error })), 10 * 60_000).unref();
    setInterval(() => void handlers.resumeImports({}, log).catch((error) => log.error("Resuming imports failed", { error })), 60_000).unref();
    setInterval(() => void handlers.retryArticleTranslations({}, log).catch((error) => log.error("Retrying article translations failed", { error })), 15 * 60_000).unref();
    // A changelog entry's emails still due (one whose announcement waited for its translations past ANNOUNCEMENT_WAITS_MS,
    // or whose sending failed): every 10 minutes, as its cron runs on Hatchet.
    setInterval(() => void handlers.resubmitChangelogEmails({}, log).catch((error) => log.error("Resubmitting changelog emails failed", { error })), 10 * 60_000).unref();
    setInterval(() => void handlers.failStaleImports({}, log).catch((error) => log.error("Failing stale imports failed", { error })), 60 * 60_000).unref();
  }
}
