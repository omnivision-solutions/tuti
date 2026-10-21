import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

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

  // SSO on, then Portal access → Private.
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();
  await expect(owner.getByText("Only your team, people your app signs in with single sign-on, and the readers you add below.", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-portal-private");

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

  // So does the team, with their Tuti account.
  await owner.goto(`${portalUrl(slug)}/sign-in?next=%2Froadmap`);
  await owner.getByRole("link", { name: "Continue with your Tuti account" }).click();
  await owner.getByRole("button", { name: "Continue as Olive Owner" }).click();
  await expect(owner).toHaveURL(`${portalUrl(slug)}/roadmap`);
  await expect(owner.getByRole("heading", { name: "Roadmap" })).toBeVisible();
});

test("the team lets someone outside it read the private portal by email: they're emailed, sign in with a link and read it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();

  // Added in Settings → Portal access → Readers.
  const email = `e2e-${randomUUID()}@example.com`;
  const readers = owner.getByRole("region", { name: "Readers" });
  await readers.getByLabel("Email addresses").fill(email.toUpperCase());
  await readers.getByRole("button", { name: "Add readers" }).click();
  await expect(owner.getByText("1 reader added; we emailed them a link")).toBeVisible();
  await expect(readers.getByRole("listitem")).toHaveText([new RegExp(`^${email}Added .* by Olive Owner`)]);
  await expect(readers.getByLabel("Email addresses")).toHaveValue("");
  // A whole domain too, but not one anyone can get an address at.
  await readers.getByLabel("Email addresses").fill("@gmail.com");
  await readers.getByRole("button", { name: "Add readers" }).click();
  await expect(readers.getByText("Anyone can get an @gmail.com address: add people from it one by one")).toBeVisible();
  await readers.getByLabel("Email addresses").fill("@example.org");
  await readers.getByRole("button", { name: "Add readers" }).click();
  await expect(owner.getByText("@example.org added")).toBeVisible();
  await expect(readers.getByRole("listitem").first()).toContainText("Everyone with a verified @example.org address");
  await checkpoint(owner, "settings-portal-readers");

  // The email leads to the portal's sign-in; an emailed sign-in link makes the account and lets them in.
  const message = await latestEmailTo(email);
  expect(message.subject).toBe("Olive Owner gave you access to Acme");
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto(linkIn(message, `${portalUrl(slug)}/sign-in`));
  await expect(reader.getByText("Acme is private. Sign in to see it.")).toBeVisible();
  await reader.getByLabel("Email").fill(email);
  await reader.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(reader.getByText("Check your email")).toBeVisible();
  await reader.goto(linkIn(await latestEmailTo(email, { after: 1 }), `${portalUrl(slug)}/sign-in/link?`));
  await reader.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await expect(reader.getByRole("button", { name: "Account" })).toBeVisible();
  await reader.goto("/roadmap");
  await expect(reader.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await checkpoint(reader, "portal-private-reader");

  // Removed, they get the sign-in page again.
  await readers.getByRole("button", { name: `Remove ${email}` }).click();
  const confirm = owner.getByRole("alertdialog");
  await expect(confirm).toContainText("They can't read the portal until you add them again.");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${email} removed`)).toBeVisible();
  await reader.goto("/roadmap");
  await expect(reader.getByText(`Acme is private, and ${email} doesn't have access.`, { exact: false })).toBeVisible();
});
