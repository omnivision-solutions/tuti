import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";
import { similar } from "./openai";

test("duplicates are suggested while typing, and flagged for the team to settle", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const run = randomUUID().slice(0, 6); // the fake's vectors are shared by parallel journeys
  const original = `Export to CSV ${run}`;
  const duplicate = `Download my data as a spreadsheet ${run}`;
  // Different words, same idea: only embeddings can tell (80% similar).
  await similar(original, duplicate, 0.8);

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "Give feedback" }).click();
  await ada.getByLabel("Title").fill(original);
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: original })).toBeVisible();

  // While typing a similar title, the portal suggests voting on the existing post.
  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests");
  await bo.getByRole("button", { name: "Give feedback" }).click();
  await bo.getByLabel("Title").fill(duplicate);
  const suggestions = bo.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" });
  await expect(suggestions.getByRole("link", { name: new RegExp(original) })).toBeVisible();
  await checkpoint(bo, "portal-similar-while-typing");
  await bo.getByRole("button", { name: "Submit feedback" }).click();
  await expect(bo.getByRole("link", { name: duplicate })).toBeVisible();

  // The team sees it flagged, and can list only possible duplicates.
  await owner.goto(`/app/${slug}/feedback?show=duplicates`);
  const flagged = owner.getByRole("listitem").filter({ hasText: "Possible duplicate" });
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toContainText(duplicate);
  await checkpoint(owner, "team-possible-duplicates");

  // The post shows what it may duplicate; "Not a duplicate" settles it for good.
  await flagged.getByRole("link", { name: duplicate }).click();
  const panel = owner.getByText("Possible duplicates").locator("xpath=ancestor::*[@data-slot='card'][1]");
  await expect(panel).toContainText(original);
  await expect(panel).toContainText("80% similar");
  await checkpoint(owner, "team-duplicate-panel");
  await panel.getByRole("button", { name: "Not a duplicate" }).click();
  await expect(owner.getByText("Possible duplicates")).toHaveCount(0);

  await owner.goto(`/app/${slug}/feedback?show=duplicates`);
  await expect(owner.getByRole("listitem").filter({ hasText: "Possible duplicate" })).toHaveCount(0);
});
