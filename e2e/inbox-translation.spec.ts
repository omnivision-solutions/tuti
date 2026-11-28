import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, signUp, trpcRequest } from "./helpers";
import { modelRequests, nextModelReply } from "./model";

test.use({ viewport: { width: 1440, height: 900 } });

/** The model's answer to a translation request: the language it says (when asked) and the one segment's text. */
const translated = (text: string, language?: string) => JSON.stringify({ ...(language && { language }), segments: { "1": text } });

test("a German conversation: the customer's message read in English, the reply previewed and sent in German", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);

  // Settings → Inbox and email: off by default, turned on there; the team language is English.
  await owner.goto(`/app/${slug}/settings/support`);
  const translate = owner.getByRole("switch", { name: "Translate conversations" });
  await expect(translate).not.toBeChecked();
  await expect(owner.getByRole("combobox", { name: "Team language" })).toContainText("English");
  await translate.click();
  await expect(owner.getByText("Translation on")).toBeVisible();
  await expect(translate).toBeChecked();
  // Saved: the switch takes clicks again.
  await expect(translate).toBeEnabled();
  await checkpoint(owner, "settings-translation-on");
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(translate).toBeVisible();
  await checkpoint(owner, "settings-translation-on-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });
  // The team language is saved as it's picked; back to English for the conversation.
  const language = owner.getByRole("combobox", { name: "Team language" });
  for (const name of ["Deutsch", "English"]) {
    await language.click();
    await owner.getByRole("option", { name }).click();
    await expect(owner.getByText("Team language saved").last()).toBeVisible();
    await expect(language).toBeEnabled();
    await owner.reload();
    await expect(language).toContainText(name);
  }

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

  // A page loaded before the project translated: a reply that can't be translated is refused, and the page comes back
  // with the preview box and its "Send in English".
  await api("/support", { translate: false }, "PATCH");
  await owner.reload();
  await api("/support", { translate: true }, "PATCH");
  const late = `Is it working now (${slug})?`;
  // Refused on send (asked twice); the page then shows that failure, without asking again.
  await nextModelReply("Not a translation", late);
  await nextModelReply("Not a translation", late);
  await owner.getByRole("textbox", { name: "Reply" }).fill(late);
  await expect(preview).toBeHidden();
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(preview).toContainText("Couldn't translate it into Deutsch");
  await preview.getByRole("button", { name: "Send in English" }).click();
  await expect(messages.getByRole("listitem").last()).toContainText(late);
  await expect(preview).toBeHidden();
  // The send's two asks only: the page that came back showed its failure without paying for another.
  expect((await modelRequests()).filter((request) => request.user.includes(late))).toHaveLength(2);
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
  const retrying = trpcRequest(owner, "conversations.retryTranslation");
  await messages.getByRole("button", { name: "Try again" }).click();
  await retrying;
  await expect(messages).toContainText(english);
  await expect(messages).toContainText("Translated from Deutsch");
  await expect(messages.getByRole("button", { name: "Try again" })).toBeHidden();
});

test("in the widget, a German customer gets the team's reply in German, with what the team wrote under Show original", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/support", { inbox: true, translate: true }, "PATCH");

  // A reader signed in on the portal writes in German from the widget's Messages.
  const kai = await signUp(browser, portalUrl(slug), "Kai");
  const german = `Wo finde ich meine Rechnungen (${slug})?`;
  await nextModelReply(translated(`Where do I find my invoices (${slug})?`, "de"), slug);
  await kai.goto(`${portalUrl(slug)}/widget?tab=messages`);
  await kai.getByRole("button", { name: "New message" }).click();
  await kai.getByRole("textbox", { name: "Message" }).fill(german);
  await kai.getByRole("button", { name: "Send" }).click();
  const thread = kai.getByRole("list", { name: "Messages" });
  await expect(thread).toContainText(german);

  // The team replies in English, sent in German.
  const reply = `In Billing → Invoices (${slug}).`;
  const inGerman = `Unter Abrechnung → Rechnungen (${slug}).`;
  await nextModelReply(translated(inGerman), reply);
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("textbox", { name: "Reply" }).fill(reply);
  await expect(owner.locator(".inbox-reply-translation")).toContainText(inGerman);
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" })).toContainText("Sent in Deutsch");

  // The customer reads the German; what the team wrote is a click away.
  await expect(thread).toContainText(inGerman);
  const original = thread.getByText(reply, { exact: true });
  await expect(original).toBeHidden();
  // A short window, so opening it needs scrolling past the sticky reply box.
  await kai.setViewportSize({ width: 390, height: 520 });
  await thread.getByText("Show original").click();
  await expect(original).toBeVisible();
  // Scrolled into view as it opens, clear of the reply box below it.
  await expect(original).toBeInViewport({ ratio: 1 });
  const shown = (await original.boundingBox())!;
  const replyBox = (await kai.getByRole("textbox", { name: "Reply" }).boundingBox())!;
  expect(shown.y + shown.height).toBeLessThanOrEqual(replyBox.y);
  await kai.setViewportSize({ width: 1280, height: 800 });
  await expect(thread.getByText("Hide original")).toBeVisible();
  // Each read in its own language's voice: the German reply marked German, what the team wrote marked English.
  await expect(thread.getByText(inGerman, { exact: true })).toHaveAttribute("lang", "de");
  await expect(original).toHaveAttribute("lang", "en");
  await checkpoint(kai, "widget-show-original");
  await kai.setViewportSize({ width: 390, height: 844 });
  await checkpoint(kai, "widget-show-original-phone");
});
