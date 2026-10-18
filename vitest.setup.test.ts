import { expect, test } from "vitest";

test("tests can't reach real services", () => {
  const leaked = Object.keys(process.env).filter(
    (name) => name === "DATABASE_URL" || name === "OPENAI_API_KEY" || name.startsWith("HATCHET_CLIENT_") || name.startsWith("SMTP_"),
  );
  expect(leaked).toEqual([]);
});
