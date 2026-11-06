import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_FEATUREBASE_SLOW_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { signUp } from "./helpers";

test("in the first run the team comes from Featurebase: a bad key is refused, a good one brings its contacts across as Users while setup goes on", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: Featurebase, with a key and what to bring.
  await owner.waitForURL(`**/app/${slug}/setup`);
  await expect(owner.getByText("Step 1 of 4")).toBeVisible();
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  await expect(owner.getByRole("link", { name: "Settings → API" })).toHaveAttribute("href", "https://auth.featurebase.app/login?redirect=/settings/api");
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await expect(owner.getByText("Only contacts come across for now: feedback, the help center and the inbox follow in a later version, and the changelog after them.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase");

  // A key Featurebase refuses: said under the field, nothing started.
  const key = owner.getByRole("textbox", { name: "API key" });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("sk_not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Featurebase didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase-bad-key");

  // A good one (Featurebase holding its pages until the journey lets them go, so the import is running when the page looks): it starts,
  // and its progress shows here until it's done.
  await key.fill(FAKE_FEATUREBASE_SLOW_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  const continueLink = owner.getByRole("link", { name: "Continue" });
  // Started, focus is on Continue, the way on; screen readers hear only that it's importing, not each page's count.
  await expect(status).toHaveText("Importing from Featurebase");
  await expect(continueLink).toBeFocused();
  // The key isn't left in the page.
  await expect(key).toHaveCount(0);
  // Featurebase answers now; done, Continue still has focus (one Continue, kept as the import ends), and the summary is said.
  await fetch(`${process.env.E2E_FEATUREBASE_URL}/_fake/release`, { method: "POST" });
  await expect(status).toHaveText("Imported from Featurebase. 3 contacts brought across.", { timeout: 15_000 });
  await expect(continueLink).toBeFocused();
  await checkpoint(owner, "setup-featurebase-imported");

  // Setup goes on.
  await owner.getByRole("link", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByText("Step 2 of 4")).toBeVisible();
  await owner.getByRole("link", { name: "Skip setup" }).click();

  // Home says what came across, and the contacts are the project's users, with their company.
  await owner.waitForURL(`**/app/${slug}`);
  await expect(owner.getByText("Imported from Featurebase", { exact: true })).toBeVisible();
  await expect(owner.getByText("3 contacts brought across.", { exact: true })).toBeVisible();
  // Screen readers hear it in one status: the title and, once it's over, the summary.
  await expect(owner.getByRole("status").filter({ hasText: "Featurebase" })).toHaveText("Imported from Featurebase. 3 contacts brought across.");
  await checkpoint(owner, "home-imported");
  await owner.getByRole("link", { name: "See users" }).click();
  await owner.waitForURL(`**/app/${slug}/users`);
  const rows = owner.getByRole("main").getByRole("table").locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Mira Fenwick" })).toContainText("Fenwick Labs");
  await expect(rows.filter({ hasText: "Tobias Quill" })).toBeVisible();
  await expect(rows.filter({ hasText: "Juno Park" })).toBeVisible();
  await checkpoint(owner, "users-imported");
});
