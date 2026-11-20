import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { backToPortal, createProject, newPerson, signInWithPassword, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

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
  // One pane, its settings in cards of rows, and one Save in its header: off until something differs from what's saved.
  const account = olive.getByRole("region", { name: "Account settings" });
  await expect(account.getByRole("heading", { level: 1, name: "Account settings" })).toBeVisible();
  await expect(account.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(account.getByText(olive.email)).toBeVisible();
  const save = account.getByRole("button", { name: /^(Save changes|Saving…)$/ });
  await expect(save).toBeDisabled();
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await save.click();
  await expect(olive.getByText("Profile updated")).toBeVisible();
  await expect(save).toBeDisabled();
  // Initials, coloured, until there's a photo; then the photo, uploaded and saved with the name.
  const me = olive.getByRole("button", { name: /Olive Q\. Owner/ });
  await expect(me.locator('[data-slot="avatar-fallback"]')).toHaveClass(/bg-avatar-/);
  const scratch = await olive.context().newPage();
  await scratch.setContent('<div id="face" style="width:96px;height:96px;background:#e07a5f"></div>');
  const face = await scratch.locator("#face").screenshot();
  await scratch.close();
  // The photo's row shows them as they're shown everywhere: their initials, then the photo picked with Upload.
  const photo = account.locator('[data-slot="setting-row"]').filter({ hasText: "Photo" });
  await expect(photo.locator('[data-slot="avatar-fallback"]')).toHaveText("OQ");
  // While it uploads nothing is saved, by Save (off till then) or by Enter in Name: the photo goes with the save after.
  let uploadArrived!: () => void;
  let releaseUpload!: () => void;
  const uploadReached = new Promise<void>((resolve) => (uploadArrived = resolve));
  const uploadHeld = new Promise<void>((resolve) => (releaseUpload = resolve));
  let savedEarly = false;
  await olive.route("**/app/account", async (route) => {
    if (route.request().method() === "POST") {
      uploadArrived();
      await uploadHeld;
    }
    await route.continue();
  });
  await olive.route("**/api/auth/update-user", (route) => {
    savedEarly = true;
    return route.continue();
  });
  await olive.getByLabel("Photo", { exact: true }).setInputFiles({ name: "me.png", mimeType: "image/png", buffer: face });
  await uploadReached;
  await expect(save).toBeDisabled();
  await olive.getByLabel("Name").press("Enter");
  releaseUpload();
  await expect(olive.getByRole("img", { name: "Photo preview" })).toBeVisible();
  expect(savedEarly).toBe(false);
  await olive.unroute("**/app/account");
  await olive.unroute("**/api/auth/update-user");
  // Saved with Enter in Name: what's typed while it saves stays, with focus there, and is the next change to save.
  let saveArrived!: () => void;
  let releaseSave!: () => void;
  const saveReached = new Promise<void>((resolve) => (saveArrived = resolve));
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  await olive.route("**/api/auth/update-user", async (route) => {
    saveArrived();
    await saveHeld;
    await route.continue();
  });
  const nameField = olive.getByLabel("Name");
  await nameField.press("End");
  await nameField.press("Enter");
  await saveReached;
  await nameField.pressSequentially("!");
  releaseSave();
  await expect(me.locator('[data-slot="avatar-image"]')).toHaveAttribute("src", /\/media\//);
  await olive.unroute("**/api/auth/update-user");
  await expect(nameField).toHaveValue("Olive Q. Owner!");
  await expect(nameField).toBeFocused();
  await expect(save).toBeEnabled();
  // Put back, nothing is left to save: the photo is saved as the form holds it.
  await nameField.fill("Olive Q. Owner");
  await expect(save).toBeDisabled();
  await expect(me.locator('[data-slot="avatar-image"]')).toHaveAttribute("src", /\/media\//);
  // Saving only a new name keeps it; Remove and Save puts the initials back.
  const saved = await me.locator('[data-slot="avatar-image"]').getAttribute("src");
  await olive.getByLabel("Name").fill("Olive Owner");
  // Saved from the keyboard: focus stays on Save while it's off for the save, and after (nothing left to save).
  await save.press("Enter");
  await expect(olive.getByRole("button", { name: /Olive Owner/ })).toBeVisible();
  await expect(save).toBeFocused();
  await expect(save).toBeDisabled();
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-image"]')).toHaveAttribute("src", saved!);
  await checkpoint(olive, "account-photo", { fullPage: false });
  // A photo saved in another tab stays when this one, refreshed meanwhile, saves only a new name.
  const other = await olive.context().newPage();
  await other.goto("/app/account");
  await other.getByLabel("Photo", { exact: true }).setInputFiles({ name: "other.png", mimeType: "image/png", buffer: face });
  await expect(other.getByRole("img", { name: "Photo preview" })).toBeVisible();
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByText("Profile updated")).toBeVisible();
  // Its upload's id: the preview's address and the saved photo's differ, the id doesn't.
  const mediaId = (src: string | null) => src?.match(/\/(c[a-z0-9]{20,})\//)?.[1];
  const elsewhere = mediaId(await other.getByRole("img", { name: "Photo preview" }).getAttribute("src"));
  await other.close();
  expect(elsewhere).toBeTruthy();
  expect(elsewhere).not.toBe(mediaId(saved));
  await olive.getByText("Daily digest", { exact: true }).click();
  await expect(olive.getByText("Saved", { exact: true })).toBeVisible();
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await save.click();
  await expect(olive.getByRole("button", { name: /Olive Q\. Owner/ })).toBeVisible();
  await olive.reload();
  await expect(olive.getByRole("img", { name: "Photo preview" })).toHaveAttribute("src", new RegExp(`/${elsewhere}/`));
  await olive.getByLabel("Name").fill("Olive Owner");
  await save.click();
  await expect(olive.getByRole("button", { name: /Olive Owner/ })).toBeVisible();
  await olive.getByRole("button", { name: "Remove photo" }).click();
  await expect(photo.locator('[data-slot="avatar-fallback"]')).toHaveText("OO");
  await save.click();
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-image"]')).toHaveCount(0);
  await expect(olive.getByRole("button", { name: /Olive Owner/ }).locator('[data-slot="avatar-fallback"]')).toHaveText("OO");
  await olive.getByLabel("Name").fill("Olive Q. Owner");
  await save.click();
  await expect(me).toBeVisible();
  // The password is one row: its button opens a dialog, with focus in its first field.
  const change = account.getByRole("button", { name: "Change password" });
  await expect(olive.getByLabel("Current password")).toHaveCount(0);
  await change.click();
  const dialog = olive.getByRole("dialog", { name: "Change password" });
  await expect(dialog.getByLabel("Current password")).toBeFocused();
  // Refused (not the current password): that field says so, and what was typed stays.
  await dialog.getByLabel("Current password").fill("not the password");
  await dialog.getByLabel("New password").fill("a brand new passphrase");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog.getByLabel("Current password")).toHaveAccessibleDescription("Invalid password");
  await expect(dialog.getByLabel("Current password")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("New password")).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("New password")).toHaveValue("a brand new passphrase");
  await checkpoint(olive, "account-password-refused", { fullPage: false });
  // Answered, it can be closed: focus goes back to its button, and it opens again empty, without the error.
  await olive.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(change).toBeFocused();
  await change.click();
  await expect(dialog.getByLabel("Current password")).toHaveValue("");
  await expect(dialog.getByLabel("Current password")).not.toHaveAttribute("aria-invalid", "true");
  // While the change is on its way it can't be closed (Cancel is off, yet keeps focus; Escape does nothing).
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  await olive.route("**/api/auth/change-password", async (route) => {
    arrived();
    await held;
    await route.continue();
  });
  await dialog.getByLabel("Current password").fill(PASSWORD);
  await dialog.getByLabel("New password").fill("a brand new passphrase");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await reached;
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeDisabled();
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await cancel.press("Enter");
  await olive.keyboard.press("Escape");
  await expect(dialog.getByLabel("New password")).toHaveValue("a brand new passphrase");
  release();
  // Changed: it says so and closes by itself.
  await expect(olive.getByText("Password changed")).toBeVisible();
  await expect(dialog).toBeHidden();
  await olive.unroute("**/api/auth/change-password");
  // On a phone nothing runs off the side, the name's field is under its label, and the dialog fits the screen.
  await olive.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => olive.locator('[data-slot="pane-body"]').evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await olive.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const nameLabel = (await account.getByText("Name", { exact: true }).boundingBox())!;
  expect((await olive.getByLabel("Name").boundingBox())!.y).toBeGreaterThanOrEqual(nameLabel.y + nameLabel.height);
  await checkpoint(olive, "account-settings-phone");
  await change.click();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeLessThanOrEqual(844);
  await checkpoint(olive, "account-password-phone", { fullPage: false });
  await olive.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await olive.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(olive, "account-settings");
  await olive.setViewportSize({ width: 1280, height: 720 });

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
  // The page's one Save: nothing to save until the name differs.
  await expect(olive.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await olive.getByLabel("Project name").fill("A");
  // Leaving with the change not saved asks first.
  await olive.getByRole("link", { name: "Change the portal address in Domain" }).click();
  await expect(olive.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await olive.getByRole("button", { name: "Keep editing" }).click();
  await expect(olive.getByLabel("Project name")).toHaveValue("A");
  await olive.getByRole("button", { name: "Save changes" }).click();
  await expect(olive.getByText("Give the project a name of 2 characters or more")).toBeVisible();
  await olive.getByLabel("Project name").fill("  Acme Help  ");
  // Saved from the keyboard, focus stays on Save while it saves and after.
  await olive.getByRole("button", { name: "Save changes" }).focus();
  await olive.keyboard.press("Enter");
  await expect(olive.getByText("Project renamed")).toBeVisible();
  await expect(olive.getByRole("button", { name: "Save changes" })).toBeFocused();
  // The field shows the name as saved.
  await expect(olive.getByLabel("Project name")).toHaveValue("Acme Help");
  await expect(olive.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(olive.getByRole("button", { name: /Acme Help/ }).first()).toBeVisible(); // the sidebar's project switcher
  await checkpoint(olive, "settings-general");
  // A change typed while a save runs stays in the field, still to save.
  let releaseSave = () => {};
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  await olive.route(`**/app/${slug}/settings/general`, async (route) => {
    if (route.request().method() === "POST") {
      await saveHeld;
    }
    await route.continue();
  });
  await olive.getByLabel("Project name").fill("Acme Docs");
  await olive.getByRole("button", { name: "Save changes" }).click();
  await expect(olive.getByRole("button", { name: "Saving…" })).toBeVisible();
  await olive.getByLabel("Project name").fill("Acme Help");
  releaseSave();
  await expect(olive.getByRole("button", { name: /Acme Docs/ }).first()).toBeVisible();
  await expect(olive.getByLabel("Project name")).toHaveValue("Acme Help");
  await expect(olive.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await olive.unroute(`**/app/${slug}/settings/general`);
  await olive.getByRole("button", { name: "Save changes" }).click();
  await expect(olive.getByRole("button", { name: /Acme Help/ }).first()).toBeVisible();
  await expect(olive.getByRole("button", { name: "Save changes" })).toBeDisabled();
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/");
  await expect(visitor.getByRole("banner")).toContainText("Acme Help");
});

test("a teammate renames the project in another tab: once this tab hears of it, the name not edited here follows, what's typed here stays", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);
  const name = (page: typeof olive) => page.getByLabel("Project name");
  const save = (page: typeof olive) => page.getByRole("button", { name: "Save changes" });
  // Two tabs of this one's that hear of the rename when their live stream opens (it refreshes the page), let open later.
  const holdLive = async (page: typeof olive) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/live?*", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`/app/${slug}/settings/general`);
    return release;
  };
  const untouched = await olive.context().newPage();
  const releaseUntouched = await holdLive(untouched);
  const typed = await olive.context().newPage();
  const releaseTyped = await holdLive(typed);
  // Edited and typed back: still what's saved, it follows a teammate's rename like a field never touched. (Typed again
  // till Save reacts: what's typed before the page's scripts start is lost as they do.)
  await expect(async () => {
    await name(untouched).fill("Acme Docs");
    await expect(save(untouched)).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await name(untouched).fill("Acme");
  await expect(save(untouched)).toBeDisabled();
  await expect(async () => {
    await name(typed).fill("Typed here");
    await expect(save(typed)).toBeEnabled({ timeout: 1_000 });
  }).toPass();

  await olive.goto(`/app/${slug}/settings/general`);
  await expect(async () => {
    await name(olive).fill("Acme Help");
    await expect(save(olive)).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await save(olive).click();
  await expect(olive.getByText("Project renamed")).toBeVisible();

  releaseUntouched();
  await expect(untouched.getByRole("button", { name: /Acme Help/ }).first()).toBeVisible(); // the sidebar's project switcher
  await expect(name(untouched)).toHaveValue("Acme Help");
  await expect(save(untouched)).toBeDisabled();
  // The name it had is now a change to save.
  await name(untouched).fill("Acme");
  await expect(save(untouched)).toBeEnabled();

  releaseTyped();
  await expect(typed.getByRole("button", { name: /Acme Help/ }).first()).toBeVisible();
  await expect(name(typed)).toHaveValue("Typed here");
  await expect(save(typed)).toBeEnabled();
  // Typed to what's saved now, there's nothing to save.
  await name(typed).fill("Acme Help");
  await expect(save(typed)).toBeDisabled();
});

test("someone signs up from a portal, signs out and signs back in there; their password is typed on the app", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ada = await newPerson(browser, portalUrl(slug));
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  // Create an account stays on the portal; a password is typed on the app (a team may run its portal's host: its own
  // domain, or its site's path), where the account is made, and back.
  await ada.getByRole("link", { name: "Create an account" }).click();
  await expect(ada).toHaveURL(`${portalUrl(slug)}/sign-up?next=%2Ffeedback%2Ffeature-requests`);
  await ada.getByRole("link", { name: "Use a password instead" }).click();
  await ada.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-up");
  // For Acme, not the pitch to teams.
  await expect(ada.getByText("Create your Tuti account to continue to Acme.")).toBeVisible();
  await expect(ada.getByText("Ship code. Your help center keeps up.")).toHaveCount(0);
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
  await expect(laptop.getByRole("button", { name: "New post" })).toBeVisible();
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
  // The portal's Forgot your password card: the sign-in card's look (44px controls), no line inside it either.
  await vera.goto("/forgot-password");
  await expect(vera.getByRole("button", { name: "Email me a link" })).toHaveCSS("height", "44px");
  await expect(vera.getByLabel("Email")).toHaveCSS("height", "44px");
  await expect(vera.locator('[data-slot="card-footer"]')).toHaveCSS("border-top-width", "0px");
  await checkpoint(vera, "portal-forgot-password-card");
  await vera.goto("/feedback/feature-requests");
  await vera.getByRole("button", { name: "New post" }).click();
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
  // Back to the board they were on, with the idea they started.
  await expect(vera.getByRole("link", { name: "Back to Acme" })).toHaveAttribute("href", `/feedback/feature-requests?${new URLSearchParams({ title })}`);
  await checkpoint(vera, "portal-sign-in-link-sent");

  const message = await latestEmailTo(email);
  expect(message.subject).toBe("Sign in to Acme");
  const link = linkIn(message, `${portalUrl(slug)}/sign-in/link?`);
  // Opening the link only asks to confirm (mail scanners open links too), naming the address.
  await vera.goto(link);
  await expect(vera.getByText("Sign in to Acme")).toBeVisible();
  await expect(vera.getByText(`as ${email}`)).toBeVisible();
  // A card without a line inside it, as every portal card (its footer's line is the app's).
  await expect(vera.locator('[data-slot="card-footer"]')).toHaveCSS("border-top-width", "0px");
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
  // A mistyped address: back to the form with it filled in, to fix it.
  await someoneElse.getByRole("button", { name: "Use a different email" }).click();
  await expect(someoneElse.getByLabel("Email")).toHaveValue(anotherEmail);
  await expect(someoneElse.getByLabel("Email")).toBeFocused();
  await expect(someoneElse.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  // Sent from Account's sign-in, "Back" goes to the portal's home: Account would only bring them back here.
  await someoneElse.goto("/sign-in?next=%2Faccount");
  await someoneElse.getByLabel("Email").fill(anotherEmail);
  await someoneElse.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(someoneElse.getByRole("link", { name: "Back to Acme" })).toHaveAttribute("href", "/");

  // From the portal's home page it comes back to the portal's home page (the app has a "/" too).
  const wes = await newPerson(browser, portalUrl(slug));
  await wes.goto("/sign-in?next=%2F");
  const wesEmail = `e2e-${randomUUID()}@example.com`;
  await wes.getByLabel("Email").fill(wesEmail);
  await wes.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(wes.getByText("Check your email")).toBeVisible();
  await expect(wes.getByText("Not there? Check your spam folder.")).toBeVisible();
  // Focus moves to the card's title, which is read out; the next stop is "Send another link".
  await expect(wes.getByText("Check your email")).toBeFocused();
  await wes.keyboard.press("Tab");
  await expect(wes.getByRole("button", { name: "Send another link" })).toBeFocused();
  // Offline: it says so, and can be tried again.
  await wes.route("**/sign-in*", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await wes.getByRole("button", { name: "Send another link" }).click();
  await expect(wes.getByRole("status")).toHaveText("We couldn't send the email. Try again.");
  await expect(wes.getByRole("button", { name: "Send another link" })).toBeVisible();
  await wes.unroute("**/sign-in*");
  // While another link is on its way, "Use a different email" waits: the answer is about this address.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  await wes.route("**/sign-in*", async (route) => {
    if (route.request().method() === "POST") {
      holding();
      await released;
    }
    await route.continue();
  });
  await wes.getByRole("button", { name: "Send another link" }).click();
  await held;
  await expect(wes.getByRole("button", { name: "Use a different email" })).toHaveCSS("opacity", "0.5");
  // Forced: Playwright waits out aria-disabled, and a person can click it all the same.
  await wes.getByRole("button", { name: "Use a different email" }).click({ force: true });
  await expect(wes.getByText("Check your email")).toBeVisible();
  await expect(wes.getByLabel("Email")).toHaveCount(0);
  release();
  await expect(wes.getByRole("status")).toHaveText("Another link is on its way.");
  await expect.poll(() => countEmailsTo(wesEmail)).toBe(2);
  await wes.unroute("**/sign-in*");
  // Back where they came from.
  await expect(wes.getByRole("link", { name: "Back to Acme" })).toHaveAttribute("href", "/");
  await checkpoint(wes, "portal-sign-in-link-sent-actions");
  // Not there: another link to the same address, as many as the address's hourly limit allows (5), then why not.
  for (let sent = 2; sent < 5; sent++) {
    await wes.getByRole("button", { name: "Send another link" }).click();
    await expect(wes.getByRole("status")).toHaveText("Another link is on its way.");
    await expect.poll(() => countEmailsTo(wesEmail)).toBe(sent + 1);
  }
  await wes.getByRole("button", { name: "Send another link" }).click();
  await expect(wes.getByRole("status")).toHaveText("We've sent a lot of emails to this address in the last hour. Try again later.");
  // On a phone too.
  const laptopSize = wes.viewportSize()!;
  await wes.setViewportSize({ width: 390, height: 844 });
  await checkpoint(wes, "portal-sign-in-link-resend-limited-phone");
  await wes.setViewportSize(laptopSize);
  expect(countEmailsTo(wesEmail)).toBe(5);
  await wes.goto(linkIn(await latestEmailTo(wesEmail), `${portalUrl(slug)}/sign-in/link?`));
  await wes.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  // The portal's home page sends people on to its first board.
  await expect(wes).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(wes.getByRole("navigation", { name: "Portal" })).toBeVisible();
  await expect(wes.getByRole("button", { name: "Account" })).toBeVisible();
});

test("a visitor joins a portal on the portal: name and email, an emailed link, and back where they were", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ivy = await newPerson(browser, portalUrl(slug));
  await ivy.goto("/sign-in?next=%2Froadmap");
  await ivy.getByRole("link", { name: "Create an account" }).click();
  await expect(ivy).toHaveURL(`${portalUrl(slug)}/sign-up?next=%2Froadmap`);
  // The portal's page, in its header, like its sign-in.
  await expect(ivy.getByText("Join Acme")).toBeVisible();
  await expect(ivy.getByText("Vote, comment and follow ideas. We'll email you as they move forward and when they ship.")).toBeVisible();
  await expect(ivy.getByRole("navigation", { name: "Portal" })).toBeVisible();
  await expect(ivy.getByRole("link", { name: "Use a password instead" })).toHaveAttribute("href", "/continue?redirect=%2Froadmap&sign-up=1");
  await expect(ivy.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in?next=%2Froadmap");
  await checkpoint(ivy, "portal-sign-up");
  const phone = ivy.viewportSize()!;
  await ivy.setViewportSize({ width: 390, height: 844 });
  await checkpoint(ivy, "portal-sign-up-phone");
  await ivy.setViewportSize(phone);

  const email = `e2e-${randomUUID()}@example.com`;
  // A name of spaces is no name: said on the Name field, and nothing is sent.
  await ivy.getByLabel("Name").fill("   ");
  await ivy.getByLabel("Email").fill(email);
  await ivy.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(ivy.getByLabel("Name")).toHaveJSProperty("validationMessage", "Enter your name");
  expect(countEmailsTo(email)).toBe(0);
  await ivy.getByLabel("Name").fill("  Ivy Iris ");
  await ivy.getByLabel("Email").fill(email);
  await ivy.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(ivy.getByText(`We sent a sign-in link to ${email}.`)).toBeVisible();
  // Changing the address keeps the name.
  await ivy.getByRole("button", { name: "Use a different email" }).click();
  await expect(ivy.getByLabel("Name")).toHaveValue("  Ivy Iris ");
  await ivy.getByRole("button", { name: "Email me a sign-up link" }).click();
  // Another link carries the name too: the newest one makes the account.
  await ivy.getByRole("button", { name: "Send another link" }).click();
  await expect(ivy.getByRole("status")).toHaveText("Another link is on its way.");
  await expect.poll(() => countEmailsTo(email)).toBe(3);

  await ivy.goto(linkIn(await latestEmailTo(email, { after: 2 }), `${portalUrl(slug)}/sign-in/link?`));
  await ivy.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await expect(ivy).toHaveURL(`${portalUrl(slug)}/roadmap`);
  await ivy.getByRole("button", { name: "Account" }).click();
  await expect(ivy.getByRole("menu").getByText("Ivy Iris", { exact: true })).toBeVisible();
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
