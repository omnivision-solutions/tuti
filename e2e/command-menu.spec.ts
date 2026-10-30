import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("⌘K jumps to a post, an article or a settings page by name, and runs an action", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/articles", { title: "Turning on dark mode", body: "Open your profile menu." });

  await team.goto(`/app/${slug}`);
  // The sidebar's Search opens it, saying the shortcut as this platform writes it.
  await team.getByRole("button", { name: /^Search/ }).click();
  const menu = team.getByRole("dialog", { name: "Go to or do" });
  const box = menu.getByRole("combobox", { name: "Search the project" });
  // Up from the first goes round to the last, past the list's fold: it scrolls into sight.
  await box.press("ArrowUp");
  await expect(menu.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option").last()).toBeInViewport();
  await box.fill("dark");
  await expect(menu.getByRole("option", { name: /Dark mode/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /Turning on dark mode/ })).toBeVisible();
  await checkpoint(team, "command-menu", { fullPage: false });
  // Arrow keys and Enter: the first is the post.
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/p/1`);

  // ⌘K (Ctrl K off a Mac) from any page: the article.
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("turning on");
  await menu.getByRole("option", { name: /Turning on dark mode/ }).click();
  await team.waitForURL(`**/app/${slug}/docs/turning-on-dark-mode`);

  // A settings page, and an action.
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("single sign");
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/settings/sso`);
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("new article");
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/docs/new`);

  // Outside a project's pages (Account settings) there's no ⌘K, so no Search button either.
  await team.goto("/app/account");
  await expect(team.getByRole("heading", { name: "Account settings" })).toBeVisible();
  await expect(team.getByRole("button", { name: /^Search/ })).toHaveCount(0);
});
