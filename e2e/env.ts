import { generateKeyPairSync } from "node:crypto";

// Another port lets two checkouts run their journeys at once (E2E_PORT=3300 pnpm test:e2e): each uses it and the next one.
const PORT = Number(process.env.E2E_PORT || 3200);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`E2E_PORT must be a port number from 1 to 65535, not "${process.env.E2E_PORT}"`);
}
export const APP_URL = `http://localhost:${PORT}`;

/** A project's portal; *.localhost resolves to this machine in Chromium. */
export const portalUrl = (slug: string) => `http://${slug}.localhost:${PORT}`;

/** The same app as Tuti's cloud, which sells plans (cloudEnv), on the next port and the same database: for Billing's journeys. */
const CLOUD_PORT = PORT + 1;
export const CLOUD_URL = `http://localhost:${CLOUD_PORT}`;
export const cloudPortalUrl = (slug: string) => `http://${slug}.localhost:${CLOUD_PORT}`;

/** The project whose portal is on the app's own domain (APP_PORTAL_PROJECT). */
export const APP_PORTAL_SLUG = "e2e-app-portal";
/** The only account that can create it (APP_PORTAL_OWNER), once its address is verified. */
export const APP_PORTAL_OWNER = "e2e-app-portal-owner@example.com";
/** The project whose widget the cloud's team app shows (APP_WIDGET_PROJECT). */
export const APP_WIDGET_SLUG = "e2e-app-widget";
/** Support email in journeys: projects' addresses are on this domain, and journeys sign received mail with this secret. */
export const SUPPORT_EMAIL_DOMAIN = "tuti.email.example";
export const INBOUND_SECRET = "e2e-inbound-secret";

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
  AI_MODEL_ANSWERS: "",
  AI_MODEL_ESCALATIONS: "",
  AI_MODEL_SUPPORT: "",
  AI_MODEL_CHANGELOG: "",
  AI_MODEL_CODE_CHANGES: "",
  // A cap on the models projects pick, like Tuti's cloud: the model fake's Sonnet ($15 per million output tokens) is the most it allows.
  AI_MODEL_MAX_PRICE: "15",
  // AI credits on, like Tuti's cloud, with plenty for every project (the model fake's requests cost a sliver).
  AI_CREDITS: "on",
  AI_CREDITS_FREE: "1000",
  AI_CREDITS_PER_TOPUP_DOLLAR: "",
  AI_CREDITS_PER_USAGE_DOLLAR: "",
  AI_CREDITS_TOPUP_EXPIRY_DAYS: "",
  // A self-hosted server: no plans (the cloud's server sells them, below), so every feature is on.
  PLANS: "",
  AI_CREDITS_PRO: "",
  AI_CREDITS_BUSINESS: "",
  HATCHET_CLIENT_TOKEN: "",
  SMTP_USERNAME: "",
  SMTP_PASSWORD: "",
  EMAIL_FROM: "Tuti Test <test@example.com>",
  // Support email on: journeys post received mail to /api/inbound/email, signed like a receiver would.
  SUPPORT_EMAIL_DOMAIN: SUPPORT_EMAIL_DOMAIN,
  INBOUND_SECRET: INBOUND_SECRET,
  // Custom domains on: journeys use <name>.<project>.localhost, which Chromium sends to this machine.
  CUSTOM_DOMAIN_TARGET: "customers.example.com",
  // Tuti's own portal on the app's domain: the project app-portal.spec.ts makes.
  APP_PORTAL_PROJECT: APP_PORTAL_SLUG,
  // Only this address (verified) can create that project.
  APP_PORTAL_OWNER: APP_PORTAL_OWNER,
  // A licence server too, like tuti.so, with a private key made for the run (its keys don't verify
  // anywhere: installations trust only Tuti's public keys), so the licence page has a journey.
  LICENSE_PRIVATE_KEY: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  // And its licence checks ask itself, never tuti.so.
  LICENSE_SERVER_URL: APP_URL,
};

/** What the cloud's server changes: its address, plans sold (Stripe's prices are the fake's), with the default credits a month, and its own widget. */
export const cloudEnv = {
  PORT: String(CLOUD_PORT),
  APP_URL: CLOUD_URL,
  PORTAL_URL_TEMPLATE: `http://{project}.localhost:${CLOUD_PORT}`,
  PLANS: "on",
  // Tuti's own widget in its team app: the project app-widget.spec.ts makes.
  APP_WIDGET_PROJECT: APP_WIDGET_SLUG,
};
