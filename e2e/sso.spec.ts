import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** An HS256 token, as a customer's app would sign it for /sso (see docs/sso.md). */
function ssoToken(secret: string, claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iat: now, exp: now + 60, jti: randomUUID(), ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("a team enables SSO; their app signs people into the portal, once per token", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Enabling SSO shows the secret once, with the integration snippet.
  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secretAlert = owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" });
  const secret = await secretAlert.locator("code").innerText();
  expect(secret).toMatch(/^tsso_/);
  await expect(owner.getByText(`${portalUrl(slug)}/sso`).first()).toBeVisible();
  await checkpoint(owner, "team-sso-enabled");

  // The customer's app sends a signed-in user to the portal's /sso with a token.
  const token = ssoToken(secret, { sub: "user-42", name: "Sam from Acme", email: "sam@example.com" });
  const sso = `/sso?token=${token}&redirect=${encodeURIComponent("/feedback/feature-requests")}`;
  const sam = await newPerson(browser, portalUrl(slug));
  await sam.goto(sso);
  await expect(sam).toHaveURL(/\/feedback\/feature-requests$/);
  await expect(sam.getByRole("button", { name: "Submit feedback" })).toBeVisible();
  await expect(sam.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await checkpoint(sam, "portal-signed-in-with-sso");

  // The same token can't be used again.
  const replay = await newPerson(browser, portalUrl(slug));
  await replay.goto(sso);
  await expect(replay).toHaveURL(/\/sso\/error\?code=token_already_used$/);
  await expect(replay.getByText("This sign-in link was already used.")).toBeVisible();
  await checkpoint(replay, "portal-sso-error");

  // Rotating the secret (after confirming) shows a new one; tokens signed with the old one stop working.
  await owner.getByRole("button", { name: "Rotate secret" }).click();
  const rotateDialog = owner.getByRole("alertdialog", { name: "Rotate the SSO secret?" });
  await checkpoint(owner, "team-rotate-sso-confirm", { fullPage: false });
  await rotateDialog.getByRole("button", { name: "Rotate secret" }).click();
  await expect(owner.getByText("SSO secret rotated")).toBeVisible();
  const newSecret = await secretAlert.locator("code").innerText();
  expect(newSecret).not.toBe(secret);
  await replay.goto(`/sso?token=${ssoToken(secret, { sub: "user-42" })}`);
  await expect(replay).toHaveURL(/code=invalid_token$/);

  // Once SSO is disabled (after confirming), even a token signed with the current secret is refused.
  await owner.getByRole("button", { name: "Disable" }).click();
  await owner.getByRole("alertdialog", { name: "Disable single sign-on?" }).getByRole("button", { name: "Disable SSO" }).click();
  await expect(owner.getByRole("button", { name: "Enable SSO" })).toBeVisible();
  await replay.goto(`/sso?token=${ssoToken(newSecret, { sub: "user-42" })}`);
  await expect(replay).toHaveURL(/code=sso_not_enabled$/);
});

test("a collection for one reader group: people the app signs in with that group see it, everyone else doesn't", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Basics" });

  // Without groups, the collection dialog points to Settings → Groups.
  await owner.goto(`/app/${slug}/docs`);
  await owner.getByRole("button", { name: "New collection" }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByRole("group", { name: "Only for groups" })).toContainText("It's for everyone who can read your docs.");
  await checkpoint(owner, "team-docs-collection-no-groups", { fullPage: false });
  await dialog.getByRole("link", { name: "Settings → Groups" }).click();
  await expect(owner).toHaveURL(/\/settings#groups$/);

  // A group in Settings → Groups: a name, the claim the app's token says and a description.
  const groups = owner.getByRole("region", { name: "Groups" });
  await expect(groups).toContainText("No groups yet");
  await groups.getByRole("button", { name: "New group" }).click();
  const groupDialog = owner.getByRole("dialog");
  await groupDialog.getByLabel("Name").fill("Enterprise customers");
  await groupDialog.getByLabel("Claim").fill("enterprise");
  await groupDialog.getByLabel("Description").fill("On the Enterprise plan");
  await checkpoint(owner, "team-settings-new-group", { fullPage: false });
  await groupDialog.getByRole("button", { name: "Add group" }).click();
  await expect(owner.getByText("Group added")).toBeVisible();
  await expect(groups).toContainText("enterprise · 0 readers · On the Enterprise plan");

  // "Only for groups" on a new collection: the group, picked from the list.
  await owner.goto(`/app/${slug}/docs`);
  await owner.getByRole("button", { name: "New collection" }).click();
  await dialog.getByLabel("Name").fill("Enterprise");
  await dialog.getByRole("checkbox", { name: "Enterprise customers" }).check();
  await checkpoint(owner, "team-docs-collection-pick-group", { fullPage: false });
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(owner.getByText("Collection added")).toBeVisible();
  await expect(owner.getByRole("region", { name: "Collections" })).toContainText("Only for Enterprise customers");
  await checkpoint(owner, "team-docs-collection-groups");
  for (const [title, collection] of [
    ["Getting started", "basics"],
    ["Setting up SAML", "enterprise"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // A visitor sees what's for everyone; the SAML article isn't there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  await expect(visitor.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Basics"]);
  expect((await visitor.request.get("/docs/setting-up-saml")).status()).toBe(404);

  // Someone the app signs in with the group sees it too.
  const sam = await newPerson(browser, portalUrl(slug));
  await sam.goto(`/sso?token=${ssoToken(secret, { sub: "user-42", name: "Sam from Acme", groups: ["enterprise"] })}&redirect=${encodeURIComponent("/docs")}`);
  await expect(sam).toHaveURL(/\/docs$/);
  await expect(sam.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Basics", "Enterprise"]);
  await sam.getByRole("link", { name: "Setting up SAML" }).click();
  await expect(sam.getByRole("heading", { level: 1, name: "Setting up SAML" })).toBeVisible();
  await checkpoint(sam, "portal-docs-group-reader");

  // The team sees Sam in the group, and can't delete it while the collection is for it.
  await owner.goto(`/app/${slug}/settings#groups`);
  await expect(groups).toContainText("enterprise · 1 reader");
  await groups.scrollIntoViewIfNeeded();
  await checkpoint(owner, "team-settings-groups", { fullPage: false });
  await groups.getByRole("button", { name: "Delete Enterprise customers" }).click();
  await owner.getByRole("alertdialog", { name: "Delete Enterprise customers?" }).getByRole("button", { name: "Delete" }).click();
  await expect(owner.getByText("Used by Enterprise; remove it from them first")).toBeVisible();
  await checkpoint(owner, "team-settings-group-in-use", { fullPage: false });
});
