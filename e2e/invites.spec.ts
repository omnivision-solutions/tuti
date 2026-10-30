import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { fillSignUp, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("an owner invites someone by email, who signs up from the email and joins", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const inviteeEmail = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}`);

  // The owner invites by email address; the pending invite shows who it's for.
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
  // Accepting proved the inbox, so there's nothing left to verify.
  await expect(invitee.getByText("Verify your email")).toHaveCount(0);
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

  // Removing asks first.
  await owner.getByRole("button", { name: /^Actions for / }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(/ removed$/)).toBeVisible();
  await expect(owner.getByText(inviteeEmail)).toHaveCount(0);
});

test("an invite for someone else says so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const inviteeEmail = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}`);
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
  for (const [slug, name] of [
    [first, "Acme"],
    [second, "Globex"],
  ]) {
    await owner.goto("/app/new");
    await owner.getByLabel("Name").fill(name!);
    await owner.getByLabel("URL").fill(slug!);
    await owner.getByRole("button", { name: "Create project" }).click();
    await owner.waitForURL(`**/app/${slug}`);
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
