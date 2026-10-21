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
  await ada.goto("/feedback/feature-requests");
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
  await ada.goto("/feedback/feature-requests");
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
  await vera.goto(`/feedback/feature-requests?${new URLSearchParams({ title })}`);
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
  // Opening the link only asks to confirm (mail scanners open links too), naming the address.
  await vera.goto(link);
  await expect(vera.getByText("Sign in to Acme")).toBeVisible();
  await expect(vera.getByText(`as ${email}`)).toBeVisible();
  await checkpoint(vera, "portal-sign-in-link-confirm");
  await vera.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await vera.waitForURL(/\/feedback\/feature-requests\?title=/);
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
  await laptop.goto("/sign-in");
  await laptop.getByRole("link", { name: "Forgot your password?" }).click();
  await laptop.waitForURL("**/forgot-password");
  await laptop.getByLabel("Email").fill(olive.email);
  await checkpoint(laptop, "app-forgot-password");
  await laptop.getByRole("button", { name: "Email me a link" }).click();
  await expect(laptop.getByText(`If there's an account for ${olive.email}, we've sent it a link`)).toBeVisible();
  await checkpoint(laptop, "app-forgot-password-sent");

  const message = await latestEmailTo(olive.email);
  expect(message.subject).toBe("Reset your password");
  await laptop.goto(linkIn(message, `${APP_URL}/reset-password?`));
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

test("a portal user who forgot their password resets it on the portal and signs in there", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.getByRole("button", { name: "Account" }).click();
  await ada.getByRole("menuitem", { name: "Sign out" }).click();

  await ada.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await ada.getByRole("link", { name: "Forgot your password?" }).click();
  await ada.waitForURL("**/forgot-password");
  // There's nothing to come back to here after signing in.
  await expect(ada.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  await ada.getByLabel("Email").fill(ada.email);
  await checkpoint(ada, "portal-forgot-password");
  await ada.getByRole("button", { name: "Email me a link" }).click();
  await expect(ada.getByText(`If there's an account for ${ada.email}, we've sent it a link`)).toBeVisible();

  const message = await latestEmailTo(ada.email);
  expect(message.subject).toBe("Reset your password");
  expect(message.text).toContain("your account on Acme");
  const link = linkIn(message, `${portalUrl(slug)}/reset-password?`);
  await ada.goto(link);
  // The link's token doesn't travel on in the sign-in link.
  await expect(ada.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  await ada.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await ada.getByLabel("Confirm new password").fill("a brand new passphrase");
  await checkpoint(ada, "portal-set-new-password");
  await ada.getByRole("button", { name: "Set new password" }).click();
  await ada.waitForURL("**/sign-in?reset=done");
  await ada.getByLabel("Email").fill(ada.email);
  await ada.getByLabel("Password").fill("a brand new passphrase");
  await checkpoint(ada, "portal-sign-in-after-reset");
  await ada.getByRole("button", { name: "Sign in" }).click();
  await expect(ada.getByRole("button", { name: "Account" })).toBeVisible();

  // The link worked once.
  await ada.goto(link);
  await ada.waitForURL("**/forgot-password?link=failed");
  await expect(ada.getByText("That link has expired or was already used. Ask for a new one.")).toBeVisible();
});
