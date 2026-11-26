import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

/** An HS256 token, as a customer's app would sign it for /sso (see docs/sso.md). */
function ssoToken(secret: string, claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iat: now, exp: now + 60, jti: randomUUID(), ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("a private portal's changelog by email: its readers subscribe and get the entries; an address that isn't one gets nothing", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  await team.goto(`/app/${slug}/settings/sso`);
  await team.getByRole("switch", { name: "Single sign-on" }).click();
  const secret = await team.getByRole("alert").filter({ hasText: "Copy your secret key now" }).locator("code").innerText();
  const api = await apiFor(team, slug);
  await api("/portal", { access: "private" }, "PATCH");

  // A customer the team's app signs in: one of the portal's readers, at the address the app gives.
  const address = `e2e-${randomUUID()}@example.com`;
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto(`/sso?token=${ssoToken(secret, { sub: "user-1", name: "Ada", email: address })}&redirect=${encodeURIComponent("/changelog")}`);
  await reader.getByRole("main").getByRole("button", { name: "Subscribe" }).click();
  const subscribe = reader.getByRole("region", { name: "Get updates by email" });
  // An address that isn't one of the readers': the same answer, and nothing sent.
  const stranger = `e2e-${randomUUID()}@example.com`;
  await subscribe.getByRole("textbox", { name: "Email" }).fill(stranger);
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText(`Check your inbox: we sent a link to ${stranger} to confirm.`);
  // Their own.
  await subscribe.getByRole("textbox", { name: "Email" }).fill(address);
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText(`Check your inbox: we sent a link to ${address} to confirm.`);
  await checkpoint(reader, "private-changelog-subscribe");
  // Confirmed from another browser (their phone, say), not signed in to the portal: the link alone does it.
  const phone = await newPerson(browser, portalUrl(slug));
  await phone.goto(linkIn(await latestEmailTo(address, { subject: /^Confirm Acme's updates by email$/ }), portalUrl(slug)));
  await phone.getByRole("button", { name: "Confirm subscription" }).click();
  await expect(phone.getByRole("heading", { name: "You get Acme's updates by email" })).toBeVisible();
  await checkpoint(phone, "private-changelog-confirmed");

  // The team publishes with Email subscribers: the editor counts the one reader, and it goes to them.
  await api("/changelog", { title: "Dark mode is here", body: "Switch themes from your profile menu." });
  await team.goto(`/app/${slug}/changelog/1`);
  const announced = team.getByRole("group", { name: "How it's announced" });
  await expect(announced.getByRole("checkbox", { name: "Email subscribers" })).toHaveAccessibleDescription("1 person who can read your portal subscribed.");
  await team.getByRole("complementary", { name: "Entry settings" }).evaluate((sidebar) => sidebar.scrollTo(0, sidebar.scrollHeight));
  await checkpoint(team, "private-changelog-editor");
  await api("/changelog/1/publish", { emailSubscribers: true });
  const entry = await latestEmailTo(address, { subject: /^Acme: Dark mode is here$/ });
  expect(entry.text).toContain("Switch themes from your profile menu.");
  expect(countEmailsTo(stranger)).toBe(0);
  // The team's list of subscribers says who gets it on a private portal.
  await team.goto(`/app/${slug}/users?view=subscribers`);
  await expect(team.getByText("Your portal is private, so its changelog is emailed only to subscribers who can read it.")).toBeVisible();
  await checkpoint(team, "private-subscribers-list");
});
