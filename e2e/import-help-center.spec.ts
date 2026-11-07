import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { signUp } from "./helpers";

test("in the first run the team brings its help center across by its address: its articles as drafts in collections, its old paths redirecting to them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);

  // A key typed for Featurebase never shows, in plain text, as the address; nor does its refusal stay under it.
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  await owner.getByRole("textbox", { name: "API key" }).fill("sk_typed_for_featurebase");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const refused = owner.getByText("Featurebase didn't accept this API key. Check you copied all of it, or make a new one.");
  await expect(refused).toBeVisible();
  await owner.getByRole("textbox", { name: "API key" }).fill("sk_typed_for_featurebase");

  // No key: its address, and the help center is what comes.
  await owner.getByRole("radio", { name: /^Your help center/ }).check();
  await expect(owner.getByText("GitBook, Docusaurus, Intercom, Zendesk or your own: its articles come across from its address, no key needed.")).toBeVisible();
  await expect(owner.getByRole("link", { name: /^Get your API key/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Help center/ })).toBeChecked();
  await expect(owner.getByText(/articles arrive as drafts for you to review and publish, and up to 200 of their old addresses redirect to them/)).toBeVisible();
  const address = owner.getByRole("textbox", { name: "Address" });
  await expect(address).toHaveAttribute("type", "url");
  await expect(address).toHaveValue("");
  await expect(refused).toHaveCount(0);
  await address.fill(process.env.E2E_HELP_CENTER_URL!);
  await checkpoint(owner, "setup-help-center");

  // While the check runs (the site holding its answer), the source can't change under it.
  const fake = new URL(process.env.E2E_HELP_CENTER_URL!).origin;
  expect((await fetch(`${fake}/_fake/hold`, { method: "POST" })).ok).toBe(true);
  try {
    await owner.getByRole("button", { name: "Check the address and start" }).click();
    await expect(owner.getByRole("button", { name: "Checking the address…" })).toBeVisible();
    // Said to screen readers, and switching does nothing; the radios keep keyboard focus.
    const featurebase = owner.getByRole("radio", { name: /^Featurebase/ });
    await expect(featurebase).toHaveAttribute("aria-disabled", "true");
    await featurebase.focus();
    await expect(featurebase).toBeFocused();
    await owner.keyboard.press("Space");
    await expect(featurebase).not.toBeChecked();
    await expect(owner.getByRole("radio", { name: /^Your help center/ })).toBeChecked();
  } finally {
    // Always let it go, so nothing after waits on it.
    await fetch(`${fake}/_fake/release`, { method: "POST" });
  }
  const status = owner.getByRole("status").filter({ hasText: "your help center" });
  await expect(status).toContainText("Imported from your help center. 2 collections, 5 articles, 4 old addresses redirected brought across.", { timeout: 30_000 });
  await checkpoint(owner, "setup-help-center-imported");

  // The articles wait as drafts, in collections named as the site's links name them.
  await owner.getByRole("link", { name: "See docs" }).click();
  await owner.waitForURL(`**/app/${slug}/docs`);
  await expect(owner.getByText("Billing & plans").first()).toBeVisible();
  await expect(owner.getByRole("listitem").filter({ hasText: "Install Acme" })).toContainText("Draft");
  await checkpoint(owner, "help-center-drafts");

  // An old path goes to its new page.
  await owner.goto(`${portalUrl(slug)}/docs/getting-started/install`);
  await expect(owner).toHaveURL(`${portalUrl(slug)}/docs/install`);
});
