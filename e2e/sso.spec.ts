import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

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
  const sso = `/sso?token=${token}&redirect=${encodeURIComponent("/b/feature-requests")}`;
  const sam = await newPerson(browser, portalUrl(slug));
  await sam.goto(sso);
  await expect(sam).toHaveURL(/\/b\/feature-requests$/);
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
