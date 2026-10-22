import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("the team sets what readers can do with an article and the docs' home, seeing each change before saving it", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/articles", { title: "Inviting your team", body: "Owners and admins send invites from the Team page." });
  await api("/articles/inviting-your-team/publish", {});
  // Changed since it was published, so its page says when.
  await api("/articles/inviting-your-team", { body: "Owners and admins send invites from the Team page. Invites last a week." }, "PATCH");
  await api("/articles/inviting-your-team/publish-changes", {});

  // Customize → Content actions, beside one of the docs' articles.
  await owner.goto(`/app/${slug}/customize`);
  await owner.getByRole("link", { name: /^Content actions/ }).click();
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Copy page" })).toBeVisible();
  await expect(preview.getByText(/^Updated /)).toBeVisible();
  // Each switch shows in the preview at once.
  await owner.getByRole("switch", { name: "Copy as Markdown" }).uncheck();
  await expect(preview.getByRole("button", { name: "Copy page" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Page actions" })).toBeVisible();
  await owner.getByRole("switch", { name: "Show the last updated date" }).uncheck();
  await expect(preview.getByText(/^Updated /)).toHaveCount(0);
  await checkpoint(owner, "customize-content-actions");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Content actions saved")).toBeVisible();

  // Readers get the same.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Page actions" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Copy page" })).toHaveCount(0);
  await expect(visitor.getByText(/^Updated /)).toHaveCount(0);
  // With the menu off, there's none.
  await owner.getByRole("switch", { name: "Show the page actions menu" }).uncheck();
  await expect(preview.getByRole("button", { name: "Page actions" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Save changes" }).click();
  // Saved once nothing's left to save (the last save's toast may still be up).
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.reload();
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Page actions" })).toHaveCount(0);

  // Customize → Docs home: the heading above the search box.
  await owner.getByRole("link", { name: "Back to Customize" }).click();
  await owner.getByRole("link", { name: /^Docs home/ }).click();
  await expect(preview.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();
  await owner.getByLabel("Title", { exact: true }).fill("  How can we help?  ");
  await owner.getByLabel("Subtitle").fill("Answers to everything about Acme.");
  await expect(preview.getByRole("heading", { name: "How can we help?", level: 1 })).toBeVisible();
  await expect(preview.getByText("Answers to everything about Acme.")).toBeVisible();
  await checkpoint(owner, "customize-docs-home");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Docs home saved")).toBeVisible();
  // Saved as trimmed, and the form shows what's saved: nothing left to save.
  await expect(owner.getByLabel("Title", { exact: true })).toHaveValue("How can we help?");
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/docs");
  await expect(visitor.getByRole("heading", { name: "How can we help?", level: 1 })).toBeVisible();
});

test("the team sets the portal's search listing, seeing it as a search result and a shared link", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/seo`);
  const result = owner.getByRole("figure", { name: "Search result preview" });
  await expect(result).toContainText("Acme");
  await owner.getByLabel("Page title").fill("Acme Help Center");
  await owner.getByLabel("Meta description").fill("Answers about Acme, from the team that makes it.");
  await expect(result).toContainText("Acme Help Center");
  await expect(owner.getByRole("figure", { name: "Shared link preview" })).toContainText("Answers about Acme, from the team that makes it.");
  await expect(owner.getByText("48/160")).toBeVisible();
  await checkpoint(owner, "customize-seo");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("SEO saved")).toBeVisible();

  // Pages without a title of their own have the portal's; every page has its description.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/roadmap");
  await expect(visitor).toHaveTitle("Acme Help Center");
  // A team's portal brings its default colour scheme (here, its readers' devices').
  expect(await visitor.content()).toContain("tuti-theme-default");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", "Answers about Acme, from the team that makes it.");
  await expect(visitor.locator('meta[property="og:site_name"]')).toHaveAttribute("content", "Acme Help Center");
});

test("the team sends its old help center's addresses to the new docs", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/redirects`);
  await expect(owner.getByText("No redirects yet")).toBeVisible();
  // Pasted from the old site: its path is what's matched.
  await owner.getByLabel("Old address").fill("https://help.acme.example/hc/en-us/articles/123-Billing");
  await owner.getByLabel("New address").fill("/roadmap");
  await owner.getByRole("button", { name: "Add redirect" }).click();
  await expect(owner.getByText("Redirect added")).toBeVisible();
  const list = owner.getByRole("list", { name: "Redirects" });
  await expect(list).toContainText("/hc/en-us/articles/123-billing");
  await expect(owner.getByLabel("Old address")).toHaveValue("");
  // The portal's own addresses stay its own.
  await owner.getByLabel("Old address").fill("/sign-in");
  await owner.getByLabel("New address").fill("/docs");
  await owner.getByRole("button", { name: "Add redirect" }).click();
  await expect(owner.getByText("/sign-in is one of the portal's own addresses")).toBeVisible();
  await checkpoint(owner, "customize-redirects");

  // Someone following an old link lands on the new page.
  const visitor = await newPerson(browser, portalUrl(slug));
  // Within a few seconds: the proxy keeps a portal's redirects briefly (server/portal-redirects.ts).
  await expect(async () => {
    await visitor.goto("/hc/en-us/articles/123-billing");
    await expect(visitor).toHaveURL(`${portalUrl(slug)}/roadmap`, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();

  // Deleted, the old address is nothing again.
  await owner.getByRole("button", { name: "Delete the redirect from /hc/en-us/articles/123-billing" }).click();
  await expect(owner.getByText("Redirect deleted")).toBeVisible();
  await expect(async () => {
    expect((await visitor.request.get("/hc/en-us/articles/123-billing", { maxRedirects: 0 })).status()).toBe(404);
  }).toPass({ timeout: 20_000 });
});

test("the team's own CSS shows in the preview as it's typed, and on the portal once saved", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/custom-code`);
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.locator(".portal-header")).toBeVisible();
  await owner.getByLabel("Custom CSS").fill(".portal-header { background: rgb(1, 2, 3); }");
  await expect(preview.locator(".portal-header")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  // Its HTML runs only on an address of the team's own, which this portal doesn't have yet.
  await expect(owner.getByText("Your portal isn't on one yet", { exact: false })).toBeVisible();
  await checkpoint(owner, "customize-custom-code");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Custom code saved")).toBeVisible();

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/roadmap");
  await expect(visitor.locator(".portal-header")).toHaveCSS("background-color", "rgb(1, 2, 3)");
});
