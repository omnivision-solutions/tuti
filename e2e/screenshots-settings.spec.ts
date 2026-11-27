import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Route } from "@playwright/test";
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
  // The browser opens only the app's own domain unless told of others (a sign-in elsewhere, a CDN).
  await owner.getByLabel("Other domains").fill("acme.auth0.com\ncdn.example.net");
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
  await expect(owner.getByLabel("Other domains")).toHaveValue("acme.auth0.com\ncdn.example.net");

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

test("an app that signs in through Firebase: the settings suggest its hosts, and Add puts them in Other domains once the password is entered again", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  // The team's app, on this machine: its script calls Firebase Auth.
  const app = createServer((request, response) => {
    if (request.url === "/plain") {
      response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
    } else if (request.url === "/main.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end('const a="identitytoolkit.googleapis.com",b="securetoken.googleapis.com";');
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end('<html><script src="/main.js"></script></html>');
    }
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const owner = await signUp(browser, APP_URL, "Fran Firebase");
    await createProject(owner, "Acme", slug);
    const password = `pw-${randomUUID()}`;
    await owner.goto(`/app/${slug}/settings/screenshots`);
    const save = owner.getByRole("button", { name: "Save changes" });

    // Saved with a password, and notes the agent can't sign in with (Browser Use's fake).
    await owner.getByLabel("App address").fill(`http://localhost:${(app.address() as AddressInfo).port}`);
    await owner.getByRole("radiogroup", { name: "Sign in" }).getByText("Password", { exact: true }).click();
    await owner.getByLabel("Username").fill("e2e-demo@example.com");
    const passwordField = owner.getByLabel("Password", { exact: true }).and(owner.locator('input[type="password"]'));
    await passwordField.fill(password);
    await owner.getByLabel("About your app").fill(FAKE_CANT_SIGN_IN);
    await save.click();
    await expect(owner.getByText("Screenshot settings saved")).toBeVisible();

    // The app's sign-in service, found in its script: read in the background while the page says so, then suggested.
    const checking = owner.getByText("Checking how your app signs in…", { exact: true });
    await expect(checking).toBeVisible();
    await expect(owner.locator('[data-suggestions][aria-busy="true"]')).toBeAttached();
    await checking.scrollIntoViewIfNeeded();
    await checkpoint(owner, "team-settings-screenshots-checking");
    const suggestion = owner.getByText("Firebase sign-in needs identitytoolkit.googleapis.com and securetoken.googleapis.com", { exact: true });
    await expect(suggestion).toBeVisible();
    await expect(checking).toBeHidden();
    // A Test that can't sign in points to it.
    await owner.getByRole("button", { name: "Test", exact: true }).click();
    const failed = owner.getByRole("alert").filter({ hasText: `The agent couldn't sign in: ${FAKE_SIGN_IN_REFUSED}` });
    await expect(failed).toContainText("Try the suggested domains.");
    await suggestion.scrollIntoViewIfNeeded();
    await checkpoint(owner, "team-settings-screenshots-suggestion");

    // Another address on the same site: while it's read, the last one's suggestion (and the Test's pointer to it) is gone.
    const appAddress = owner.getByLabel("App address");
    const base = await appAddress.inputValue();
    let held: Route | undefined;
    await owner.route("**/settings/screenshots/suggestions*", (route) => {
      held = route;
    });
    await appAddress.fill(new URL("plain", base).href);
    await save.click();
    await expect(owner.getByText("Screenshot settings saved").last()).toBeVisible();
    await expect(owner.locator('[data-suggestions][aria-busy="true"]')).toBeAttached();
    await expect(suggestion).toBeHidden();
    await expect(failed).not.toContainText("Try the suggested domains.");
    // A read that fails shows none either.
    await expect.poll(() => held).toBeDefined();
    await held!.abort();
    await expect(owner.locator('[data-suggestions][aria-busy="false"]')).toBeAttached();
    await expect(suggestion).toBeHidden();
    // Back to the app's own address: suggested again.
    await owner.unroute("**/settings/screenshots/suggestions*");
    await appAddress.fill(base);
    await save.click();
    await expect(suggestion).toBeVisible();
    // A save that changes only a secret (a new sign-in link may open another host) reads them again too.
    const readAgain = owner.waitForRequest("**/settings/screenshots/suggestions");
    await passwordField.fill(`${password}-new`);
    await save.click();
    await readAgain;
    await expect(suggestion).toBeVisible();

    // Add lists its hosts; saving them asks for the password again.
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    await expect(suggestion).toBeHidden();
    const otherDomains = owner.getByLabel("Other domains");
    await expect(otherDomains).toHaveValue("identitytoolkit.googleapis.com\nsecuretoken.googleapis.com");
    await save.click();
    await expect(owner.getByText("Enter the password again to add another domain: it can be typed there")).toBeVisible();
    // Refused, so nothing to read again: what was just added isn't suggested back.
    await expect(owner.locator('[data-suggestions][aria-busy="false"]')).toBeAttached();
    await expect(suggestion).toBeHidden();
    await passwordField.fill(password);
    await save.click();
    // Saved: the password is cleared (several "saved" toasts may be up by now).
    await expect(passwordField).toHaveValue("");

    // Allowed now: not suggested again.
    await owner.reload();
    await expect(otherDomains).toHaveValue("identitytoolkit.googleapis.com\nsecuretoken.googleapis.com");
    // Once the suggestions have been read again.
    await expect(owner.locator('[data-suggestions][aria-busy="false"]')).toBeAttached();
    await expect(owner.getByText("Firebase sign-in needs", { exact: false })).toBeHidden();
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
