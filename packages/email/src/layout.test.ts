import { render } from "@react-email/render";
import type { Doc } from "@tuti/content";
import { afterEach, expect, test, vi } from "vitest";

import { changelogEmail } from "./changelog-email";
import { conversationEmail } from "./conversation-email";
import { accentColors, colors } from "./layout";
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
  // Too faint on the white card (a pale yellow): the darker shade of it the portal uses.
  const yellow = await html("#fde047");
  expect(yellow).not.toContain("#fde047");
  expect(yellow).toContain("border-top:4px solid #857525");
  expect(yellow).toContain("background-color:#857525;color:#ffffff");

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
  // A grey that's enough for a button (3:1) but not for text this size (under 4.5:1): links in the text colour.
  const grey = await render(
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", doc, unsubscribeUrl: "https://acme.example/u", accent: "#808080" }).body,
  );
  expect(grey).toMatch(new RegExp(`<a href="https://acme.example/docs" style="color:${colors.text}`));
  expect(grey).toContain("border-top:4px solid #808080");
});

test("an accent too faint on the white card takes the portal's shade of it, buttons and links alike; a grey or a pale tint, the text colour", () => {
  // The shades the portal's light mode gets (brandCss, branding.db.test.ts): mixed toward black until they read as text (4.5:1).
  expect(accentColors("#fde047")).toEqual({ accent: "#857525", onAccent: "#ffffff", link: "#857525" });
  expect(accentColors("#45b5f0")).toEqual({ accent: "#2f7ca5", onAccent: "#ffffff", link: "#2f7ca5" });
  // Beige's shade would be near grey, and white has no hue: the text colour, with white on it.
  for (const pale of ["#f5f5dc", "#ffffff"]) {
    expect(accentColors(pale)).toEqual({ accent: colors.text, onAccent: "#ffffff", link: colors.text });
  }
  // A dark blue already reads: as it is.
  expect(accentColors("#1e3a8a")).toEqual({ accent: "#1e3a8a", onAccent: "#ffffff", link: "#1e3a8a" });
  // Enough for a button (3:1) but not for text this size: the button as it is, links in its shade.
  expect(accentColors("#ea580c")).toEqual({ accent: "#ea580c", onAccent: "#000000", link: "#cb4c0a" });
});
