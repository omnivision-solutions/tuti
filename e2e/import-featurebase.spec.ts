import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_FEATUREBASE_KEY } from "@tuti/testkit";

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
  await expect(owner.getByText("Featurebase's changelog isn't brought across yet.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase");

  // A key Featurebase refuses: said under the field, nothing started.
  const key = owner.getByLabel("API key");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("sk_not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Featurebase didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase-bad-key");

  // A good one: the import starts, and its progress shows here until it's done.
  await key.fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase");
  await expect(status).toContainText("3 contacts brought across.");
  await checkpoint(owner, "setup-featurebase-imported");

  // Setup goes on.
  await owner.getByRole("link", { name: "Continue" }).first().click();
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByText("Step 2 of 4")).toBeVisible();
  await owner.getByRole("link", { name: "Skip setup" }).click();

  // Home says what came across, and the contacts are the project's users, with their company.
  await owner.waitForURL(`**/app/${slug}`);
  await expect(owner.getByText("Imported from Featurebase")).toBeVisible();
  await expect(owner.getByText("3 contacts brought across.")).toBeVisible();
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
