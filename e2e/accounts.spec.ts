import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { backToPortal, createProject, newPerson, signInWithPassword, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

const PASSWORD = "correct horse battery staple";

test("a team member switches projects, edits their account, signs out and back in", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const [acme, globex] = [`e2e-${randomUUID().slice(0, 8)}`, `e2e-${randomUUID().slice(0, 8)}`];
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", acme);
  await createProject(olive, "Globex", globex);

  // Signed in, the sign-in and sign-up pages go straight to the app.
  for (const page of ["/app/auth/sign-in", "/app/auth/sign-up"]) {
    await olive.goto(`${APP_URL}${page}`);
    await olive.waitForURL(/\/app\/e2e-/);
  }
  // The server's own home is the app (Tuti's cloud sends `/` to its marketing site instead).
  await olive.goto(APP_URL);
  await olive.waitForURL(/\/app\/e2e-/);
  // Except after a password reset, which may be someone else's on this browser: its message and the form stay.
  await olive.goto(`${APP_URL}/app/auth/sign-in?reset=done`);
  await expect(olive.getByText("Your password was changed. Sign in with the new one.")).toBeVisible();
  await expect(olive.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await olive.goto(`${APP_URL}/app/${globex}`);

  // The sidebar's project switcher lists both projects.
  await olive.getByRole("button", { name: /Globex/ }).click();
  await expect(olive.getByRole("menuitem", { name: /Acme/ })).toBeVisible();
  // It has the portal too, with its address.
  await expect(olive.getByRole("menuitem", { name: /^View portal/ })).toHaveAttribute("href", portalUrl(globex));
  await checkpoint(olive, "project-switcher", { fullPage: false });
  await olive.getByRole("menuitem", { name: /Acme/ }).click();
  await olive.waitForURL(`**/app/${acme}`);

  // On a phone the sidebar is a menu over the page: picking a page closes it.
  await olive.setViewportSize({ width: 390, height: 844 });
  await olive.locator("header").getByRole("button", { name: "Toggle Sidebar" }).click();
  await olive.getByRole("dialog").getByRole("link", { name: "Feedback", exact: true }).click();
  await olive.waitForURL(`**/app/${acme}/feedback`);
  await expect(olive.getByRole("dialog")).toBeHidden();
  await olive.setViewportSize({ width: 1280, height: 720 });

  // Account settings: a new name and a new password.
  await olive.getByRole("button", { name: /Olive Owner/ }).click();
  await olive.getByRole("menuitem", { name: "Account settings" }).click();
  await olive.waitForURL("**/app/account");
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await olive.getByRole("button", { name: "Save" }).click();
  await expect(olive.getByText("Profile updated")).toBeVisible();
  // Initials, coloured, until there's a photo; then the photo, uploaded and saved with the name.
  const me = olive.getByRole("button", { name: /Olive Q\. Owner/ });
  await expect(me.locator('[data-slot="avatar-fallback"]')).toHaveClass(/bg-avatar-/);
  const scratch = await olive.context().newPage();
  await scratch.setContent('<div id="face" style="width:96px;height:96px;background:#e07a5f"></div>');
  const face = await scratch.locator("#face").screenshot();
  await scratch.close();
  await olive.getByLabel("Photo", { exact: true }).setInputFiles({ name: "me.png", mimeType: "image/png", buffer: face });
  await expect(olive.getByRole("img", { name: "Photo preview" })).toBeVisible();
  await olive.getByRole("button", { name: "Save", exact: true }).click();
  await expect(me.locator('[data-slot="avatar-image"]')).toHaveAttribute("src", /\/media\//);
  // Saving only a new name keeps it; Remove and Save puts the initials back.
  const saved = await me.locator('[data-slot="avatar-image"]').getAttribute("src");
  await olive.getByLabel("Name").fill("Olive Owner");
  // Saved from the keyboard: focus stays on Save while it's off for the save.
  const save = olive.getByRole("button", { name: "Save", exact: true });
  await save.press("Enter");
  await expect(olive.getByRole("button", { name: /Olive Owner/ })).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).toBeFocused();
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-image"]')).toHaveAttribute("src", saved!);
  await checkpoint(olive, "account-photo", { fullPage: false });
  await olive.getByRole("button", { name: "Remove", exact: true }).click();
  await olive.getByRole("button", { name: "Save", exact: true }).click();
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-image"]')).toHaveCount(0);
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-fallback"]')).toHaveText("OO");
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await olive.getByRole("button", { name: "Save", exact: true }).click();
  await expect(me).toBeVisible();
  await olive.getByLabel("Current password").fill(PASSWORD);
  await olive.getByLabel("New password").fill("a brand new passphrase");
  await olive.getByRole("button", { name: "Change password" }).click();
  await expect(olive.getByText("Password changed")).toBeVisible();
  await checkpoint(olive, "account-settings");

  // Signing out, then in: the old password no longer works.
  await olive.getByRole("button", { name: /Olive Q\. Owner/ }).click();
  // From the keyboard: a click aimed while the menu is still opening can land on Theme, whose submenu then covers Sign out.
  await olive.getByRole("menuitem", { name: "Sign out" }).press("Enter");
  await olive.waitForURL(`${APP_URL}/app/auth/sign-in`);
  // The form is the way in here: the header is Tuti's logo, back to the site, with no Sign in or Start free of its own.
  await expect(olive.getByRole("banner").getByRole("link", { name: "Tuti home" })).toHaveAttribute("href", "/");
  await expect(olive.getByRole("banner").getByRole("link", { name: "Start free" })).toHaveCount(0);
  await expect(olive.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await olive.getByLabel("Email").fill(olive.email);
  await olive.getByLabel("Password").fill(PASSWORD);
  await olive.getByRole("button", { name: "Sign in" }).click();
  await expect(olive.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await checkpoint(olive, "app-sign-in-error");
  await olive.getByLabel("Password").fill("a brand new passphrase");
  await olive.getByRole("button", { name: "Sign in" }).click();
  await olive.waitForURL(/\/app\//);
});

test("the app's sign-in and sign-up pages link to each other under /app/auth, keeping where to go next", async ({ page }) => {
  const next = "/app/new";
  await page.goto(`${APP_URL}/app/auth/sign-up?${new URLSearchParams({ next })}`);
  const signIn = new URL(`${APP_URL}${await page.getByRole("link", { name: "Sign in", exact: true }).getAttribute("href")}`);
  expect([signIn.pathname, signIn.searchParams.get("next")]).toEqual(["/app/auth/sign-in", next]);
  await page.goto(`${APP_URL}/app/auth/sign-in`);
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", /^\/app\/auth\/sign-up\?/);
});

test("the strip asking to verify an email stays on every page until the email is verified", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);
  const strip = olive.getByRole("status").filter({ hasText: "Verify your email" });
  await expect(strip).toContainText(`We sent a link to ${olive.email}.`);
  await checkpoint(olive, "verify-email-strip", { fullPage: false });
  // It can't be dismissed, and it's on the next page and after reloading.
  await expect(strip.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await olive.goto(`/app/${slug}/feedback`);
  await expect(olive.getByRole("heading", { name: "Feedback" })).toBeVisible();
  await expect(strip).toBeVisible();
  // Home's Get set up doesn't ask for it too.
  await olive.goto(`/app/${slug}`);
  await expect(olive.getByRole("list", { name: "Get set up" })).toBeVisible();
  await expect(olive.getByRole("list", { name: "Get set up" })).not.toContainText("Verify your email");
  // Account settings offers to send the email again too, beside the address.
  await olive.goto("/app/account");
  await expect(olive.getByText("Not verified")).toBeVisible();
  // On phones, Account settings' path names Tuti rather than the last project.
  await olive.setViewportSize({ width: 390, height: 844 });
  await expect(olive.locator("header").first()).toContainText("Tuti");
  await expect(olive.locator("header").first()).not.toContainText("Acme");
  await olive.setViewportSize({ width: 1280, height: 720 });
  await expect(olive.locator("main > header")).toBeHidden();
  await expect(olive.getByRole("paragraph").filter({ hasText: "Not verified" }).getByRole("button", { name: "Resend email" })).toBeVisible();
  // Verified in another tab, the strip and Account settings stop asking once this tab is back in focus.
  const otherTab = await olive.context().newPage();
  await otherTab.goto(linkIn(await latestEmailTo(olive.email), `${APP_URL}/api/auth/verify-email`));
  await otherTab.close();
  await olive.bringToFront();
  // Better Auth refetches the session when the tab becomes visible, at most every 5 seconds.
  await expect(async () => {
    await olive.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(olive.getByText("Not verified")).toHaveCount(0, { timeout: 500 });
    await expect(strip).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  // And it's gone on the next page.
  await olive.goto(`/app/${slug}/feedback`);
  await expect(olive.getByRole("heading", { name: "Feedback" })).toBeVisible();
  await expect(strip).toHaveCount(0);
});

test("an owner renames the project in Settings → General, and the app and its portal show the new name", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);
  await olive.goto(`/app/${slug}/settings/general`);
  await expect(olive.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  await olive.getByLabel("Project name").fill("A");
  await olive.getByRole("button", { name: "Save" }).click();
  await expect(olive.getByText("Give the project a name of 2 characters or more")).toBeVisible();
  await olive.getByLabel("Project name").fill("  Acme Help  ");
  await olive.getByRole("button", { name: "Save" }).click();
  await expect(olive.getByText("Project renamed")).toBeVisible();
  // The field shows the name as saved.
  await expect(olive.getByLabel("Project name")).toHaveValue("Acme Help");
  await expect(olive.getByRole("button", { name: /Acme Help/ }).first()).toBeVisible(); // the sidebar's project switcher
  await checkpoint(olive, "settings-general");
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/");
  await expect(visitor.getByRole("banner")).toContainText("Acme Help");
});

test("someone signs up from a portal, signs out and signs back in there; their password is typed on the app", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ada = await newPerson(browser, portalUrl(slug));
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  // A team may run its portal's host (its own domain, or its site's path): the account, and its password, are made on the app.
  await ada.getByRole("link", { name: "Create an account" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-up");
  // For Acme, not the pitch to teams.
  await expect(ada.getByText("Create your Tuti account to continue to Acme.")).toBeVisible();
  await expect(ada.getByText("Feedback, roadmap, changelog and docs, kept up to date as you ship.")).toHaveCount(0);
  await expect(ada.getByText("Start collecting feedback in minutes.")).toHaveCount(0);
  await checkpoint(ada, "portal-sign-up-on-app");
  const email = `e2e-${randomUUID()}@example.com`;
  await ada.getByLabel("Name").fill("Ada");
  await ada.getByLabel("Email").fill(email);
  await ada.getByLabel("Password").fill(PASSWORD);
  await ada.getByRole("button", { name: "Sign up" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue");
  await expect(ada.getByText("Continue to Acme")).toBeVisible();
  await backToPortal(ada);
  await expect(ada).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  // Later, "Verify your email" from the inbox: that handoff is used up, so it comes back through a new one.
  // It doesn't go on by itself: the page says where (the portal's address), and Ada clicks.
  await ada.goto(linkIn(await latestEmailTo(email, { subject: /verify/i }), `${APP_URL}/api/auth/verify-email`));
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue" && url.searchParams.has("mac"));
  await expect(ada.getByText(`Use your Tuti account on Acme's portal, at ${new URL(portalUrl(slug)).host}.`)).toBeVisible();
  await ada.getByRole("link", { name: "Continue as Ada" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue" && url.searchParams.has("state"));
  await backToPortal(ada);
  await expect(ada).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  await ada.getByRole("button", { name: "Account" }).click();
  await ada.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(ada.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();

  // The emailed link is the way in; no password here: it's a link to the app, as is a Tuti account below the form.
  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  const main = ada.getByRole("main");
  await expect(main.getByLabel("Password")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Email me a sign-in link" })).toHaveAttribute("type", "submit");
  const form = (await main.getByRole("link", { name: "Use a password instead" }).boundingBox())!;
  const tuti = (await main.getByRole("link", { name: "Sign in with Tuti" }).boundingBox())!;
  expect(tuti.y).toBeGreaterThan(form.y + form.height);
  for (const colorScheme of ["light", "dark"] as const) {
    await ada.emulateMedia({ colorScheme });
    await checkpoint(ada, `portal-sign-in-email-first-desktop-${colorScheme}`);
    await ada.setViewportSize({ width: 390, height: 844 });
    await checkpoint(ada, `portal-sign-in-email-first-phone-${colorScheme}`);
    await ada.setViewportSize({ width: 1280, height: 720 });
  }
  await ada.emulateMedia({ colorScheme: "light" });
  // Still signed in on the app (signing out of a portal is the portal's alone): one click back.
  await main.getByRole("link", { name: "Use a password instead" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue");
  await backToPortal(ada);
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  // On another device, the password typed on the app, and back.
  const laptop = await newPerson(browser, portalUrl(slug));
  await laptop.goto("/sign-in?next=%2Ffeedback%2Ffeature-requests");
  await signInWithPassword(laptop, email, PASSWORD);
  await expect(laptop).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(laptop.getByRole("button", { name: "New idea" })).toBeVisible();
  await expect(laptop.getByRole("button", { name: "Account" })).toBeVisible();
});

test("a visitor signs in to a portal with an emailed link and comes back to the post they started", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Signed out, they type their idea in New idea's box first, then sign in to post it.
  const title = "Can I pay with crypto?";
  const vera = await newPerson(browser, portalUrl(slug));
  await vera.goto("/feedback/feature-requests");
  await vera.getByRole("button", { name: "New idea" }).click();
  const box = vera.getByRole("dialog", { name: "Share an idea" }).locator("form");
  await box.getByLabel("Title").fill(title);
  await box.getByRole("button", { name: "Sign in to post" }).click();
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
  // Opening the link only asks to confirm (mail scanners open links too), naming the address.
  await vera.goto(link);
  await expect(vera.getByText("Sign in to Acme")).toBeVisible();
  await expect(vera.getByText(`as ${email}`)).toBeVisible();
  await checkpoint(vera, "portal-sign-in-link-confirm");
  await vera.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await vera.waitForURL(/\/feedback\/feature-requests/);
  // The idea they started is in the box, ready to send; the address has given it up (a reload doesn't bring it back).
  await expect(box.getByLabel("Title")).toHaveValue(title);
  await expect(vera).toHaveURL(/\/feedback\/feature-requests$/);
  await checkpoint(vera, "portal-signed-in-with-link");
  await box.getByRole("button", { name: "Submit post" }).click();
  await expect(vera.getByRole("main").getByRole("link", { name: title })).toBeVisible();
  await expect(vera.getByRole("button", { name: "Account" })).toBeVisible();

  // A new account is named after the address (changed on the app: the portal's Account only shows it).
  await vera.getByRole("button", { name: "Account" }).click();
  await expect(vera.getByRole("menu").getByText(email.split("@")[0]!)).toBeVisible();
  await vera.keyboard.press("Escape");

  // The link worked once.
  const someoneElse = await newPerson(browser, portalUrl(slug));
  await someoneElse.goto(link);
  await expect(someoneElse.getByText("That sign-in link has expired or was already used. Ask for a new one.")).toBeVisible();
  // On the sign-in page, its form is the way in (the header has no Sign in there): it sends a new link.
  await expect(someoneElse.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeHidden();
  const anotherEmail = `e2e-${randomUUID()}@example.com`;
  await someoneElse.getByLabel("Email").fill(anotherEmail);
  await someoneElse.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(someoneElse.getByText(`We sent a sign-in link to ${anotherEmail}.`)).toBeVisible();

  // From the portal's home page it comes back to the portal's home page (the app has a "/" too).
  const wes = await newPerson(browser, portalUrl(slug));
  await wes.goto("/sign-in?next=%2F");
  const wesEmail = `e2e-${randomUUID()}@example.com`;
  await wes.getByLabel("Email").fill(wesEmail);
  await wes.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(wes.getByText("Check your email")).toBeVisible();
  await wes.goto(linkIn(await latestEmailTo(wesEmail), `${portalUrl(slug)}/sign-in/link?`));
  await wes.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  // The portal's home page sends people on to its first board.
  await expect(wes).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(wes.getByRole("navigation", { name: "Portal" })).toBeVisible();
  await expect(wes.getByRole("button", { name: "Account" })).toBeVisible();
});

test("a team member who forgot their password resets it by email and signs in with the new one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  // Signed in on one device…
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await olive.waitForURL(/\/app/);

  // …and forgot the password on another.
  const laptop = await newPerson(browser, APP_URL);
  await laptop.goto("/app/auth/sign-in");
  await laptop.getByRole("link", { name: "Forgot your password?" }).click();
  await laptop.waitForURL("**/forgot-password");
  await laptop.getByLabel("Email").fill(olive.email);
  await checkpoint(laptop, "app-forgot-password");
  await laptop.getByRole("button", { name: "Email me a link" }).click();
  await expect(laptop.getByText(`If there's an account for ${olive.email}, we've sent it a link`)).toBeVisible();
  await checkpoint(laptop, "app-forgot-password-sent");

  const message = await latestEmailTo(olive.email);
  expect(message.subject).toBe("Reset your password");
  await laptop.goto(linkIn(message, `${APP_URL}/app/auth/reset-password?`));
  await expect(laptop.getByText("Set a new password")).toBeVisible();
  await expect(laptop.getByText(`for ${olive.email}`)).toBeVisible();
  await laptop.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await laptop.getByLabel("Confirm new password").fill("a different passphrase");
  await laptop.getByRole("button", { name: "Set new password" }).click();
  await expect(laptop.getByText("The passwords don't match.")).toBeVisible();
  await laptop.getByLabel("Confirm new password").fill("a brand new passphrase");
  await checkpoint(laptop, "app-set-new-password");
  await laptop.getByRole("button", { name: "Set new password" }).click();

  await laptop.waitForURL("**/sign-in?reset=done");
  await expect(laptop.getByText("Your password was changed. Sign in with the new one.")).toBeVisible();
  await laptop.getByLabel("Email").fill(olive.email);
  await laptop.getByLabel("Password").fill("a brand new passphrase");
  await checkpoint(laptop, "app-sign-in-after-reset");
  await laptop.getByRole("button", { name: "Sign in" }).click();
  await laptop.waitForURL(/\/app/);
  expect((await latestEmailTo(olive.email)).subject).toBe("Your password was changed");

  // The other device was signed out.
  await olive.reload();
  await olive.waitForURL(/\/sign-in/);
});

test("a portal user who forgot their password asks on the portal, sets it on the app and is back on the portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const signedUp = await signUp(browser, portalUrl(slug), "Ada");
  await signedUp.context().close();

  // On another device: "Use a password instead" goes to the app's sign-in, whose "Forgot your password?" stays on the app
  // and asks for Acme (its email comes from Acme), and comes back to Acme's card.
  const ada = Object.assign(await newPerson(browser, portalUrl(slug)), { email: signedUp.email });
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await ada.getByRole("link", { name: "Use a password instead" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-in");
  await expect(ada.getByText("Sign in to continue to Acme.")).toBeVisible();
  await ada.getByRole("link", { name: "Forgot your password?" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/forgot-password" && url.searchParams.get("portal") === slug);
  // "Back to sign in" keeps the way back to Acme.
  await ada.getByRole("link", { name: "Back to sign in" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-in");
  await expect(ada.getByText("Sign in to continue to Acme.")).toBeVisible();
  await ada.getByRole("link", { name: "Forgot your password?" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/forgot-password" && url.searchParams.get("portal") === slug);
  await ada.getByLabel("Email").fill(ada.email);
  await checkpoint(ada, "portal-forgot-password");
  await ada.getByRole("button", { name: "Email me a link" }).click();
  await expect(ada.getByText(`If there's an account for ${ada.email}, we've sent it a link`)).toBeVisible();

  // From the portal, but the link is the app's: the password is set where it's typed.
  const message = await latestEmailTo(ada.email);
  expect(message.subject).toBe("Reset your password");
  expect(message.text).toContain("your account on Acme");
  const link = linkIn(message, `${APP_URL}/app/auth/reset-password?`);
  await ada.goto(link);
  await ada.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await ada.getByLabel("Confirm new password").fill("a brand new passphrase");
  await checkpoint(ada, "portal-set-new-password-on-app");
  await ada.getByRole("button", { name: "Set new password" }).click();
  // Back through the portal: signing in on the app with the new one, told it's changed, and on to the portal.
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-in" && url.searchParams.get("reset") === "done");
  await expect(ada.getByText("Your password was changed. Sign in with the new one.")).toBeVisible();
  await ada.getByLabel("Email").fill(ada.email);
  await ada.getByLabel("Password").fill("a brand new passphrase");
  await checkpoint(ada, "portal-sign-in-after-reset");
  await ada.getByRole("button", { name: "Sign in", exact: true }).click();
  // The app never goes on to the portal by itself: its card shows the portal's address, and Ada clicks.
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue" && url.searchParams.has("mac"));
  await expect(ada.getByText(`Use your Tuti account on Acme's portal, at ${new URL(portalUrl(slug)).host}.`)).toBeVisible();
  await ada.getByRole("link", { name: "Continue as Ada" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/continue" && url.searchParams.has("state"));
  await backToPortal(ada);
  await expect(ada).toHaveURL(new RegExp(`^${portalUrl(slug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  // The link worked once: asking again is on the app.
  await ada.goto(link);
  await ada.waitForURL(`${APP_URL}/app/auth/forgot-password?link=failed`);
  await expect(ada.getByText("That link has expired or was already used. Ask for a new one.")).toBeVisible();
});
