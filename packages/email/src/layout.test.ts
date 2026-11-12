import { render } from "@react-email/render";
import type { Doc } from "@tuti/content";
import { afterEach, expect, test, vi } from "vitest";

import { changelogEmail } from "./changelog-email";
import { conversationEmail } from "./conversation-email";
import { colors } from "./layout";
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

test("emails a project's customers get take its accent; Tuti's own wordmark stays green", async () => {
  const props = { projectName: "Acme", postTitle: "Dark mode", postUrl: "https://acme.example/p/1", unsubscribeUrl: "https://acme.example/u" };
  const html = (accent?: string | null) => render(shippedEmail({ ...props, accent }).body);

  const purple = await html("#7c3aed");
  expect(purple).toContain("border-top:4px solid #7c3aed");
  expect(purple).toContain("background-color:#7c3aed;color:#ffffff");
  expect(purple).toMatch(/color:#12804a[^>]*>tuti</);

  // A mid-tone that reads on white gets black text on its button.
  expect(await html("#ea580c")).toContain("background-color:#ea580c;color:#000000");
  // Too faint on the white card (a pale yellow): the text colour instead, with white on it.
  const yellow = await html("#fde047");
  expect(yellow).not.toContain("#fde047");
  expect(yellow).toContain(`border-top:4px solid ${colors.text}`);
  expect(yellow).toContain(`background-color:${colors.text};color:#ffffff`);

  // Without one (or with something that isn't a colour), Tuti's green as before.
  for (const accent of [null, "red;x:y"]) {
    const green = await html(accent);
    expect(green).toContain(`border-top:4px solid ${colors.green}`);
    expect(green).toContain(`background-color:${colors.green};color:${colors.onGreen}`);
  }
});

test("a changelog entry's links take the project's accent", async () => {
  const doc: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://acme.example/docs" } }] }] }] };
  const html = await render(
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", doc, unsubscribeUrl: "https://acme.example/u", accent: "#7c3aed" }).body,
  );
  expect(html).toMatch(/<a href="https:\/\/acme.example\/docs" style="color:#7c3aed/);
});
