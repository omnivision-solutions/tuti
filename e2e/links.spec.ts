import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, pullRequestEvent } from "./github";
import { createProject, signUp } from "./helpers";
import { similar } from "./openai";

test("the team links a post to the pull request that works on it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

  await owner.goto(`/app/${slug}/p/1`);
  const field = owner.getByRole("textbox", { name: "GitHub pull request, issue or release URL" });
  await field.fill("https://example.com/nope");
  await owner.getByRole("region", { name: "GitHub links" }).getByRole("button", { name: "Link", exact: true }).click();
  await expect(owner.getByText("Paste the URL of a GitHub pull request, issue or release")).toBeVisible();

  await field.fill("https://github.com/acme/app/pull/42/files");
  await owner.getByRole("region", { name: "GitHub links" }).getByRole("button", { name: "Link", exact: true }).click();
  const link = owner.getByRole("link", { name: "acme/app#42" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/app/pull/42");
  await expect(field).toHaveValue("");
  await checkpoint(owner, "team-post-linked");

  await owner.getByRole("button", { name: "Remove acme/app#42" }).click();
  await expect(link).toHaveCount(0);
});

test("Tuti suggests the pull request a post is about, and the team links it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const installation = await connectGithub(owner, slug);

  // Texts unique to this journey: the OpenAI fake is shared by every journey.
  const [title, pr] = [`Dark mode ${slug}`, `Theme switcher ${slug}`];
  await similar(title, pr, 0.8);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill(title);
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: title })).toBeVisible();

  // A pull request that doesn't mention the post, but is about it.
  await pullRequestEvent(installation, "opened", { number: 77, title: pr });
  await owner.goto(`/app/${slug}/p/1`);
  const suggestions = owner.getByRole("list", { name: "Suggested pull requests" });
  await expect(suggestions).toContainText(`acme/app#77 · ${pr}`);
  await checkpoint(owner, "team-post-suggested-pr");

  await owner.getByRole("button", { name: "Link acme/app#77" }).click();
  await expect(owner.getByText("Linked")).toBeVisible();
  await expect(owner.getByRole("link", { name: `acme/app#77 · ${pr}` })).toHaveAttribute("href", "https://github.com/acme/app/pull/77");
  await expect(suggestions).toHaveCount(0);
});
