import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_FERNDESK_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { moreView, newPerson, signUp } from "./helpers";

test("in the first run the team comes from Ferndesk: a bad key is refused, a good one brings its help center to the portal, its users as Users and its AI conversations to the Inbox", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);

  // Ferndesk: its key, made in its dashboard, and only the parts it has.
  await owner.getByRole("radio", { name: /^Ferndesk/ }).check();
  await expect(owner.getByText("Bring your help center, its users and your AI assistant's conversations across with an API key.")).toBeVisible();
  await expect(owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ })).toHaveAttribute("href", "https://ferndesk.com/app/settings/developers");
  await expect(owner.getByText("In Ferndesk, Developers → API → New API key, with Full access (it reads drafts and AI conversations). It's kept only while the import runs.")).toBeVisible();
  await expect(owner.getByRole("checkbox", { name: /^Team/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Feedback/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  // What each part brings from Ferndesk: its users have no company; its conversations are the AI's.
  await expect(owner.getByText("Your help center's users, with their attributes, as Users.")).toBeVisible();
  await expect(owner.getByText("Your AI assistant's conversations with readers, closed, as the Inbox.")).toBeVisible();
  // Picking the help center asks how its published articles come: Ferndesk doesn't say which were private, so drafts to begin with.
  const publishAs = owner.getByRole("radiogroup", { name: "Articles published in Ferndesk" });
  await expect(publishAs).toHaveCount(0);
  await owner.getByRole("checkbox", { name: /^Help center/ }).check();
  await owner.getByRole("checkbox", { name: /^Inbox/ }).check();
  await expect(publishAs.getByText("Ferndesk doesn't tell Tuti which articles only some people could read, so bringing them as published could put internal ones live.")).toBeVisible();
  await expect(publishAs.getByRole("radio", { name: /^As drafts/ })).toBeChecked();
  await checkpoint(owner, "setup-ferndesk");
  // This team's help center is all public.
  await publishAs.getByRole("radio", { name: /^As published/ }).check();

  // A key Ferndesk refuses: said under the field, nothing started.
  const key = owner.getByRole("textbox", { name: "API key" });
  await key.fill("fdsk_not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Ferndesk didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();

  await key.fill(FAKE_FERNDESK_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Ferndesk" });
  await expect(status).toHaveText("Imported from Ferndesk. 2 contacts, 5 collections, 4 articles, 2 conversations brought across.", { timeout: 15_000 });
  await checkpoint(owner, "setup-ferndesk-imported");

  // On the portal: its sections as collections, an article with its image and its link to another, which goes there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const cards = visitor.getByRole("list", { name: "Collections" });
  await expect(cards.getByRole("link", { name: /^Guides/ })).toBeVisible();
  await expect(cards.getByRole("link", { name: /^API/ })).toBeVisible();
  await visitor.goto("/docs/welcome-to-acme");
  const welcome = visitor.getByRole("article", { name: "Welcome to Acme" });
  await expect(welcome.getByRole("heading", { name: "Start here", level: 2 })).toBeVisible();
  await expect(welcome.getByRole("img", { name: "The dashboard" })).toBeVisible();
  await checkpoint(visitor, "portal-ferndesk-article");
  const link = welcome.getByRole("paragraph").getByRole("link", { name: "Paying by card" });
  await expect(link).toHaveAttribute("href", "/docs/paying-by-card");
  await link.click();
  await visitor.waitForURL(`${portalUrl(slug)}/docs/paying-by-card`);
  await expect(visitor.getByRole("article", { name: "Paying by card" })).toContainText("Cards are charged on the 1st.");

  // The AI assistant's conversations: history, closed, the user's question and the AI's answer.
  await owner.goto(`/app/${slug}/inbox`);
  await (await moreView(owner, /^Closed/)).click();
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "Can I export my data to CSV?" }).getByRole("link").click();
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0)).toContainText("Mira Fenwick");
  await expect(messages.nth(0)).toContainText("Can I export my data to CSV?");
  await expect(messages.nth(1)).toContainText("Yes: Settings → Export.");
  await checkpoint(owner, "conversation-ferndesk");
});
