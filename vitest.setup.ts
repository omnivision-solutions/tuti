/**
 * Tests are offline by default: they never see a real database, OpenAI, OpenRouter,
 * Hatchet, mail server, media storage, GitHub or Stripe (nor the AI_ settings: models, their cap, credits), whatever is in the shell or a .env file. Tests that need one of
 * these set it up themselves (e.g. the database tests start their own Postgres).
 */
for (const name of Object.keys(process.env)) {
  if (name === "DATABASE_URL" || name === "OPENAI_API_KEY" || name.startsWith("HATCHET_CLIENT_") || name.startsWith("SMTP_") || name.startsWith("MEDIA_") || name.startsWith("GITHUB_") || name.startsWith("OPENROUTER_") || name.startsWith("AI_") || name === "DECISION_MODEL" || name.startsWith("STRIPE_")) {
    delete process.env[name];
  }
}
