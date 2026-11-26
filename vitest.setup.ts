/**
 * Tests are offline by default: they never see a real database, an AI provider (OPENAI_*; the old OPENROUTER_* only earn a warning, still kept out),
 * Hatchet, mail server, media storage, GitHub, Stripe or Amazon SES (nor the AI_ settings: models, their cap, credits; nor Autopilot's, CODE_CHANGES_; nor the config file, TUTI_CONFIG; nor plans: BILLING_CONFIG, and the PLANS it replaced; nor Featurebase, FEATUREBASE_, Intercom, INTERCOM_, Ferndesk, FERNDESK_, Canny, CANNY_, Frill, FRILL_, or Nolt, NOLT_; nor Expo's push service, EXPO_), whatever is in the shell or a .env file. Tests that need one of
 * these set it up themselves (e.g. the database tests start their own Postgres).
 */
for (const name of Object.keys(process.env)) {
  if (name === "DATABASE_URL" || name.startsWith("OPENAI_") || name.startsWith("HATCHET_CLIENT_") || name.startsWith("SMTP_") || name.startsWith("MEDIA_") || name.startsWith("GITHUB_") || name.startsWith("OPENROUTER_") || name.startsWith("AI_") || name === "DECISION_MODEL" || name.startsWith("CODE_CHANGES_") || name.startsWith("STRIPE_") || name.startsWith("SES_") || name === "BILLING_CONFIG" || name === "TUTI_CONFIG" || name === "PLANS" || name.startsWith("FEATUREBASE_") || name.startsWith("INTERCOM_") || name.startsWith("FERNDESK_") || name.startsWith("CANNY_") || name.startsWith("FRILL_") || name.startsWith("NOLT_") || name.startsWith("POSTHOG_") || name.startsWith("EXPO_")) {
    delete process.env[name];
  }
}

