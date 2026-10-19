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

  await owner.goto(`/app/${slug}/team`);
  await expect(owner.getByText(inviteeEmail)).toBeVisible();
  await expect(owner.getByText(`${inviteeEmail} · Member`)).toHaveCount(0);
  await checkpoint(owner, "team-with-invitee");
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
