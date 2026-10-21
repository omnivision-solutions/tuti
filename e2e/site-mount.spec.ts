import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { forwardToPortal, siteUrl } from "./site";

test("the team puts the portal under a path of its own site: its site forwards it, Tuti checks it, and people read it there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings`);
  await owner.getByLabel("Address").fill(`${siteUrl()}/portal`);
  await owner.getByRole("button", { name: "Add address" }).click();
  await expect(owner.getByText("Waiting for your site")).toBeVisible();
  await expect(owner.getByRole("definition").filter({ hasText: `${portalUrl(slug)}/portal/*` })).toBeVisible();
  // Not forwarded yet.
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText("didn't answer with this portal's check", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-site-pending");

  // The team's site forwards /portal to the portal, path and all; the check says /_tuti (scripts and styles) is missing.
  await forwardToPortal("/portal", portalUrl(slug));
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText(`Make sure your site forwards /_tuti/*`, { exact: false })).toBeVisible();
  await forwardToPortal("/_tuti", portalUrl(slug));
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText(`Your portal is at ${siteUrl()}/portal`)).toBeVisible();
  await expect(owner.getByText("Verified", { exact: true })).toBeVisible();

  // People read it on the site, and its links stay under the path.
  const visitor = await newPerson(browser, siteUrl());
  await expect(async () => {
    await visitor.goto("/portal");
    await expect(visitor).toHaveURL(`${siteUrl()}/portal/feedback/feature-requests`, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(visitor.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  // Its scripts come through the site too (/_tuti), and they run: the tabs below are client navigations.
  await expect(visitor.locator('script[src^="/_tuti/_next/"]').first()).toBeAttached();
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/roadmap`);
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Help" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in?next=%2Fdocs");
  await checkpoint(visitor, "portal-on-site");
  // The rest of the site is the site's.
  await visitor.goto("/pricing");
  await expect(visitor.getByRole("heading", { name: "The site's own page" })).toBeVisible();

  // Its Tuti address sends people there.
  const elsewhere = await newPerson(browser, portalUrl(slug));
  await elsewhere.goto("/roadmap");
  await expect(elsewhere).toHaveURL(`${siteUrl()}/portal/roadmap`);

  // Removed, the portal is back at its Tuti address.
  await owner.getByRole("button", { name: "Remove" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${siteUrl()}/portal removed`)).toBeVisible();
  await expect(async () => {
    await elsewhere.goto("/roadmap");
    expect(elsewhere.url()).toBe(`${portalUrl(slug)}/roadmap`);
  }).toPass({ timeout: 20_000 });
});
