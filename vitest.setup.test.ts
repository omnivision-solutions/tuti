import { expect, test } from "vitest";

test("tests can't reach real services", () => {
  const leaked = Object.keys(process.env).filter(
    (name) => name === "DATABASE_URL" || name.startsWith("OPENAI_") || name.startsWith("HATCHET_CLIENT_") || name.startsWith("SMTP_") || name.startsWith("MEDIA_") || name.startsWith("GITHUB_") || name.startsWith("OPENROUTER_") || name.startsWith("AI_") || name === "DECISION_MODEL" || name.startsWith("CODE_CHANGES_") || name.startsWith("STRIPE_") || name.startsWith("SES_") || name.startsWith("ARTICLE_LIMIT_") || name.startsWith("FEATUREBASE_"),
  );
  expect(leaked).toEqual([]);
});
