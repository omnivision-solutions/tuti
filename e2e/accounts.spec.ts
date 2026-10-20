import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

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

test("a visitor signs in to a portal with an emailed link and comes back to the post they started", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Signed out, with a post started (as "Post this as feedback" from the help center does).
  const title = "Can I pay with crypto?";
  const vera = await newPerson(browser, portalUrl(slug));
  await vera.goto(`/b/feature-requests?${new URLSearchParams({ title })}`);
  await vera.getByRole("main").getByRole("link", { name: "Sign in" }).click();
  await vera.waitForURL(/\/sign-in\?next=/);
  const email = `e2e-${randomUUID()}@example.com`;
  await vera.getByLabel("Email").fill(email);
  await checkpoint(vera, "portal-sign-in-link-form");
  await vera.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(vera.getByText("Check your email")).toBeVisible();
  await expect(vera.getByText(`We sent a sign-in link to ${email}.`)).toBeVisible();
  await checkpoint(vera, "portal-sign-in-link-sent");

  const message = await latestEmailTo(email);
  expect(message.subject).toBe("Sign in to Acme");
  const link = linkIn(message, `${portalUrl(slug)}/sign-in/link?`);
  await vera.goto(link);
  await vera.waitForURL(/\/b\/feature-requests\?title=/);
  await expect(vera.getByLabel("Title")).toHaveValue(title);
  await expect(vera.getByRole("button", { name: "Account" })).toBeVisible();
  await checkpoint(vera, "portal-signed-in-with-link");

  // A new account is named after the address; they can change it.
  await vera.getByRole("button", { name: "Account" }).click();
  await expect(vera.getByRole("menu").getByText(email.split("@")[0]!)).toBeVisible();
  await vera.getByRole("menuitem", { name: "Account settings" }).click();
  await vera.waitForURL("**/account");
  await vera.getByLabel("Name").fill("Vera Visitor");
  await vera.getByRole("button", { name: "Save" }).click();
  await expect(vera.getByText("Profile updated")).toBeVisible();
  await vera.getByRole("button", { name: "Account" }).click();
  await expect(vera.getByRole("menu").getByText("Vera Visitor")).toBeVisible();

  // The link worked once.
  const someoneElse = await newPerson(browser, portalUrl(slug));
  await someoneElse.goto(link);
  await expect(someoneElse.getByText("That sign-in link has expired or was already used. Ask for a new one.")).toBeVisible();
  await expect(someoneElse.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
});
