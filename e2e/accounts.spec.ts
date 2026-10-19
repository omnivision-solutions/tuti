import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

const PASSWORD = "correct horse battery staple";

test("a team member switches projects, edits their account, signs out and back in", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const [acme, globex] = [`e2e-${randomUUID().slice(0, 8)}`, `e2e-${randomUUID().slice(0, 8)}`];
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", acme);
  await createProject(olive, "Globex", globex);

  // The sidebar's project switcher lists both projects.
  await olive.getByRole("button", { name: /Globex/ }).click();
  await expect(olive.getByRole("menuitem", { name: /Acme/ })).toBeVisible();
  await checkpoint(olive, "project-switcher", { fullPage: false });
  await olive.getByRole("menuitem", { name: /Acme/ }).click();
  await olive.waitForURL(`**/app/${acme}`);

  // Account settings: a new name and a new password.
  await olive.getByRole("button", { name: /Olive Owner/ }).click();
  await olive.getByRole("menuitem", { name: "Account settings" }).click();
  await olive.waitForURL("**/app/account");
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await olive.getByRole("button", { name: "Save" }).click();
  await expect(olive.getByText("Profile updated")).toBeVisible();
  await olive.getByLabel("Current password").fill(PASSWORD);
  await olive.getByLabel("New password").fill("a brand new passphrase");
  await olive.getByRole("button", { name: "Change password" }).click();
  await expect(olive.getByText("Password changed")).toBeVisible();
  await checkpoint(olive, "account-settings");

  // Signing out, then in: the old password no longer works.
  await olive.getByRole("button", { name: /Olive Q\. Owner/ }).click();
  await olive.getByRole("menuitem", { name: "Sign out" }).click();
  await olive.waitForURL(`${APP_URL}/`);
  await olive.goto("/sign-in");
  await olive.getByLabel("Email").fill(olive.email);
  await olive.getByLabel("Password").fill(PASSWORD);
  await olive.getByRole("button", { name: "Sign in" }).click();
  await expect(olive.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await checkpoint(olive, "app-sign-in-error");
  await olive.getByLabel("Password").fill("a brand new passphrase");
  await olive.getByRole("button", { name: "Sign in" }).click();
  await olive.waitForURL(/\/app\//);
});

test("someone signs up on a portal, signs out and signs back in there", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ada = await newPerson(browser, portalUrl(slug));
  await ada.goto("/b/feature-requests");
  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await ada.getByRole("link", { name: "Create an account" }).click();
  await checkpoint(ada, "portal-sign-up");
  const email = `e2e-${randomUUID()}@example.com`;
  await ada.getByLabel("Name").fill("Ada");
  await ada.getByLabel("Email").fill(email);
  await ada.getByLabel("Password").fill(PASSWORD);
  await ada.getByRole("button", { name: "Sign up" }).click();
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  await ada.getByRole("button", { name: "Account" }).click();
  await ada.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(ada.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();

  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await ada.getByLabel("Email").fill(email);
  await ada.getByLabel("Password").fill(PASSWORD);
  await checkpoint(ada, "portal-sign-in");
  await ada.getByRole("button", { name: "Sign in" }).click();
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();
  await ada.goto("/b/feature-requests");
  await expect(ada.getByRole("button", { name: "Submit feedback" })).toBeVisible();
});
