import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

test("an admin creates an API key, reads posts with it and revokes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "Give feedback" }).click();
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

  // The key is shown once, with a command to try it.
  await owner.goto(`/app/${slug}/settings/developers`);
  await expect(owner.getByText("No API keys yet")).toBeVisible();
  await owner.getByRole("textbox", { name: "Key name" }).fill("Zapier");
  await owner.getByRole("button", { name: "Create key" }).click();
  const shown = owner.getByRole("alert").filter({ hasText: "Copy the key for Zapier now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  expect(key).toMatch(/^tuti_/);
  await expect(owner.getByText(`${key.slice(0, 9)}… · created just now · never used`)).toBeVisible();
  await checkpoint(owner, "settings-api-key-created");

  const posts = () => fetch(`${APP_URL}/api/v1/posts`, { headers: { authorization: `Bearer ${key}` } });
  const response = await posts();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ posts: [{ number: 1, title: "Dark mode", status: "open", votes: 1 }] });

  // Revoked (after confirming), it stops working at once.
  await owner.reload();
  await expect(owner.getByText(/last used just now/)).toBeVisible();
  await owner.getByRole("button", { name: "Revoke" }).click();
  await owner.getByRole("alertdialog", { name: "Revoke Zapier?" }).getByRole("button", { name: "Revoke key" }).click();
  await expect(owner.getByText("Zapier revoked")).toBeVisible();
  await expect(owner.getByText("No API keys yet")).toBeVisible();
  expect((await posts()).status).toBe(401);

  // The API is how a team takes its data out: there's no separate export.
  await expect(owner.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Export" })).toHaveCount(0);
  expect((await owner.request.get(`/app/${slug}/settings/export/zip`)).status()).toBe(404);

  // The docs list every endpoint, generated from the same operations.
  await owner.goto("/docs/api");
  await expect(owner.getByRole("heading", { name: "API", level: 1 })).toBeVisible();
  await expect(owner.getByRole("heading", { name: /POST \/api\/v1\/posts$/ })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "MCP (for AI assistants)" })).toBeVisible();
  await checkpoint(owner, "api-docs");
});
