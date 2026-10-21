// Another port lets two checkouts run their journeys at once (E2E_PORT=3300 pnpm test:e2e).
const PORT = Number(process.env.E2E_PORT || 3200);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`E2E_PORT must be a port number from 1 to 65535, not "${process.env.E2E_PORT}"`);
}
export const APP_URL = `http://localhost:${PORT}`;

/** A project's portal; *.localhost resolves to this machine in Chromium. */
export const portalUrl = (slug: string) => `http://${slug}.localhost:${PORT}`;

/** The project whose portal is on the app's own domain (APP_PORTAL_PROJECT). */
export const APP_PORTAL_SLUG = "e2e-app-portal";

export const serverEnv = {
  PORT: String(PORT),
  APP_URL,
  PORTAL_URL_TEMPLATE: `http://{project}.localhost:${PORT}`,
  BETTER_AUTH_SECRET: "e2e-secret-at-least-32-characters-long",
  JOBS_DRIVER: "inline",
  // Journeys receive webhooks on localhost.
  WEBHOOK_ALLOW_PRIVATE_URLS: "true",
  // Empty, not unset: Next.js would otherwise fill them from a local .env file.
  // (The global setup points OPENAI_* at the local fake.)
  OPENAI_API_KEY: "",
  // (And OPENROUTER_* at the model fake; AI_MODEL stays the default.)
  AI_MODEL: "",
  HATCHET_CLIENT_TOKEN: "",
  SMTP_USERNAME: "",
  SMTP_PASSWORD: "",
  EMAIL_FROM: "Tuti Test <test@example.com>",
  // Custom domains on: journeys use <name>.<project>.localhost, which Chromium sends to this machine.
  CUSTOM_DOMAIN_TARGET: "customers.example.com",
  // Tuti's own portal on the app's domain: the project app-portal.spec.ts makes.
  APP_PORTAL_PROJECT: APP_PORTAL_SLUG,
};
