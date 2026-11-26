import { randomUUID } from "node:crypto";

import { FAKE_CANT_SIGN_IN, FAKE_SIGN_IN_REFUSED } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { createProject, signUp } from "./helpers";

test("an owner sets up screenshots of their app, signing in with a password kept secret, and tests it: the screen it lands on, or why it couldn't sign in", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const password = `pw-${randomUUID()}`;

  // In Settings, under AI. Nothing to test before the app's address is saved.
  await owner.goto(`/app/${slug}/settings/general`);
  await owner.getByRole("link", { name: "Screenshots" }).click();
  await expect(owner).toHaveURL(`/app/${slug}/settings/screenshots`);
  const testButton = owner.getByRole("button", { name: "Test", exact: true });
  await expect(testButton).toBeDisabled();
  const save = owner.getByRole("button", { name: "Save changes" });

  // The app, signing in with a demo account's password, and what the agent should know.
  await owner.getByLabel("App address").fill("https://app.example.com");
  const signIn = owner.getByRole("radiogroup", { name: "Sign in" });
  // The field, not the sign-in's radio of the same name.
  const passwordField = owner.getByLabel("Password", { exact: true }).and(owner.locator('input[type="password"]'));
  await expect(signIn.getByRole("radio", { name: "None" })).toBeChecked();
  await expect(passwordField).toBeHidden();
  // Something typed in a sign-in left behind (no https://) doesn't stop the save.
  await signIn.getByText("Sign-in link", { exact: true }).click();
  await owner.getByRole("textbox", { name: "Sign-in link" }).fill("app.example.com/magic");
  await signIn.getByText("Password", { exact: true }).click();
  await expect(owner.getByRole("textbox", { name: "Sign-in link" })).toBeHidden();
  await owner.getByLabel("Username").fill("e2e-demo@example.com");
  await passwordField.fill(password);
  // The residential proxy stays off unless the app blocks cloud servers.
  await expect(owner.getByRole("switch", { name: "Use a residential proxy" })).not.toBeChecked();
  await owner.getByLabel("About your app").fill("After signing in, pick the Acme workspace. Close the welcome tour.");
  await save.click();
  await expect(owner.getByText("Screenshot settings saved")).toBeVisible();

  // Saved, the field is emptied at once: moving the app to another site and saving doesn't send it again for there.
  await expect(passwordField).toHaveValue("");
  await expect(save).toBeDisabled();
  await owner.getByLabel("App address").fill("https://other.example.net");
  await save.click();
  await expect(owner.getByText("Enter the password again: the app's address moved to another site")).toBeVisible();
  await owner.getByLabel("App address").fill("https://app.example.com");
  // Saved, the password is never shown again, nor in the page.
  await owner.reload();
  await expect(passwordField).toHaveValue("");
  await expect(owner.getByText("Saved. Enter a new one to replace it.")).toBeVisible();
  expect(await owner.content()).not.toContain(password);
  await expect(owner.getByLabel("Username")).toHaveValue("e2e-demo@example.com");

  // The Test: the agent signs in and shows the screen it lands on.
  await testButton.click();
  const landed = owner.getByRole("img", { name: /^The screen: The screen you're on right after opening the app and signing in/ });
  await expect(landed).toBeVisible();
  await expect(owner.getByText("https://app.example.com/dashboard")).toBeVisible();
  // Said to screen readers too.
  const status = owner.locator('p[role="status"]');
  await expect(status).toHaveText(/^Test done: The screen: /);
  await expect(testButton).toBeEnabled();
  await owner.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(owner, "team-settings-screenshots-desktop");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-screenshots-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // A password the app refuses (Browser Use's fake can't sign in when the notes say so): the Test says why, instead of a screen.
  await owner.getByLabel("About your app").fill(FAKE_CANT_SIGN_IN);
  await save.click();
  await expect(owner.getByText("Screenshot settings saved")).toBeVisible();
  await testButton.click();
  const refused = owner.getByText(`The agent couldn't sign in: ${FAKE_SIGN_IN_REFUSED}`, { exact: true });
  await expect(refused).toBeVisible();
  await refused.scrollIntoViewIfNeeded();
  await expect(status).toHaveText(`Test failed: The agent couldn't sign in: ${FAKE_SIGN_IN_REFUSED}`);
  await expect(landed).toBeHidden();
  await checkpoint(owner, "team-settings-screenshots-sign-in-failed");
});
