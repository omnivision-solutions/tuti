import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

/** An HS256 token, as a customer's app would sign it for /sso (see docs/sso.md). */
function ssoToken(secret: string, claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iat: now, exp: now + 60, jti: randomUUID(), ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("the team makes the portal private: visitors get sign-in, crawlers stay out, the team and SSO users get in", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // SSO on, then Access → Who can see your portal → Private.
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  await owner.goto(`/app/${slug}/settings/access`);
  // One row: the label names the control, the line under it says what the chosen option does, and the rest is behind ⓘ.
  const access = owner.getByRole("combobox", { name: "Who can see your portal" });
  const row = owner.locator('[data-slot="setting-row"]', { has: access });
  const more = row.getByRole("button", { name: "More about this setting" });
  await expect(access).toHaveAccessibleDescription("Anyone can read it, and sign up to post and vote.");
  await expect(owner.getByText("No readers yet.")).toHaveCount(0);
  await more.click();
  await expect(owner.getByText("It covers the portal, its docs and changelog, and the widget.", { exact: true })).toBeVisible();
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "settings-access-public");
  await access.click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();
  await expect(access).toHaveAccessibleDescription("Only your team, single sign-on users and the readers below.");
  await more.click();
  await expect(
    owner.getByText("It covers the portal, its docs and changelog, and the widget. Everyone else gets the sign-in page; sign-up is off and search engines are kept out.", { exact: true }),
  ).toBeVisible();
  await owner.keyboard.press("Escape");
  // Its readers are a card of their own, empty so far.
  await expect(owner.getByRole("heading", { name: "Readers 0", exact: true })).toBeVisible();
  await expect(owner.getByText("No readers yet.")).toBeVisible();
  await checkpoint(owner, "settings-portal-private");

  // Customize's preview still shows the portal to the team, not its sign-in page.
  await owner.goto(`/app/${slug}/settings/branding`);
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  await expect(preview.getByText("Acme is private. Sign in to see it.")).toHaveCount(0);
  // With the header's parts, and on Docs its box to search and ask (the preview has no session on the portal).
  await owner.goto(`/app/${slug}/settings/docs-home`);
  await expect(preview.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Documentation" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Search or ask AI" })).toBeVisible();

  // A signed-out visitor gets the sign-in page, and comes back to where they were going afterwards.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/roadmap");
  await expect(visitor).toHaveURL(/\/sign-in\?next=%2Froadmap$/);
  await expect(visitor.getByText("Acme is private. Sign in to see it.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Create an account" })).toHaveCount(0);
  await expect(visitor.getByRole("link", { name: "Roadmap" })).toHaveCount(0);
  await checkpoint(visitor, "portal-private-sign-in");
  // Sign-up is off; the feeds and files ask to sign in too.
  await visitor.goto("/sign-up");
  await expect(visitor).toHaveURL(/\/sign-in$/);
  const feed = await visitor.request.get("/changelog/rss.xml", { maxRedirects: 0 });
  expect(feed.status()).toBe(307);
  expect(feed.headers().location).toBe(`${portalUrl(slug)}/sign-in?${new URLSearchParams({ next: "/changelog/rss.xml" })}`);

  // Crawlers are told to keep out.
  const robots = await visitor.request.get("/robots.txt");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");

  // The widget's panel, opened without a sign-in from the customer's app.
  await visitor.goto("/widget");
  await expect(visitor.getByText("Sign in to see this.", { exact: false })).toBeVisible();
  await checkpoint(visitor, "widget-private-sign-in");

  // Someone the customer's app signs in (SSO) gets in, at the page they were sent to.
  const sam = await newPerson(browser, portalUrl(slug));
  await sam.goto(`/sso?token=${ssoToken(secret, { sub: "user-42", name: "Sam from Acme" })}&redirect=${encodeURIComponent("/roadmap")}`);
  await expect(sam).toHaveURL(/\/roadmap$/);
  await expect(sam.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  const llms = await sam.request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["cache-control"]).toBe("private, no-store");
  await checkpoint(sam, "portal-private-sso-user");

  // Signed in on the portal, the team reads it as anyone else would: only as one of its readers (Customize's preview
  // shows it to them). Whoever runs a portal's site sees its sessions, so a session started there is never the team's.
  await owner.goto(`${portalUrl(slug)}/sign-in?next=%2Froadmap`);
  await owner.getByRole("link", { name: "Sign in with Tuti" }).click();
  await owner.getByRole("button", { name: "Continue as Olive Owner" }).click();
  await expect(owner.getByText(`Acme is private, and ${owner.email} doesn't have access.`, { exact: false })).toBeVisible();
});

test("the team lets someone outside it read the private portal by email: they're emailed, sign in with a link and read it", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/access`);
  await owner.getByRole("combobox", { name: "Who can see your portal" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();

  // Added in Settings → Access → Readers: "Add readers", at the card's title, opens a dialog that closes once they're added.
  const email = `e2e-${randomUUID()}@example.com`;
  const readers = owner.getByRole("list", { name: "Readers" });
  const add = owner.getByRole("dialog", { name: "Add readers" });
  await owner.getByRole("button", { name: "Add readers" }).click();
  await expect(add).toContainText("People outside your team who may read the portal, or a whole domain like @acme.com for everyone there.");
  await add.getByLabel("Email addresses").fill(email.toUpperCase());
  await checkpoint(owner, "settings-portal-add-readers", { fullPage: false });
  await add.getByRole("button", { name: "Add readers" }).click();
  await expect(owner.getByText("1 reader added; we emailed them a link")).toBeVisible();
  await expect(add).toBeHidden();
  await expect(readers.getByRole("listitem")).toHaveText([new RegExp(`^${email}Added .* by Olive Owner`)]);
  await expect(owner.getByRole("heading", { name: "Readers 1", exact: true })).toBeVisible();
  await expect(owner.getByText("No readers yet.")).toHaveCount(0);
  // A whole domain too, but not one anyone can get an address at: the dialog stays open and says why.
  await owner.getByRole("button", { name: "Add readers" }).click();
  await expect(add.getByLabel("Email addresses")).toHaveValue("");
  await add.getByLabel("Email addresses").fill("@gmail.com");
  await add.getByRole("button", { name: "Add readers" }).click();
  await expect(add.getByText("Anyone can get an @gmail.com address: add people from it one by one")).toBeVisible();
  await expect(add.getByLabel("Email addresses")).toHaveValue("@gmail.com");
  // Closed and opened again, it starts empty, without the last error.
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeHidden();
  await owner.getByRole("button", { name: "Add readers" }).click();
  await expect(add.getByLabel("Email addresses")).toHaveValue("");
  await expect(add.getByText("Anyone can get an @gmail.com address", { exact: false })).toHaveCount(0);
  await add.getByLabel("Email addresses").fill("@example.org");
  await add.getByRole("button", { name: "Add readers" }).click();
  await expect(owner.getByText("@example.org added")).toBeVisible();
  await expect(add).toBeHidden();
  await expect(readers.getByRole("listitem").first()).toContainText("Everyone with a verified @example.org address");
  await expect(owner.getByRole("heading", { name: "Readers 2", exact: true })).toBeVisible();
  await checkpoint(owner, "settings-portal-readers");

  // On a phone the choice goes under its label at the card's width, a reader's menu stays beside its address, and nothing runs off the side.
  await owner.setViewportSize({ width: 390, height: 844 });
  const access = owner.getByRole("combobox", { name: "Who can see your portal" });
  const [label, control, card] = await Promise.all([
    owner.getByText("Who can see your portal", { exact: true }).boundingBox(),
    access.boundingBox(),
    owner.locator('[data-slot="setting-row"]', { has: access }).boundingBox(),
  ]);
  expect(control!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
  expect(control!.width).toBeGreaterThan(card!.width - 48);
  const [address, menu] = await Promise.all([readers.getByText(email, { exact: true }).boundingBox(), owner.getByRole("button", { name: `Actions for ${email}` }).boundingBox()]);
  expect(menu!.x).toBeGreaterThanOrEqual(address!.x + address!.width);
  expect(menu!.y).toBeLessThan(address!.y + address!.height);
  expect(await owner.locator('[data-slot="pane-body"]').evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await checkpoint(owner, "settings-portal-readers-phone");
  await owner.getByRole("button", { name: "Add readers" }).click();
  const box = await add.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await checkpoint(owner, "settings-portal-add-readers-phone", { fullPage: false });
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeHidden();
  await owner.setViewportSize({ width: 1280, height: 720 });

  // The email leads to the portal's sign-in; an emailed sign-in link makes the account and lets them in.
  const message = await latestEmailTo(email);
  expect(message.subject).toBe("Olive Owner gave you access to Acme");
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto(linkIn(message, `${portalUrl(slug)}/sign-in`));
  await expect(reader.getByText("Acme is private. Sign in to see it.")).toBeVisible();
  await reader.getByLabel("Email").fill(email);
  await reader.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(reader.getByText("Check your email")).toBeVisible();
  // No "Back to Acme": its pages would only bring them back to sign in.
  await expect(reader.getByRole("link", { name: /^Back to/ })).toHaveCount(0);
  await reader.goto(linkIn(await latestEmailTo(email, { after: 1 }), `${portalUrl(slug)}/sign-in/link?`));
  await reader.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await expect(reader.getByRole("button", { name: "Account" })).toBeVisible();
  await reader.goto("/roadmap");
  await expect(reader.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await checkpoint(reader, "portal-private-reader");

  // Removed, they get the sign-in page again.
  await readers.getByRole("button", { name: `Actions for ${email}` }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = owner.getByRole("alertdialog");
  await expect(confirm).toContainText("They can't read the portal until you add them again.");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${email} removed`)).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Readers 1", exact: true })).toBeVisible();
  await reader.goto("/roadmap");
  await expect(reader.getByText(`Acme is private, and ${email} doesn't have access.`, { exact: false })).toBeVisible();
});
