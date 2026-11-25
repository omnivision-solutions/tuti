import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

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

test("an entry for some groups only: their readers see it on the changelog, everyone else doesn't, nor its page", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("switch", { name: "Single sign-on" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your secret key now" }).locator("code").innerText();

  // The team's app: two users, a group for enterprise customers, and two entries, one for them only.
  const api = await apiFor(owner, slug);
  await api("/users", { users: [{ id: "user-1", properties: { plan: "enterprise" } }, { id: "user-2", properties: { plan: "free" } }] });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/changelog", { title: "Dark mode", body: "Switch themes from your profile menu." });
  await api("/changelog", { title: "Audit log export", body: "Download your audit log as CSV.", groups: ["enterprise"] });
  await api("/changelog/1/publish", {});
  await api("/changelog/2/publish", {});

  const titles = (page: typeof owner) => page.getByRole("main").getByRole("heading", { level: 2 });

  // Signed out: only everyone's, and the other's page isn't there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog");
  await expect(titles(visitor)).toHaveText(["Dark mode"]);
  await visitor.goto("/changelog/2");
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await checkpoint(visitor, "changelog-signed-out");

  // An enterprise customer, signed in by the team's app: both, and its page.
  const ada = await newPerson(browser, portalUrl(slug));
  await ada.goto(`/sso?token=${ssoToken(secret, { sub: "user-1", name: "Ada" })}&redirect=${encodeURIComponent("/changelog")}`);
  await expect(titles(ada)).toHaveText(["Audit log export", "Dark mode"]);
  await checkpoint(ada, "changelog-enterprise");
  await ada.getByRole("link", { name: "Audit log export" }).click();
  await expect(ada.getByRole("heading", { level: 1, name: "Audit log export" })).toBeVisible();
  await expect(ada.getByText("Download your audit log as CSV.")).toBeVisible();

  // A customer on another plan: only everyone's.
  const bea = await newPerson(browser, portalUrl(slug));
  await bea.goto(`/sso?token=${ssoToken(secret, { sub: "user-2", name: "Bea" })}&redirect=${encodeURIComponent("/changelog")}`);
  await expect(titles(bea)).toHaveText(["Dark mode"]);
});
