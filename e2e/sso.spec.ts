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
  await owner.goto(`/app/${slug}/settings/sso`);
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
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Basics" });

  // Without groups, "Specific groups" in the collection dialog points to Settings → Groups.
  await owner.goto(`/app/${slug}/docs`);
  const tree = owner.getByRole("navigation", { name: "Docs", exact: true });
  await tree.getByRole("button", { name: "Add to your docs" }).click();
  await owner.getByRole("menuitem", { name: "New collection" }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await dialog.getByRole("radio", { name: "Specific groups" }).check();
  await expect(dialog.getByRole("group", { name: "Who can read" })).toContainText("You don't have any groups yet. Create one");
  await checkpoint(owner, "team-docs-collection-no-groups", { fullPage: false });
  await dialog.getByRole("link", { name: "Create one" }).click();
  await expect(owner).toHaveURL(/\/settings#groups$/);

  // A group in Settings → Groups: a name, the claim the app's token says and a description.
  const groups = owner.getByRole("region", { name: "Groups" });
  await expect(groups).toContainText("No groups yet");
  await groups.getByRole("button", { name: "New group" }).click();
  const groupDialog = owner.getByRole("dialog");
  await groupDialog.getByLabel("Name", { exact: true }).fill("Enterprise customers");
  await groupDialog.getByLabel("SSO group name (optional)").fill("enterprise");
  await groupDialog.getByLabel("Description").fill("On the Enterprise plan");
  await checkpoint(owner, "team-settings-new-group", { fullPage: false });
  await groupDialog.getByRole("button", { name: "Add group" }).click();
  await expect(owner.getByText("Group added")).toBeVisible();
  await expect(groups).toContainText("enterprise · 0 readers · On the Enterprise plan");

  // "Specific groups" on a new collection: the group, picked from the list.
  await owner.goto(`/app/${slug}/docs`);
  await tree.getByRole("button", { name: "Add to your docs" }).click();
  await owner.getByRole("menuitem", { name: "New collection" }).click();
  await dialog.getByLabel("Name").fill("Enterprise");
  await dialog.getByRole("radio", { name: "Specific groups" }).check();
  await dialog.getByRole("checkbox", { name: "Enterprise customers" }).check();
  await checkpoint(owner, "team-docs-collection-pick-group", { fullPage: false });
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(owner.getByText("Collection added")).toBeVisible();
  // Its page's Access says so.
  await tree.getByRole("link", { name: "Enterprise", exact: true }).click();
  await owner.getByRole("tab", { name: "Access" }).click();
  await expect(owner.getByRole("tabpanel", { name: "Access" }).getByRole("checkbox", { name: "Enterprise customers" })).toBeChecked();
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
  await sam.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Setting up SAML" }).click();
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

test("who can read: an article for signed-in readers, and a tab for a group", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  const api = await apiFor(owner, slug);
  await api("/groups", { name: "Enterprise customers", claim: "enterprise" });
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "Enterprise" });
  await api("/collections", { name: "Basics", tab: "guides" });
  await api("/collections", { name: "SAML", tab: "enterprise" });
  for (const [title, collection] of [
    ["Getting started", "basics"],
    ["Pricing", "basics"],
    ["Setting up SAML", "saml"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // In the editor's settings: "Who can read", inheriting from its collection, set to signed-in readers.
  await owner.goto(`/app/${slug}/docs/pricing`);
  await owner.getByRole("button", { name: "Settings" }).click();
  const articleSettings = owner.getByRole("dialog", { name: "Article settings" });
  const whoCanRead = articleSettings.getByRole("group", { name: "Who can read" });
  await expect(whoCanRead.getByRole("radio", { name: "Inherit from Basics" })).toBeChecked();
  await expect(whoCanRead).toContainText("Anyone can read it");
  await whoCanRead.getByRole("radio", { name: "Signed-in readers" }).check();
  await checkpoint(owner, "team-docs-article-who-can-read", { fullPage: false });
  await articleSettings.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Settings saved")).toBeVisible();
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner.getByRole("region", { name: "Articles" }).getByRole("listitem").filter({ hasText: "Pricing" }).getByText("Signed-in", { exact: true })).toBeVisible();

  // Someone signed out doesn't find it; anyone signed in on the portal reads it.
  const visitor = await newPerson(browser, portalUrl(slug));
  expect((await visitor.request.get("/docs/pricing")).status()).toBe(404);
  await visitor.goto("/docs");
  await expect(visitor.getByRole("main").getByRole("link", { name: "Getting started" })).toBeVisible();
  await expect(visitor.getByRole("main").getByRole("link", { name: "Pricing" })).toHaveCount(0);
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.goto("/docs/pricing");
  await expect(reader.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();

  // The Enterprise tab, for the group: "Who can read" in its page's Access.
  const tree = owner.getByRole("navigation", { name: "Docs", exact: true });
  const access = owner.getByRole("tabpanel", { name: "Access" });
  await tree.getByRole("link", { name: "Enterprise", exact: true }).click();
  await owner.getByRole("tab", { name: "Access" }).click();
  await expect(access.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await access.getByRole("radio", { name: "Specific groups" }).check();
  await access.getByRole("checkbox", { name: "Enterprise customers" }).check();
  await checkpoint(owner, "team-docs-tab-who-can-read", { fullPage: false });
  await access.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Tab saved")).toBeVisible();

  // A collection in it inherits that, and says so.
  await tree.getByRole("link", { name: "SAML", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/docs/collections/saml`);
  await owner.getByRole("tab", { name: "Access" }).click();
  const collectionAccess = access.getByRole("group", { name: "Who can read" });
  await expect(collectionAccess.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await expect(collectionAccess).toContainText("Readers in Enterprise customers");
  await checkpoint(owner, "team-docs-collection-who-can-read", { fullPage: false });

  // The tab, its collection and article are gone for everyone but the group (and the team).
  for (const person of [visitor, reader]) {
    await person.goto("/docs");
    await expect(person.getByRole("link", { name: "Enterprise", exact: true })).toHaveCount(0);
    for (const path of ["/docs/enterprise", "/docs/saml", "/docs/setting-up-saml"]) {
      expect((await person.request.get(path)).status()).toBe(404);
    }
  }
  const sam = await newPerson(browser, portalUrl(slug));
  await sam.goto(`/sso?token=${ssoToken(secret, { sub: "user-42", name: "Sam from Acme", groups: ["enterprise"] })}&redirect=${encodeURIComponent("/docs")}`);
  await expect(sam).toHaveURL(/\/docs$/);
  await sam.getByRole("link", { name: "Enterprise", exact: true }).first().click();
  await sam.getByRole("main").getByRole("link", { name: "Setting up SAML" }).click();
  await expect(sam.getByRole("heading", { level: 1, name: "Setting up SAML" })).toBeVisible();
  await checkpoint(sam, "portal-docs-tab-for-a-group");
});

test("people without access: an article shown with a lock asks people signed out to sign in, and tells others they don't have access", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/groups", { name: "Enterprise customers", claim: "enterprise" });
  await api("/collections", { name: "Basics" });
  for (const [title, body] of [
    ["Getting started", "Getting started."],
    ["Pricing", "Enterprise pricing: ask for the zebra plan."],
  ]) {
    const article = await api("/articles", { title, body, collection: "basics" });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // In the article's settings, "People without access" shows once some people can't read it: the group only, shown with a lock.
  await owner.goto(`/app/${slug}/docs/pricing`);
  await owner.getByRole("button", { name: "Settings" }).click();
  const articleSettings = owner.getByRole("dialog", { name: "Article settings" });
  const withoutAccess = articleSettings.getByRole("group", { name: "People without access" });
  await expect(withoutAccess).toBeHidden();
  const whoCanRead = articleSettings.getByRole("group", { name: "Who can read" });
  await whoCanRead.getByRole("radio", { name: "Specific groups" }).check();
  await whoCanRead.getByRole("checkbox", { name: "Enterprise customers" }).check();
  await expect(withoutAccess.getByRole("radio", { name: "Inherit from Basics" })).toBeChecked();
  await expect(withoutAccess).toContainText("Hidden (the default)");
  await withoutAccess.getByRole("radio", { name: "Show with a lock" }).check();
  await expect(withoutAccess.getByRole("link", { name: "Preview as a reader" })).toHaveAttribute("href", `${portalUrl(slug)}/docs/pricing?preview=signed-out`);
  await withoutAccess.scrollIntoViewIfNeeded();
  await checkpoint(owner, "team-docs-article-people-without-access", { fullPage: false });
  await articleSettings.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Settings saved")).toBeVisible();

  // Signed out: listed with a lock; its page has its title and asks them to sign in, never its text.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/basics");
  // The collection's list (the tree, in the page too, comes first).
  const locked = visitor.getByRole("main").getByRole("link", { name: "Pricing Locked" }).last();
  await expect(locked).toBeVisible();
  await expect(visitor.getByRole("navigation", { name: "Docs" }).getByRole("link", { name: "Pricing Locked" })).toBeVisible();
  await checkpoint(visitor, "portal-docs-locked-in-list");
  await locked.click();
  await expect(visitor.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();
  await expect(visitor.getByText("Sign in to read this.")).toBeVisible();
  await expect(visitor.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", /\/sign-in\?next=%2Fdocs%2Fpricing$/);
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await checkpoint(visitor, "portal-docs-locked-page");
  const page = await visitor.request.get("/docs/pricing");
  expect(page.status()).toBe(200);
  expect(await page.text()).not.toContain("zebra");
  expect((await visitor.request.get("/docs/pricing.md")).status()).toBe(404);
  // Search finds it by its title, with nothing of its text.
  await visitor.goto("/docs?q=pricing");
  await expect(visitor.getByRole("list", { name: "Search results" }).getByRole("link", { name: "Pricing Locked" })).toBeVisible();
  // Words only in its text find nothing.
  await visitor.goto("/docs?q=zebra");
  await expect(visitor.getByText("No articles match “zebra”")).toBeVisible();

  // Signed in, but not in the group: they don't have access.
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.goto("/docs/pricing");
  await expect(reader.getByText("You don't have access to this.")).toBeVisible();
  await expect(reader.getByText("zebra")).toHaveCount(0);
  await checkpoint(reader, "portal-docs-locked-signed-in");

  // "Preview as a reader", in the settings again, opens the portal as people signed out see it.
  await owner.getByRole("button", { name: "Settings" }).click();
  await expect(withoutAccess.getByRole("radio", { name: "Show with a lock" })).toBeChecked();
  const [preview] = await Promise.all([owner.waitForEvent("popup"), withoutAccess.getByRole("link", { name: "Preview as a reader" }).click()]);
  await expect(preview.getByText("Sign in to read this.")).toBeVisible();
});

test("a group from conditions: readers whose properties match read its collection", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  const api = await apiFor(owner, slug);

  // The app has signed in two people: one on the Pro plan, one on Free.
  const signIn = async (sub: string, name: string, properties: Record<string, unknown>) => {
    const person = await newPerson(browser, portalUrl(slug));
    await person.goto(`/sso?token=${ssoToken(secret, { sub, name, properties })}&redirect=${encodeURIComponent("/docs")}`);
    await expect(person).toHaveURL(/\/docs$/);
    return person;
  };
  await signIn("user-1", "Ada from Acme", { plan: "pro", seats: 12 });
  await signIn("user-2", "Bea from Acme", { plan: "free" });

  // A group by condition, with who matches now as it's written.
  await owner.goto(`/app/${slug}/settings#groups`);
  const groups = owner.getByRole("region", { name: "Groups" });
  await groups.getByRole("button", { name: "New group" }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Pro customers");
  const preview = dialog.getByRole("status");
  await expect(preview).toHaveText("Complete a condition to see who matches.");
  await dialog.getByRole("button", { name: "Add condition" }).click();
  const condition = dialog.getByRole("group", { name: "Condition 1" });
  await condition.getByLabel("Attribute").fill("plan");
  await expect(preview).toHaveText("Complete a condition to see who matches.");
  await condition.getByRole("combobox", { name: "Operator" }).click();
  await owner.getByRole("option", { name: "is one of" }).click();
  await condition.getByLabel("Value").fill("pro, enterprise");
  await expect(preview).toHaveText("1 reader matches now: Ada from Acme.");
  await checkpoint(owner, "team-settings-group-conditions-preview", { fullPage: false });
  // On a phone, each condition's row wraps instead of squeezing its fields.
  const desktop = owner.viewportSize()!;
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "team-settings-group-conditions-preview-phone", { fullPage: false });
  await owner.setViewportSize(desktop);
  // Values match exactly: "Pro" isn't "pro".
  await condition.getByLabel("Value").fill("Pro");
  await expect(preview).toHaveText("No readers match now.");
  await condition.getByLabel("Value").fill("pro, free");
  await expect(preview).toHaveText("2 readers match now: Ada from Acme and Bea from Acme.");
  await condition.getByLabel("Value").fill("pro, enterprise");
  await expect(preview).toHaveText("1 reader matches now: Ada from Acme.");
  await dialog.getByRole("button", { name: "Add group" }).click();
  await expect(owner.getByText("Group added")).toBeVisible();
  await expect(groups).toContainText("plan is one of pro, enterprise · 1 reader: Ada from Acme");
  await checkpoint(owner, "team-settings-groups-with-conditions", { fullPage: false });

  // A collection for it, with an article.
  await api("/collections", { name: "Pro guides", groups: ["pro-customers"] });
  const article = await api("/articles", { title: "Bulk export", body: "Export everything at once.", collection: "pro-guides" });
  await api(`/articles/${article.slug}/publish`, {});

  // Bea (Free) doesn't see it; Ada (Pro) reads it.
  const bea = await signIn("user-2", "Bea from Acme", { plan: "free" });
  await expect(bea.getByRole("link", { name: "Bulk export" })).toHaveCount(0);
  expect((await bea.request.get("/docs/bulk-export")).status()).toBe(404);
  const ada = await signIn("user-1", "Ada from Acme", { plan: "pro", seats: 12 });
  await ada.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Bulk export" }).click();
  await expect(ada.getByRole("heading", { level: 1, name: "Bulk export" })).toBeVisible();
  await checkpoint(ada, "portal-docs-condition-group-reader");
});
