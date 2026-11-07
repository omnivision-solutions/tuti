import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_INTERCOM_TOKEN } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { newPerson, signUp } from "./helpers";

test("in the first run the team comes from Intercom: a bad token is refused, a good one brings its users and help center across", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);

  // Intercom: its users and help center, with an access token made in its Developer Hub.
  await owner.getByRole("radio", { name: /^Intercom/ }).check();
  await expect(owner.getByText("Bring your users and help center across with an access token.")).toBeVisible();
  const keysLink = owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ });
  await expect(keysLink).toHaveAttribute("href", "https://app.intercom.com/a/apps/_/developer-hub");
  await expect(owner.getByText("In Intercom's Developer Hub, open or create an app; its access token is under Authentication. It's kept only while the import runs.")).toBeVisible();
  // Only what Intercom has: no Feedback, Team or Inbox.
  await expect(owner.getByRole("checkbox", { name: /^Feedback/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Team/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await owner.getByRole("checkbox", { name: /^Help center/ }).check();
  await checkpoint(owner, "setup-intercom");

  // A token Intercom refuses: said under the field, nothing started.
  const key = owner.getByRole("textbox", { name: "API key" });
  await key.fill("not_a_real_token");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Intercom didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();

  await key.fill(FAKE_INTERCOM_TOKEN);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Intercom" });
  await expect(status).toHaveText("Imported from Intercom. 3 contacts, 3 collections, 3 articles, 1 article as a draft (only some people could see it), 1 profile picture brought across.", { timeout: 15_000 });
  await checkpoint(owner, "setup-intercom-imported");

  // Its users, by their id in the team's app or Intercom's.
  await owner.goto(`/app/${slug}/users`);
  await expect(owner.getByText("Mira Patel")).toBeVisible();
  await expect(owner.getByText("Tobias Weber")).toBeVisible();

  // On the portal: the collections, and an article whose link to another goes to its page here.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const cards = visitor.getByRole("list", { name: "Collections" });
  await expect(cards.getByRole("link", { name: /^Getting started/ })).toContainText("Your first steps.");
  await expect(cards.getByRole("link", { name: /^Billing/ })).toBeVisible();
  await visitor.goto("/docs/welcome-to-acme");
  const welcome = visitor.getByRole("article", { name: "Welcome to Acme" });
  await expect(welcome.getByRole("heading", { name: "Start here", level: 2 })).toBeVisible();
  await expect(welcome.getByRole("img", { name: "The dashboard" })).toBeVisible();
  const link = welcome.getByRole("paragraph").getByRole("link", { name: "Paying by card" });
  await expect(link).toHaveAttribute("href", "/docs/paying-by-card");
  await checkpoint(visitor, "portal-intercom-article");
  await link.click();
  await visitor.waitForURL(`${portalUrl(slug)}/docs/paying-by-card`);
  await expect(visitor.getByRole("article", { name: "Paying by card" })).toContainText("We take Visa and Mastercard.");
});
