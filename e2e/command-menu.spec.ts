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
  await api("/collections", { name: "Billing and invoices" });
  await api("/users", { users: [{ id: "u-long", name: "Lou Long", email: "e2e-someone.with.a.very.long.name@subsidiary.department.example.com" }] });

  await team.goto(`/app/${slug}`);
  // A keydown with no key (as browsers send when autofilling a form) is nothing to it.
  const errors: string[] = [];
  team.on("pageerror", (error) => errors.push(error.message));
  await team.evaluate(() => window.dispatchEvent(new Event("keydown")));
  expect(errors).toEqual([]);
  // The sidebar's Search opens it, saying the shortcut as this platform writes it.
  await team.getByRole("button", { name: /^Search/ }).click();
  const menu = team.getByRole("dialog", { name: "Go to or do" });
  const box = menu.getByRole("combobox", { name: "Search the project" });
  // Before anything is typed, the actions come first, then the pages, each with its part's icon from the sidebar.
  await expect(menu.getByRole("option").first()).toHaveText("New article");
  await expect(menu.getByRole("option").first().locator("svg")).toHaveClass(/lucide-book-open/);
  await expect(menu.getByRole("option", { name: "Feedback", exact: true }).locator("svg")).toHaveClass(/lucide-inbox/);
  await expect(menu.getByRole("option", { name: "Users", exact: true }).locator("svg")).toHaveClass(/lucide-contact-round/);
  await expect(menu.getByRole("option", { name: "Single sign-on" }).locator("svg")).toHaveClass(/lucide-settings/);
  await checkpoint(team, "command-menu-before-typing", { fullPage: false });
  // Scrolled away from the first option, typing filters the list: its first (New post, every action or page matching "p") is in sight.
  await menu.getByRole("listbox").evaluate((list) => (list.scrollTop = list.scrollHeight));
  await box.fill("p");
  await expect(menu.getByRole("option").first()).toHaveText(/New post/);
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option").first()).toBeInViewport();
  await box.fill("");
  // Up from the first goes round to the last, past the list's fold: it scrolls into sight.
  await box.press("ArrowUp");
  await expect(menu.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option").last()).toBeInViewport();
  await box.fill("dark");
  await expect(menu.getByRole("option", { name: /Dark mode/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /Turning on dark mode/ })).toBeVisible();
  // Found ones have their part's icon too: a post Feedback's, an article Docs'.
  await expect(menu.getByRole("option", { name: /^Dark mode/ }).locator("svg")).toHaveClass(/lucide-inbox/);
  await expect(menu.getByRole("option", { name: /Turning on dark mode/ }).locator("svg")).toHaveClass(/lucide-book-open/);
  await checkpoint(team, "command-menu", { fullPage: false });
  // Arrow keys and Enter: the first is the post.
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/p/1`);

  // ⌘K (Ctrl K off a Mac) from any page. The post just opened is under Recent, after the actions and before the pages.
  await team.keyboard.press("ControlOrMeta+k");
  await expect(menu.getByRole("option").nth(2)).toHaveText("New post (on your portal)");
  await expect(menu.getByText("Recent", { exact: true })).toBeVisible();
  await expect(menu.getByRole("option").nth(3)).toHaveText(/^Dark mode/);
  await expect(menu.getByRole("option").nth(4)).toHaveText("Home");
  // Its group is read out with it.
  await expect(menu.getByRole("option").nth(3)).toHaveAccessibleDescription("Recent");
  await expect(menu.getByRole("option", { name: "Single sign-on" })).toHaveAccessibleDescription("Settings");
  // Once something is typed, Recent goes: the search finds them.
  await box.fill("dark");
  await expect(menu.getByRole("option", { name: /^Dark mode/ })).toHaveAccessibleDescription("Posts");
  await expect(menu.getByText("Recent", { exact: true })).toHaveCount(0);
  // The article.
  await box.fill("turning on");
  await menu.getByRole("option", { name: /Turning on dark mode/ }).click();
  await team.waitForURL(`**/app/${slug}/docs/turning-on-dark-mode`);

  // On a phone, a long email wraps rather than squeezing the name out or pushing the list sideways.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.keyboard.press("ControlOrMeta+k");
  // The article opened last comes first under Recent.
  await expect(menu.getByRole("option").nth(3)).toHaveText(/^Turning on dark mode/);
  await expect(menu.getByRole("option").nth(4)).toHaveText(/^Dark mode/);
  await checkpoint(team, "command-menu-phone-before-typing", { fullPage: false });
  await box.fill("lou long");
  const lou = menu.getByRole("option", { name: /Lou Long/ });
  await expect(lou).toBeVisible();
  expect(await menu.getByRole("listbox").evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
  expect((await lou.getByText("Lou Long", { exact: true }).boundingBox())!.width).toBeGreaterThan(40);
  await checkpoint(team, "command-menu-phone", { fullPage: false });
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await team.setViewportSize({ width: 1280, height: 720 });

  // Opened from Recent, the post goes back to the top of it.
  await team.keyboard.press("ControlOrMeta+k");
  await menu.getByRole("option", { name: /^Dark mode/ }).click();
  await team.waitForURL(`**/app/${slug}/p/1`);
  await team.keyboard.press("ControlOrMeta+k");
  await expect(menu.getByRole("option").nth(3)).toHaveText(/^Dark mode/);
  await expect(menu.getByRole("option").nth(4)).toHaveText(/^Turning on dark mode/);
  await box.press("Escape");

  // A docs collection, by its name.
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("billing and");
  await menu.getByRole("option", { name: /Billing and invoices/ }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/billing-and-invoices`);

  // A settings page, and an action.
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("single sign");
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/settings/sso`);
  await team.keyboard.press("ControlOrMeta+k");
  await box.fill("new article");
  await box.press("Enter");
  await team.waitForURL(`**/app/${slug}/docs/new`);
  // In the article's editor ⌘K adds a link instead.
  await team.getByRole("textbox", { name: "Article" }).click();
  await team.keyboard.press("ControlOrMeta+k");
  await expect(team.getByRole("dialog", { name: "Add a link" })).toBeVisible();
  await expect(menu).toHaveCount(0);

  // Outside a project's pages (Account settings) there's no ⌘K, so no Search button either.
  await team.goto("/app/account");
  await expect(team.getByRole("heading", { name: "Account settings" })).toBeVisible();
  await expect(team.getByRole("button", { name: /^Search/ })).toHaveCount(0);
});
