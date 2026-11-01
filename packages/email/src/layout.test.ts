import { render } from "@react-email/render";
import { afterEach, expect, test, vi } from "vitest";

import { conversationEmail } from "./conversation-email";
import { shippedEmail } from "./shipped-email";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("Tuti's logo and footer go only on emails about Tuti; those a team's customers get keep the plain wordmark", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  const inbox = await render(
    conversationEmail({ projectName: "Acme", from: "Ann", isNew: true, subject: "Hi", body: "Hello", url: "https://tuti.example/c", assigned: true }).body,
    { plainText: true },
  );
  expect(inbox).toMatch(/^tuti Inbox/);
  expect(inbox).toContain("feedback, roadmap and changelog");
  const shipped = shippedEmail({ projectName: "Acme", postTitle: "Dark mode", postUrl: "https://acme.example/p/1", unsubscribeUrl: "https://acme.example/u" });
  const [html, text] = await Promise.all([render(shipped.body), render(shipped.body, { plainText: true })]);
  expect(html).not.toContain("email-logo.png");
  expect(text).not.toContain("feedback, roadmap and changelog");
  expect(text).toMatch(/^tuti\n/);
});
