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
