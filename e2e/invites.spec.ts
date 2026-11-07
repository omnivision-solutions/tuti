import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { fillSignUp, newPerson, png, signUp, skipSetup } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn, verifyEmail } from "./mail";

test("an owner invites someone by email, who signs up from the email and joins", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const inviteeEmail = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await skipSetup(owner, slug);

  // Until the owner's email is verified, an invite isn't emailed: its link is there to copy.
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Verify your email to email invites: for now, send ${inviteeEmail} this link`)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Copy link" })).toBeVisible();
  await checkpoint(owner, "team-invite-unverified");
  expect(countEmailsTo(inviteeEmail)).toBe(0);

  // Verified, the owner invites again (replacing that one); the pending invite shows who it's for.
  await verifyEmail(owner);
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${inviteeEmail}`)).toBeVisible();
  await expect(owner.getByText(`${inviteeEmail} · Member`)).toBeVisible();
  await checkpoint(owner, "team-invite-sent");

  // The invitee gets the email and opens its link: the page says who it's for.
  const email = await latestEmailTo(inviteeEmail);
  expect(email.subject).toBe("Olive Owner invited you to Acme on Tuti");
  const invitee = await newPerson(browser, APP_URL);
  await invitee.goto(linkIn(email, `${APP_URL}/invite/`));
  await expect(invitee.getByText(`This invite is for ${inviteeEmail}`)).toBeVisible();
  await checkpoint(invitee, "invite-page-signed-out");

  // Signing up from there uses the invited address, then comes back to accept.
  await invitee.getByRole("link", { name: "Create account" }).click();
  await expect(invitee.getByLabel("Email")).toHaveValue(inviteeEmail);
  await fillSignUp(invitee, "Ivy Invitee");
  await invitee.waitForURL("**/invite/**");
  await invitee.getByRole("button", { name: "Accept invite" }).click();
  await invitee.waitForURL(`**/app/${slug}`);
  // Accepting doesn't verify the address (whoever invited them has the link too): their sign-up email's link does.
  await expect(invitee.getByText("Verify your email.")).toBeVisible();
  await checkpoint(invitee, "invitee-joined");

  // Team is in Settings now, as Team & roles; its old address still lands there.
  await owner.goto(`/app/${slug}/team`);
  await owner.waitForURL(`**/app/${slug}/settings/team`);
  await expect(owner.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Team & roles" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByText(inviteeEmail)).toBeVisible();
  await expect(owner.getByText(`${inviteeEmail} · Member`)).toHaveCount(0);
  // Each role is a badge; changing it and removing are in the member's ••• menu.
  const row = owner.getByRole("main").getByRole("listitem").filter({ hasText: inviteeEmail });
  await expect(row.getByText("Member", { exact: true })).toBeVisible();
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await row.getByRole("button", { name: /^Actions for / }).click();
  await owner.getByRole("menuitem", { name: "Change role" }).click();
  await checkpoint(owner, "team-member-menu", { fullPage: false });
  await owner.getByRole("menuitemradio", { name: "Admin" }).click();
  await expect(owner.getByText("Role changed to Admin")).toBeVisible();
  await expect(row.getByText("Admin", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-with-invitee");

  // The new admin sees all of Settings; made a member again, only Team & roles (Access is the owners' and admins').
  await owner.getByRole("button", { name: /^Actions for / }).click();
  await owner.getByRole("menuitem", { name: "Change role" }).click();
  await owner.getByRole("menuitemradio", { name: "Member" }).click();
  await expect(owner.getByText("Role changed to Member")).toBeVisible();
  await invitee.goto(`/app/${slug}/settings`);
  await invitee.waitForURL(`**/app/${slug}/settings/team`);
  await expect(invitee.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Team & roles"]);
  const access = await invitee.goto(`/app/${slug}/settings/access`);
  expect(access?.status()).toBe(404);
  await expect(invitee.getByRole("button", { name: "Leave project" })).toHaveCount(0); // not on a 404
  await invitee.goto(`/app/${slug}/settings/team`);
  await expect(invitee.getByRole("button", { name: "Leave project" })).toBeVisible();
  // The Inbox says Messages in the widget is off, with no link to Settings they can't open.
  await invitee.goto(`/app/${slug}/inbox`);
  const off = invitee.getByRole("note").filter({ hasText: "Messages in the widget is off" });
  await expect(off).toBeVisible();
  await expect(off.getByRole("link")).toHaveCount(0);

  // The invitee has a photo, uploaded on Account into the project.
  await invitee.goto("/app/account");
  await invitee.getByLabel("Photo", { exact: true }).setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png(96, 96) });
  await expect(invitee.getByRole("img", { name: "Photo preview" })).toBeVisible();
  await invitee.getByRole("button", { name: "Save", exact: true }).click();
  await expect(invitee.getByRole("button", { name: /Ivy Invitee/ }).locator('[data-slot="avatar-image"]')).toHaveCount(1);
  const saved = await invitee.getByRole("button", { name: /Ivy Invitee/ }).locator('[data-slot="avatar-image"]').getAttribute("src");
  // A second one picked but not saved yet, as they're removed from the team (below).
  await invitee.getByLabel("Photo", { exact: true }).setInputFiles({ name: "me-2.png", mimeType: "image/png", buffer: png(120, 120) });
  await expect(invitee.getByRole("img", { name: "Photo preview" })).toHaveAttribute("src", /^http/);
  await expect(invitee.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  // Removing asks first, and says their API keys go with them.
  await owner.getByRole("button", { name: /^Actions for / }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await expect(owner.getByRole("alertdialog")).toContainText("the API keys they created stop working");
  await checkpoint(owner, "remove-member", { fullPage: false });
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(/ removed$/)).toBeVisible();
  await expect(owner.getByText(inviteeEmail)).toHaveCount(0);

  // Their Save then keeps the name and says the photo wasn't saved (an upload in a project they've left); the old photo stays.
  await invitee.getByLabel("Name").fill("Ivy I. Invitee");
  await invitee.getByRole("button", { name: "Save", exact: true }).click();
  await expect(invitee.getByText("Name saved; the photo wasn't: Upload not found")).toBeVisible();
  await expect(invitee.getByRole("button", { name: /Ivy I\. Invitee/ }).locator('[data-slot="avatar-image"]')).toHaveAttribute("src", saved!);

  // Without a project, their photo can't be changed, only removed: from the keyboard, focus moves to Upload, still off.
  await invitee.goto("/app/account");
  const upload = invitee.getByRole("button", { name: "Upload photo" });
  await expect(upload).toBeDisabled();
  await expect(upload).toHaveAccessibleDescription("Join a project to upload a photo. Without one, your initials show.");
  await invitee.getByRole("button", { name: "Remove", exact: true }).press("Enter");
  await expect(upload).toBeFocused();
  await invitee.getByRole("button", { name: "Save", exact: true }).click();
  await expect(invitee.getByText("Profile updated")).toBeVisible();
  await expect(invitee.getByRole("button", { name: /Ivy I\. Invitee/ }).locator('[data-slot="avatar-fallback"]')).toHaveText("II");
});

test("an invite for someone else says so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const inviteeEmail = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await verifyEmail(owner);
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await skipSetup(owner, slug);
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${inviteeEmail}`)).toBeVisible();

  const someoneElse = await signUp(browser, APP_URL, "Mallory");
  await someoneElse.goto(linkIn(await latestEmailTo(inviteeEmail), `${APP_URL}/invite/`));
  await expect(someoneElse.getByText(`You're signed in as ${someoneElse.email}`)).toBeVisible();
  await expect(someoneElse.getByRole("button", { name: "Accept invite" })).toHaveCount(0);
  await checkpoint(someoneElse, "invite-page-other-account");
  await someoneElse.getByRole("link", { name: "Use another account" }).click();
  // The sign-in form is prefilled with the invited address.
  await expect(someoneElse.getByLabel("Email")).toHaveValue(inviteeEmail);
});

test("someone with an account sees invites on the dashboard, declines one and accepts another", async ({
  browser,
}, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const [first, second] = [`e2e-${randomUUID().slice(0, 8)}`, `e2e-${randomUUID().slice(0, 8)}`];

  // Ivy already has an account and has verified her email.
  const ivy = await signUp(browser, APP_URL, "Ivy");
  await ivy.goto(linkIn(await latestEmailTo(ivy.email), `${APP_URL}/api/auth/verify-email`));

  // An owner invites her to two projects.
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await verifyEmail(owner);
  for (const [slug, name] of [
    [first, "Acme"],
    [second, "Globex"],
  ]) {
    await owner.goto("/app/new");
    await owner.getByLabel("Name").fill(name!);
    await owner.getByLabel("URL").fill(slug!);
    await owner.getByRole("button", { name: "Create project" }).click();
    await skipSetup(owner, slug);
    await owner.goto(`/app/${slug}/team`);
    await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(ivy.email);
    await owner.getByRole("button", { name: "Send invite" }).click();
    await expect(owner.getByText(`Invite sent to ${ivy.email}`)).toBeVisible();
  }

  // Both show on her dashboard, without opening any email.
  await ivy.goto("/app");
  const acme = ivy.getByRole("alert").filter({ hasText: "Join Acme" });
  const globex = ivy.getByRole("alert").filter({ hasText: "Join Globex" });
  await expect(acme).toContainText("Olive Owner invited you to join Acme as a member.");
  await expect(globex).toBeVisible();
  await checkpoint(ivy, "dashboard-pending-invites");

  await globex.getByRole("button", { name: "Decline" }).click();
  await expect(globex).toHaveCount(0);
  await acme.getByRole("button", { name: "Accept" }).click();
  await ivy.waitForURL(`**/app/${first}`);
  await expect(ivy.getByRole("alert").filter({ hasText: "Join" })).toHaveCount(0);
  await checkpoint(ivy, "joined-from-dashboard");

  await owner.goto(`/app/${second}/team`);
  await expect(owner.getByText(`${ivy.email} · Member`)).toHaveCount(0); // declined: no longer pending
});
