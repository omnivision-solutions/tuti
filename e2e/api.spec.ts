import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, postFeedback, signUp } from "./helpers";

test("an admin creates an API key, reads posts with it and revokes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");

  // The key is shown once, with a command to try it.
  await owner.goto(`/app/${slug}/settings/developers`);
  await expect(owner.getByText("No API keys yet")).toBeVisible();
  // An empty list has no count beside its title.
  await expect(owner.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Create key" }).click();
  const dialog = owner.getByRole("dialog", { name: "Create an API key" });
  const name = dialog.getByRole("textbox", { name: "Key name" });
  await expect(name).toBeFocused();
  await name.fill("Zapier");
  // While the key is made, its button stays focused (disabled, not dropped), so the keyboard keeps its place.
  const create = dialog.getByRole("button", { name: /^(Create key|Creating…)$/ });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const developers = `**/app/${slug}/settings/developers`;
  await owner.route(developers, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await create.focus();
  await owner.keyboard.press("Enter");
  await expect(create).toHaveText("Creating…");
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(create).toBeFocused();
  // Nothing closes the dialog meanwhile: the key couldn't be shown.
  await owner.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeVisible();
  await create.focus();
  release();
  await expect(create).toHaveText("Create key");
  await expect(create).toBeFocused();
  await owner.unroute(developers);
  const shown = dialog.getByRole("alert").filter({ hasText: "Copy the key for Zapier now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  expect(key).toMatch(/^tuti_/);
  await checkpoint(owner, "settings-api-key-created", { fullPage: false });
  // A tap beside the dialog doesn't close it: the key isn't shown again.
  await owner.mouse.click(5, 5);
  await expect(shown).toBeVisible();
  // Closed, the key is in the list by how it starts; opened again, the dialog is empty.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  const row = owner.getByRole("list", { name: "API keys" }).getByRole("listitem");
  await expect(row).toContainText("Read only");
  await expect(row).toContainText(`${key.slice(0, 9)}… · never used`);
  await expect(owner.getByRole("heading", { name: "API keys 1" })).toBeVisible();
  await owner.getByRole("button", { name: "Create key" }).click();
  await expect(name).toHaveValue("");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await owner.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await checkpoint(owner, "settings-developers");

  const posts = () => fetch(`${APP_URL}/api/v1/posts`, { headers: { authorization: `Bearer ${key}` } });
  const response = await posts();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ posts: [{ number: 1, title: "Dark mode", status: "open", votes: 1 }] });

  // Revoked (after confirming), it stops working at once.
  await owner.reload();
  await expect(row).toContainText("… · used just now");
  await owner.getByRole("button", { name: "Actions for Zapier" }).click();
  await owner.getByRole("menuitem", { name: "Revoke" }).click();
  await owner.getByRole("alertdialog", { name: "Revoke Zapier?" }).getByRole("button", { name: "Revoke key" }).click();
  await expect(owner.getByText("Zapier revoked")).toBeVisible();
  await expect(owner.getByText("No API keys yet")).toBeVisible();
  expect((await posts()).status).toBe(401);

  // On a phone nothing runs off the side, and the dialog and its key fit the window.
  await owner.getByRole("button", { name: "Create key" }).click();
  const long = "production-crm-sync-integration-key-for-zapier";
  await name.fill(long);
  await create.click();
  await expect(dialog.getByRole("alert")).toContainText(`Copy the key for ${long} now`);
  await owner.setViewportSize({ width: 390, height: 844 });
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await checkpoint(owner, "settings-api-key-created-phone", { fullPage: false });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  expect(await owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expect(owner.getByRole("link", { name: "API docs" })).toHaveAttribute("href", "/api/docs");
  await expect(owner.getByRole("link", { name: "API docs" })).toBeInViewport({ ratio: 1 });
  await checkpoint(owner, "settings-developers-phone");
  await owner.getByRole("button", { name: `Actions for ${long}` }).click();
  await owner.getByRole("menuitem", { name: "Revoke" }).click();
  const revoke = owner.getByRole("alertdialog", { name: `Revoke ${long}?` });
  await expect(revoke).toBeVisible();
  expect(await revoke.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await expect(revoke.getByRole("button", { name: "Revoke key" })).toBeInViewport({ ratio: 1 });
  await revoke.getByRole("button", { name: "Cancel" }).click();
  await expect(revoke).toBeHidden();
  await owner.setViewportSize({ width: 1280, height: 720 });

  // The API is how a team takes its data out: there's no separate export.
  await expect(owner.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Export" })).toHaveCount(0);
  expect((await owner.request.get(`/app/${slug}/settings/export/zip`)).status()).toBe(404);

  // The docs list every endpoint, generated from the same operations.
  await owner.goto("/api/docs");
  await expect(owner.getByRole("main").getByRole("heading", { name: "API", level: 1 })).toBeVisible();
  await expect(owner.getByRole("banner").getByRole("link", { name: "Tuti home" })).toHaveAttribute("href", "/");
  await expect(owner.getByRole("heading", { name: /POST \/api\/v1\/posts$/ })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "MCP (for AI assistants)" })).toBeVisible();
  await checkpoint(owner, "api-docs");
});
