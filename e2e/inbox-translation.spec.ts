import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";
import { nextModelReply } from "./model";

test.use({ viewport: { width: 1440, height: 900 } });

/** The model's answer to a translation request: the language it says (when asked) and the one segment's text. */
const translated = (text: string, language?: string) => JSON.stringify({ ...(language && { language }), segments: { "1": text } });

test("a German conversation: the customer's message read in English, the reply previewed and sent in German", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/support", { translate: true }, "PATCH");

  // Its own words, so journeys side by side don't take each other's replies.
  const german = `Der Export-Knopf auf der Berichtsseite tut nichts (${slug}).`;
  const english = `The export button on the reports page does nothing (${slug}).`;
  await nextModelReply(translated(english, "de"), slug);
  await api("/conversations", { email: `e2e-kai-${slug}@example.com`, body: german });

  await owner.goto(`/app/${slug}/inbox/1`);
  const messages = owner.getByRole("list", { name: "Messages" });
  // In the team's language, with where it came from.
  await expect(messages).toContainText(english);
  await expect(messages).toContainText("Translated from Deutsch");
  await expect(messages).not.toContainText(german);
  await checkpoint(owner, "translated-message");
  await messages.getByRole("button", { name: "Show original" }).click();
  await expect(messages).toContainText(german);
  await expect(messages.getByRole("button", { name: "Show translation" })).toBeVisible();

  // The reply, written in English, previewed in German under it before it's sent.
  const reply = `Thanks! A fix is on its way (${slug}).`;
  const inGerman = `Danke! Eine Lösung ist unterwegs (${slug}).`;
  await nextModelReply(translated(inGerman), reply);
  await owner.getByRole("textbox", { name: "Reply" }).fill(reply);
  const preview = owner.locator(".inbox-reply-translation");
  await expect(preview).toContainText("They'll get it in Deutsch");
  await expect(preview).toContainText(inGerman);
  await checkpoint(owner, "reply-preview");
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeVisible();
  await checkpoint(owner, "reply-preview-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByText("Sent", { exact: true })).toBeVisible();
  // The team's own words shown, "Sent in Deutsch", and what the customer got a click away.
  const sent = messages.getByRole("listitem").last();
  await expect(sent).toContainText(reply);
  await expect(sent).toContainText("Sent in Deutsch");
  await expect(preview).toBeHidden();
  await checkpoint(owner, "sent-in-german");
  await sent.getByRole("button", { name: "Show translation" }).click();
  await expect(sent).toContainText(inGerman);
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "sent-in-german-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  // A reply that can't be translated (the model's answers fail its checks, twice) isn't sent until the team chooses
  // "Send in English": then it goes as written.
  const untranslatable = `Could you send a screenshot (${slug})?`;
  await nextModelReply("Not a translation", untranslatable);
  await nextModelReply("Not a translation", untranslatable);
  await owner.getByRole("textbox", { name: "Reply" }).fill(untranslatable);
  await expect(preview).toContainText("Couldn't translate it into Deutsch");
  await checkpoint(owner, "reply-not-translated");
  await preview.getByRole("button", { name: "Send in English" }).click();
  await expect(messages.getByRole("listitem").last()).toContainText(untranslatable);
  await expect(messages.getByRole("listitem").last()).not.toContainText("Sent in");
  await expect(preview).toBeHidden();
});

test("a customer's message that couldn't be translated shows as written, with Try again", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/support", { translate: true }, "PATCH");

  const german = `Ich kann mich seit gestern nicht mehr anmelden (${slug}).`;
  const english = `I haven't been able to sign in since yesterday (${slug}).`;
  // Its translation fails its checks, twice.
  await nextModelReply("Not a translation", slug);
  await nextModelReply("Not a translation", slug);
  await api("/conversations", { email: `e2e-kai-${slug}@example.com`, body: german });

  await owner.goto(`/app/${slug}/inbox/1`);
  const messages = owner.getByRole("list", { name: "Messages" });
  await expect(messages).toContainText(german);
  await expect(messages).toContainText("Couldn't translate it");
  await checkpoint(owner, "translation-failed");
  await nextModelReply(translated(english, "de"), slug);
  await messages.getByRole("button", { name: "Try again" }).click();
  await expect(messages).toContainText(english);
  await expect(messages).toContainText("Translated from Deutsch");
  await expect(messages.getByRole("button", { name: "Try again" })).toBeHidden();
});
