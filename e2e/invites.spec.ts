import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { fillSignUp, newPerson, png, signUp, skipSetup } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn, verifyEmail } from "./mail";

test("an owner invites someone by email, who signs up from the email and joins", async ({ browser }, testInfo) => {
  test.setTimeout(90_000); // two people, a dozen pages and the team's screen at three widths
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const inviteeEmail = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await skipSetup(owner, slug);

  // Until the owner's email is verified, an invite isn't emailed (the card says so): its link is there to copy.
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("button", { name: "Invite people" }).click();
  const inviting = owner.getByRole("dialog", { name: "Invite people" });
  await expect(inviting).toContainText("Verify your email to email invites; until then you'll get a link to send them.");
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Verify your email to email invites: for now, send ${inviteeEmail} this link`)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Copy link" })).toBeInViewport({ ratio: 1 });
  await checkpoint(owner, "team-invite-unverified", { fullPage: false });
  // A click beside the dialog leaves it open: the link isn't shown again.
  await owner.mouse.click(20, 400);
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).click(); // still there to use, not fading out
  await expect(inviting).toHaveAttribute("data-open");
  await expect(owner.getByRole("button", { name: "Copy link" })).toBeVisible();
  expect(countEmailsTo(inviteeEmail)).toBe(0);

  // Verified, the owner invites again (replacing that one); the pending invite shows who it's for.
  await verifyEmail(owner);
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("button", { name: "Invite people" }).click();
  await expect(inviting).not.toContainText("Verify your email");
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${inviteeEmail}`)).toBeVisible();
  await checkpoint(owner, "team-invite-sent", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(inviting).toHaveCount(0);
  await expect(owner.getByRole("list", { name: "Pending invites" }).getByText(`${inviteeEmail} · Member`)).toBeVisible();
  await checkpoint(owner, "team-invite-pending");

  // The invitee gets the email and opens its link: the page says who it's for.
  const email = await latestEmailTo(inviteeEmail);
  expect(email.subject).toBe("Olive Owner invited you to Acme on Tuti");
  const invitee = await newPerson(browser, APP_URL);
  await invitee.goto(linkIn(email, `${APP_URL}/app/auth/invite/`));
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
  // A role is a dropdown on the member's row, saved as it's picked; the owner's own is a badge. Removing is in the ⋯ menu.
  const row = owner.getByRole("main").getByRole("listitem").filter({ hasText: inviteeEmail });
  const role = row.getByRole("combobox", { name: "Role of Ivy Invitee" });
  await expect(role).toContainText("Member");
  await expect(owner.getByRole("main").getByRole("listitem").filter({ hasText: owner.email }).getByRole("combobox")).toHaveCount(0);
  await role.click();
  await checkpoint(owner, "team-member-role", { fullPage: false });
  // The role picked shows while it saves: the save is held until that's seen.
  let releaseRole = () => {};
  const roleHeld = new Promise<void>((resolve) => (releaseRole = resolve));
  await owner.route(`**/app/${slug}/settings/team`, async (route) => {
    if (route.request().method() === "POST") {
      await roleHeld;
    }
    await route.continue();
  });
  await owner.getByRole("option", { name: "Admin" }).click();
  await expect(role).toContainText("Admin");
  await expect(role).toHaveAttribute("aria-busy", "true");
  releaseRole();
  await expect(owner.getByText("Role changed to Admin")).toBeVisible();
  await owner.unroute(`**/app/${slug}/settings/team`);
  await expect(role).toContainText("Admin");
  await owner.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(owner, "team-with-invitee");
  // On a phone the dropdown goes under the name, nothing runs off the side, and the dialog fits.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(role).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await owner.getByRole("button", { name: "Invite people" }).click();
  const another = `e2e-${randomUUID()}@example.com`;
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(another);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${another}`)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Copy link" })).toBeInViewport({ ratio: 1 });
  await checkpoint(owner, "team-invite-phone", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(inviting).toHaveCount(0);
  await expect(owner.getByRole("list", { name: "Pending invites" }).getByRole("button", { name: "Revoke" })).toBeInViewport({ ratio: 1 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await checkpoint(owner, "team-with-invitee-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // The only owner can't leave: their row's menu says why when they try, not a line that's always there.
  await expect(owner.getByText("You're the only owner")).toHaveCount(0);
  await owner.getByRole("button", { name: "Actions for Olive Owner" }).click();
  await owner.getByRole("menuitem", { name: "Leave project" }).click();
  await expect(owner.getByRole("alertdialog", { name: "You're the only owner" })).toContainText("To leave, make someone else an owner first.");
  await owner.getByRole("alertdialog").getByRole("button", { name: "OK" }).click();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);

  // The new admin sees all of Settings; made a member again, only Team & roles (Access is the owners' and admins').
  // By keyboard this time: focus stays on the dropdown once the role is saved.
  await role.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("option", { name: "Member" })).toBeVisible();
  await owner.keyboard.press("ArrowDown");
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Role changed to Member")).toBeVisible();
  await expect(role).toContainText("Member");
  await expect(role).toBeFocused();
  await invitee.goto(`/app/${slug}/settings`);
  await invitee.waitForURL(`**/app/${slug}/settings/team`);
  await expect(invitee.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Team & roles"]);
  const access = await invitee.goto(`/app/${slug}/settings/access`);
  expect(access?.status()).toBe(404);
  await expect(invitee.getByRole("button", { name: "Actions for Ivy Invitee" })).toHaveCount(0); // not on a 404
  // A member sees the team, with roles as badges and nobody to invite; their own row's menu has Leave project, which asks first.
  await invitee.goto(`/app/${slug}/settings/team`);
  await expect(invitee.getByRole("combobox")).toHaveCount(0);
  await expect(invitee.getByRole("button", { name: "Invite people" })).toHaveCount(0);
  await expect(invitee.getByRole("button", { name: /^Actions for / })).toHaveCount(1);
  await invitee.getByRole("button", { name: "Actions for Ivy Invitee" }).click();
  await invitee.getByRole("menuitem", { name: "Leave project" }).click();
  await expect(invitee.getByRole("alertdialog", { name: "Leave Acme?" })).toContainText("you'll need a new invite to come back");
  await invitee.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
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

  // Removing asks first, and says their API keys and the invites they sent go with them.
  await owner.getByRole("button", { name: "Actions for Ivy Invitee" }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await expect(owner.getByRole("alertdialog")).toContainText("the API keys they created stop working, and the invites they sent are cancelled");
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
  await owner.getByRole("button", { name: "Invite people" }).click();
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(inviteeEmail);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${inviteeEmail}`)).toBeVisible();

  const someoneElse = await signUp(browser, APP_URL, "Mallory");
  await someoneElse.goto(linkIn(await latestEmailTo(inviteeEmail), `${APP_URL}/app/auth/invite/`));
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
    await owner.getByRole("button", { name: "Invite people" }).click();
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
