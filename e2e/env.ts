// Another port lets two checkouts run their journeys at once (E2E_PORT=3300 pnpm test:e2e).
const PORT = Number(process.env.E2E_PORT || 3200);
export const APP_URL = `http://localhost:${PORT}`;

/** A project's portal; *.localhost resolves to this machine in Chromium. */
export const portalUrl = (slug: string) => `http://${slug}.localhost:${PORT}`;

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
};
