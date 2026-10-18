/**
 * Tests are offline by default: they never see a real database, OpenAI or
 * Hatchet, whatever is in the shell or a .env file. Tests that need one of
 * these set it up themselves (e.g. the database tests start their own Postgres).
 */
for (const name of Object.keys(process.env)) {
  if (name === "DATABASE_URL" || name === "OPENAI_API_KEY" || name.startsWith("HATCHET_CLIENT_")) {
    delete process.env[name];
  }
}
