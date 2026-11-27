import { generateKeyPairSync } from "node:crypto";

import { CONFIG_REPLACED } from "../packages/shared/src/config";
import { billingFile, withAppsumoPlans } from "../packages/testkit/src/billing";
import { FAKE_CLOUDFLARE_ZONE } from "../packages/testkit/src/cloudflare-fake";
import { configFile } from "../packages/testkit/src/config-file";

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
/** Tuti's cloud with a free trial in its billing file (trialEnv), on the port after: an account's first project there starts one. */
const TRIAL_PORT = PORT + 2;
export const TRIAL_URL = `http://localhost:${TRIAL_PORT}`;
export const trialPortalUrl = (slug: string) => `http://${slug}.localhost:${TRIAL_PORT}`;

/** The project whose portal is on the app's own domain (ownPortal.project). */
export const APP_PORTAL_SLUG = "e2e-app-portal";
/** The only account that can create it (ownPortal.owner), once its address is verified. */
export const APP_PORTAL_OWNER = "e2e-app-portal-owner@example.com";
/** The project whose widget the cloud's team app shows (ownPortal.widgetProject). */
export const APP_WIDGET_SLUG = "e2e-app-widget";
/** Support email in journeys: projects' addresses are on this domain, and journeys sign received mail with this secret. */
export const SUPPORT_EMAIL_DOMAIN = "tuti.email.example";
export const INBOUND_SECRET = "e2e-inbound-secret";
/** Stripe's customer portal login link in the cloud's billing file, where licence buyers cancel. */
export const STRIPE_PORTAL_LOGIN_URL = "https://billing.stripe.example/p/login/e2e";

/** The servers' config file (TUTI_CONFIG): what journeys need off its defaults. */
/** The journeys' config file (TUTI_CONFIG): what it leaves out is its default. */
const e2eConfig = {
  // A cap on the models projects pick: the model fake's Opus ($25 per million output tokens), Best's largest, is the most it allows.
  ai: { maxPrice: 25 },
  // Tuti's own portal on the app's domain: the project app-portal.spec.ts makes; only this address (verified) can create it.
  ownPortal: { project: APP_PORTAL_SLUG, owner: APP_PORTAL_OWNER },
  // Custom domains on: journeys use <name>.<project>.localhost, which Chromium sends to this machine. Certificates
  // from the Cloudflare fake (global-setup.ts), in its zone.
  customDomains: { target: "customers.example.com", cloudflareZoneId: FAKE_CLOUDFLARE_ZONE },
  // Credits on, like Tuti's cloud, with plenty for every project (the model fake's requests cost a sliver).
  credits: { enabled: true, free: 1000 },
  // The spam filter's decision model on, which the model fake answers "not spam" for every new conversation (global
  // setup), so Settings → Spam shows its guidance; it checks only a project that wrote it. The chat model off.
  spam: { chat: { model: "off" } },
};

export const serverEnv = {
  PORT: String(PORT),
  APP_URL,
  PORTAL_URL_TEMPLATE: `http://{project}.localhost:${PORT}`,
  BETTER_AUTH_SECRET: "e2e-secret-at-least-32-characters-long",
  JOBS_DRIVER: "inline",
  // Autopilot's minute runs when a journey asks (runAutopilot), not on a timer.
  AUTOPILOT_TIMER: "off",
  // Journeys receive webhooks on localhost.
  WEBHOOK_ALLOW_PRIVATE_URLS: "true",
  // Try it through Tuti may send to a fake API on this machine (honoured only while APP_URL is on localhost).
  TRY_IT_ALLOW_LOCALHOST: "true",
  SCREENSHOTS_ALLOW_LOCALHOST: "true",
  // Empty, not unset: Next.js would otherwise fill them from a local .env file.
  // (The global setup points OPENAI_* at the model fake; ai.model stays the default.)
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  // The journeys' config file, whatever a local .env points at (or still sets: a variable the file replaced stops
  // start-up). No analytics in it: journeys never send page views to PostHog.
  TUTI_CONFIG: configFile(e2eConfig),
  ...Object.fromEntries(Object.keys(CONFIG_REPLACED).map((name) => [name, ""])),
  // A self-hosted server: no plans (the cloud's server sells them, below), so every feature is on.
  BILLING_CONFIG: "",
  // What the billing file replaced, whatever a local .env still holds (left set without the file, it stops the server).
  PLANS: "",
  STRIPE_PORTAL_LOGIN_URL: "",
  ...Object.fromEntries(["PRO", "BUSINESS", "BADGE"].flatMap((plan) => [`STRIPE_PRICE_${plan}_MONTHLY`, `STRIPE_PRICE_${plan}_YEARLY`]).map((name) => [name, ""])),
  HATCHET_CLIENT_TOKEN: "",
  SMTP_USERNAME: "",
  SMTP_PASSWORD: "",
  // Amazon SES: the global setup points it at the fake, never a real account.
  SES_REGION: "",
  SES_ACCESS_KEY_ID: "",
  SES_SECRET_ACCESS_KEY: "",
  SES_CONFIGURATION_SET: "",
  SES_EVENTS_TOPIC_ARN: "",
  EMAIL_FROM: "Tuti Test <test@example.com>",
  // Support email on: journeys post received mail to /api/inbound/email, signed like a receiver would.
  SUPPORT_EMAIL_DOMAIN: SUPPORT_EMAIL_DOMAIN,
  INBOUND_SECRET: INBOUND_SECRET,
  // A licence server too, like tuti.so, with a private key made for the run (its keys don't verify
  // anywhere: installations trust only Tuti's public keys), so the licence page has a journey.
  LICENSE_PRIVATE_KEY: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  // And its licence checks ask itself, never tuti.so.
  LICENSE_SERVER_URL: APP_URL,
};

/** What the cloud's server changes: its address, plans sold (the tests' billing file: Free, Pro and Business at the Stripe fake's prices), and its own widget. */
export const cloudEnv = {
  PORT: String(CLOUD_PORT),
  APP_URL: CLOUD_URL,
  PORTAL_URL_TEMPLATE: `http://{project}.localhost:${CLOUD_PORT}`,
  // With AppSumo's tiers (hidden plans, for its licenses), and Stripe's customer portal for licence buyers.
  BILLING_CONFIG: billingFile((config) => {
    withAppsumoPlans(config);
    config.stripePortalLoginUrl = STRIPE_PORTAL_LOGIN_URL;
  }),
  // Tuti's own widget in its team app: the project app-widget.spec.ts makes.
  TUTI_CONFIG: configFile({ ...e2eConfig, ownPortal: { ...e2eConfig.ownPortal, widgetProject: APP_WIDGET_SLUG } }),
};

/** The cloud's server with a free trial: 7 days of Pro, with 500 credits. */
export const trialEnv = {
  PORT: String(TRIAL_PORT),
  APP_URL: TRIAL_URL,
  PORTAL_URL_TEMPLATE: `http://{project}.localhost:${TRIAL_PORT}`,
  BILLING_CONFIG: billingFile((config) => {
    config.trial = { plan: "pro", days: 7, credits: 500, emails: 1000 };
  }),
};
