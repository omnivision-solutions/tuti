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
  // Each a chip, once a space, comma or Enter ends it; one typed without is saved too.
  const domains = owner.getByLabel("Other domains");
  await domains.fill("acme.auth0.com,");
  await expect(owner.getByRole("button", { name: "Remove acme.auth0.com" })).toBeVisible();
  await domains.fill("cdn.example.net");
  await save.click();
  await expect(owner.getByText("Screenshot settings saved")).toBeVisible();

  // Saved, the field is emptied at once: moving the app to another site and saving doesn't send it again for there.
  await expect(passwordField).toHaveValue("");
  await expect(save).toBeDisabled();
  await owner.getByLabel("App address").fill("https://other.example.net");
  await save.click();
  await expect(owner.getByText("Enter the password again: the app's address changed")).toBeVisible();
  await owner.getByLabel("App address").fill("https://app.example.com");
  // Saved, the password is never shown again, nor in the page.
  await owner.reload();
  await expect(passwordField).toHaveValue("");
  await expect(owner.getByText("Saved. Enter a new one to replace it.")).toBeVisible();
  expect(await owner.content()).not.toContain(password);
  await expect(owner.getByLabel("Username")).toHaveValue("e2e-demo@example.com");
  await expect(owner.getByRole("button", { name: "Remove acme.auth0.com" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Remove cdn.example.net" })).toBeVisible();

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

test("an app that signs in through Firebase: its hosts are found and allowed by themselves, removed without the password, and a domain typed asks for it", async ({ browser }, testInfo) => {
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

    await owner.getByLabel("App address").fill(`http://localhost:${(app.address() as AddressInfo).port}`);
    await owner.getByRole("radiogroup", { name: "Sign in" }).getByText("Password", { exact: true }).click();
    await owner.getByLabel("Username").fill("e2e-demo@example.com");
    const passwordField = owner.getByLabel("Password", { exact: true }).and(owner.locator('input[type="password"]'));
    await passwordField.fill(password);
    // The page's next ask, held while the checking chip is looked at (inline jobs have the answer by then).
    const isPoll = (url: URL) => url.pathname.endsWith("/api/trpc/screenshotSettings.signInDomains");
    let poll: Route | undefined;
    await owner.route(isPoll, (route) => {
      poll = route;
    });
    await save.click();
    await expect(owner.getByText("Screenshot settings saved")).toBeVisible();

    // The app's sign-in service, found in its script: read in the background while the field says so, then its hosts
    // in the field, marked Auto, with nothing to add or save.
    const checking = owner.getByText("Checking sign-in", { exact: true });
    await expect(checking).toBeVisible();
    await expect(owner.locator('[data-domains][aria-busy="true"]')).toBeAttached();
    await checking.scrollIntoViewIfNeeded();
    await checkpoint(owner, "team-settings-screenshots-checking");
    await expect.poll(() => poll).toBeDefined();
    await poll!.continue();
    await owner.unroute(isPoll);
    const identity = owner.getByRole("button", { name: "Remove identitytoolkit.googleapis.com" });
    const token = owner.getByRole("button", { name: "Remove securetoken.googleapis.com" });
    await expect(identity).toBeVisible();
    await expect(token).toBeVisible();
    await expect(checking).toBeHidden();
    await expect(save).toBeDisabled();
    // Why, on the label.
    await owner.getByRole("button", { name: "Auto: why identitytoolkit.googleapis.com was added" }).hover();
    await expect(owner.getByText("Added for Firebase sign-in", { exact: true })).toBeVisible();
    await checkpoint(owner, "team-settings-screenshots-found");
    await owner.mouse.move(0, 0);

    // Another address on the same site, where nothing is found: the last one's are gone. (Any change of address asks
    // for the password again.)
    const appAddress = owner.getByLabel("App address");
    const base = await appAddress.inputValue();
    await appAddress.fill(new URL("plain", base).href);
    await passwordField.fill(password);
    await save.click();
    await expect(owner.locator('[data-domains][aria-busy="false"]')).toBeAttached();
    await expect(identity).toBeHidden();
    // Back: found again.
    await expect(async () => {
      await appAddress.fill(base);
      await passwordField.fill(password);
      await expect(save).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await save.click();
    await expect(identity).toBeVisible();

    // One removed, saved without the password; focus stays in the field, and screen readers are told.
    const said = owner.locator("[data-domains-said]");
    await expect(said).toHaveText("Added for Firebase sign-in: identitytoolkit.googleapis.com, securetoken.googleapis.com.");
    await token.click();
    await expect(token).toBeHidden();
    await expect(owner.getByLabel("Other domains")).toBeFocused();
    await expect(said).toHaveText("Removed securetoken.googleapis.com.");
    await save.click();
    await expect(owner.getByText("Screenshot settings saved").last()).toBeVisible();
    await expect(save).toBeDisabled();

    // A domain typed while a password is saved asks for it, in a box under the field.
    await owner.getByLabel("Other domains").fill("cdn.example.net,");
    const again = owner.getByLabel("Enter the password again to add a domain.");
    await expect(again).toBeVisible();
    await again.fill(password);
    await save.click();
    await expect(again).toBeHidden();
    await expect(save).toBeDisabled();

    await owner.reload();
    await expect(owner.getByRole("button", { name: "Remove cdn.example.net" })).toBeVisible();
    await expect(identity).toBeVisible();
    await expect(owner.locator('[data-domains][aria-busy="false"]')).toBeAttached();
    await expect(token).toBeHidden();
    // Typed again, it's found again (no password asked).
    await owner.getByLabel("Other domains").fill("securetoken.googleapis.com ");
    await expect(token).toBeVisible();
    await expect(owner.getByLabel("Enter the password again to add a domain.")).toBeHidden();
    await save.click();
    await expect(save).toBeDisabled();
    // A domain typed but not ended is a change by itself: Save takes it (and asks for the password).
    await owner.getByLabel("Other domains").fill("api.example.net");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(owner.getByText("Enter the password again to add another domain: it can be typed there")).toBeVisible();
    await again.fill(password);
    await save.click();
    await expect(again).toBeHidden();
    await owner.reload();
    await expect(owner.getByRole("button", { name: "Remove api.example.net" })).toBeVisible();

    // A found host also listed by hand (before it was found): removing it removes it, not back as Auto.
    await expect(owner.locator('[data-domains][aria-busy="false"]')).toBeAttached();
    await owner.getByLabel("Other domains").fill("identitytoolkit.googleapis.com ");
    await expect(owner.getByRole("button", { name: "Auto: why identitytoolkit.googleapis.com was added" })).toBeHidden();
    await identity.click();
    await expect(identity).toBeHidden();
    await save.click();
    await expect(save).toBeDisabled();

    // What's removed is per address: away and back, both are found again.
    // Typed and saved again if the last save's settings, arriving late, put the old address back under it.
    for (const address of [new URL("plain", base).href, base]) {
      await expect(async () => {
        await appAddress.fill(address);
        await passwordField.fill(password);
        await save.click({ timeout: 1_000 });
        await expect(passwordField).toHaveValue("", { timeout: 3_000 });
        await expect(save).toBeDisabled({ timeout: 3_000 });
        await expect(appAddress).toHaveValue(address, { timeout: 1_000 });
      }).toPass();
    }
    await expect(identity).toBeVisible();
    await expect(token).toBeVisible();
    // Nothing left to save, and an edit undone is none.
    await expect(save).toBeDisabled();
    await owner.getByLabel("About your app").fill("x");
    await owner.getByLabel("About your app").fill("");
    await expect(save).toBeDisabled();
    // Another save keeps them: the removals before the address changed aren't sent back.
    await owner.getByLabel("About your app").fill("Close the welcome tour.");
    await save.click();
    await expect(save).toBeDisabled();
    await owner.reload();
    await expect(identity).toBeVisible();
    await expect(token).toBeVisible();

    // A save with another address that's refused (no password) leaves what's removed alone for the next one.
    await token.click();
    await appAddress.fill(new URL("plain", base).href);
    await save.click();
    await expect(owner.getByText("Enter the password again: the app's address changed")).toBeVisible();
    await appAddress.fill(base);
    await save.click();
    await expect(save).toBeDisabled();
    await owner.reload();
    await expect(identity).toBeVisible();
    await expect(owner.locator('[data-domains][aria-busy="false"]')).toBeAttached();
    await expect(token).toBeHidden();
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("while the app is read again, the page keeps asking for as long as a read can take", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Rhea Recheck");
  await createProject(owner, "Acme", slug);
  // An answer read again (over a week old, say), on a busy worker: the server's answers, faked, so nothing is read.
  const firebase = { host: "identitytoolkit.googleapis.com", provider: "Firebase" };
  const auth0 = { host: "acme.auth0.com", provider: "Auth0" };
  let done = false;
  let fail = false;
  // The page's looks again (the query; its first look is the scan), counted.
  let asks = 0;
  await owner.route(/\/api\/trpc\/screenshotSettings\.(scan|signInDomains)\b/, (route) => {
    asks += new URL(route.request().url()).pathname.endsWith(".signInDomains") ? 1 : 0;
    // tRPC's batch answer (superjson): one result.
    const answer = (json: unknown) => route.fulfill({ json: [{ result: { data: { json } } }] });
    return fail ? route.fulfill({ status: 502 }) : answer(done ? { domains: [firebase, auth0], checking: false } : { domains: [firebase], checking: true });
  });
  // The clock moved a little at a time until the page asks again (it sets its next ask only once an answer is in).
  const nextAsk = async () => {
    const after = asks;
    await expect(async () => {
      await owner.clock.runFor(500);
      expect(asks).toBeGreaterThan(after);
    }).toPass();
  };
  await owner.goto(`/app/${slug}/settings/screenshots`);
  await owner.getByLabel("App address").fill("https://app.example.com");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Screenshot settings saved")).toBeVisible();
  await owner.clock.install();
  await owner.reload();
  const checking = owner.getByText("Checking sign-in", { exact: true });
  await expect(checking).toBeVisible();
  // What's kept shows while it's read again.
  await expect(owner.getByRole("button", { name: "Remove identitytoolkit.googleapis.com" })).toBeVisible();

  // Each next ask, 2 seconds after the last answer: still checking, well past half a minute (a read may wait its turn
  // on a busy worker).
  while (asks < 20) {
    await nextAsk();
    await expect(checking).toBeVisible();
  }
  // A look again that fails (the server restarting for a deploy, say) changes nothing, and the page asks again.
  fail = true;
  const failed = owner.waitForResponse((response) => response.status() === 502);
  await nextAsk();
  await failed;
  await expect(checking).toBeVisible();
  fail = false;
  // Its answer then shows.
  done = true;
  await nextAsk();
  await expect(owner.getByRole("button", { name: "Remove acme.auth0.com" })).toBeVisible();
  await expect(checking).toBeHidden();
});
