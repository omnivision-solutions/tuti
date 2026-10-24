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

  await owner.goto(`/app/${slug}/customize/address`);
  // Customize → Address: the Tuti address, a domain of its own or a sub-folder of the site: they pick the sub-folder.
  await checkpoint(owner, "settings-own-address-choice");
  await owner.getByRole("radio", { name: /Sub-folder/ }).click();
  await owner.getByRole("textbox", { name: "Your site" }).fill(siteUrl());
  await owner.getByRole("textbox", { name: "Path" }).fill("/portal");
  await owner.getByRole("button", { name: "Set up sub-folder" }).click();
  await expect(owner.getByText("Waiting for your site")).toBeVisible();
  // Not both: with the path set, there's no domain to add until it's removed.
  await expect(owner.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "true");
  await expect(owner.getByRole("textbox", { name: "Custom domain" })).toHaveCount(0);
  await expect(owner.getByText(`To switch, remove ${new URL(siteUrl()).host}/portal first.`)).toBeVisible();
  await expect(owner.getByRole("region", { name: "Forward /portal/*" })).toContainText(`${portalUrl(slug)}/portal/*`);
  // A guide per platform, with the team's own rules written out.
  await owner.getByRole("button", { name: "Vercel" }).click();
  const guide = owner.getByRole("dialog", { name: "Put your portal under /portal with Vercel" });
  await expect(guide).toContainText(`"destination": "${portalUrl(slug)}/portal/:path*"`);
  await checkpoint(owner, "settings-site-guide", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(guide).toBeHidden();
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
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Docs" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in?next=%2Fdocs");
  await checkpoint(visitor, "portal-on-site");

  // The team's own HTML (Customize → Custom code) runs on their site, and not when the same path is
  // opened on the portal's Tuti host (which answers it too: the site forwards there).
  await owner.goto(`/app/${slug}/customize/custom-code`);
  await owner.getByLabel("Custom HTML").fill('<p id="team-html">From the team</p><script>document.body.dataset.teamScript = "ran"</script>');
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Custom code saved")).toBeVisible();
  await visitor.goto("/portal/docs");
  await expect(visitor.locator("#team-html")).toHaveText("From the team");
  await expect(visitor.locator("body")).toHaveAttribute("data-team-script", "ran");
  const direct = await newPerson(browser, portalUrl(slug));
  await direct.goto("/portal/docs");
  await expect(direct.getByRole("heading", { name: "Docs" }).first()).toBeVisible();
  await expect(direct.locator("#team-html")).toHaveCount(0);
  await expect(direct.locator("body")).not.toHaveAttribute("data-team-script", "ran");
  await owner.goto(`/app/${slug}/customize/address`);

  // Signing up, posting and signing out there, all under the path.
  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/sign-in?next=%2Fdocs`);
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await expect(visitor).toHaveURL(new RegExp(`^${siteUrl().replace(/[.:]/g, "\\$&")}/portal/sign-up`));
  await visitor.getByLabel("Name").fill("Ada");
  await visitor.getByLabel("Email").fill(`e2e-${randomUUID()}@example.com`);
  await visitor.getByLabel("Password").fill("correct horse battery staple");
  await visitor.getByRole("button", { name: "Sign up" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  await visitor.goto("/portal/feedback/feature-requests");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await visitor.getByLabel("Title").fill("Dark mode on our site");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await visitor.getByRole("link", { name: "Dark mode on our site" }).click();
  await visitor.waitForURL((url) => url.origin === siteUrl() && url.pathname.startsWith("/portal/feedback/feature-requests/"));
  await expect(visitor.getByRole("heading", { name: "Dark mode on our site" })).toBeVisible();
  await checkpoint(visitor, "portal-on-site-signed-in");
  await visitor.getByRole("button", { name: "Account" }).click();
  await visitor.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(new URL(visitor.url()).pathname.startsWith("/portal")).toBe(true);
  // The rest of the site is the site's.
  await visitor.goto("/pricing");
  await expect(visitor.getByRole("heading", { name: "The site's own page" })).toBeVisible();

  // Its Tuti address sends people there.
  const elsewhere = await newPerson(browser, portalUrl(slug));
  await elsewhere.goto("/roadmap");
  await expect(elsewhere).toHaveURL(`${siteUrl()}/portal/roadmap`);

  // Removed, the portal is back at its Tuti address.
  await owner.getByRole("button", { name: "Remove sub-folder" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${siteUrl()}/portal removed`)).toBeVisible();
  // And either can be picked again.
  await expect(owner.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "false");
  await expect(async () => {
    await elsewhere.goto("/roadmap");
    expect(elsewhere.url()).toBe(`${portalUrl(slug)}/roadmap`);
  }).toPass({ timeout: 20_000 });
});
