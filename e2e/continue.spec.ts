import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("someone with a Tuti account continues on a portal with it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Ivy is signed in on tuti.so; on Acme's portal she continues with that account.
  const ivy = await signUp(browser, APP_URL, "Ivy");
  await ivy.goto(`${portalUrl(slug)}/sign-in`);
  await checkpoint(ivy, "portal-sign-in");
  await ivy.getByRole("link", { name: "Continue with your Tuti account" }).click();
  await expect(ivy.getByText("Continue to Acme")).toBeVisible();
  await expect(ivy.getByText(`Signed in as ${ivy.email}`)).toBeVisible();
  await checkpoint(ivy, "continue-as");
  await ivy.getByRole("button", { name: "Continue as Ivy" }).click();
  await ivy.waitForURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(ivy.getByRole("button", { name: "Submit post" })).toBeVisible();
  await expect(ivy.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await checkpoint(ivy, "portal-signed-in-as-account");

  // Signed out on tuti.so, the same button asks to sign in first, then comes back.
  const bo = await newPerson(browser, portalUrl(slug));
  await bo.goto("/sign-in");
  await bo.getByRole("link", { name: "Continue with your Tuti account" }).click();
  await bo.waitForURL(`${APP_URL}/sign-in?**`);
  await bo.getByLabel("Email").fill(owner.email);
  await bo.getByLabel("Password").fill("correct horse battery staple");
  await bo.getByRole("button", { name: "Sign in" }).click();
  await bo.getByRole("button", { name: "Continue as Olive Owner" }).click();
  await bo.waitForURL(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(bo.getByRole("button", { name: "Submit post" })).toBeVisible();
});
