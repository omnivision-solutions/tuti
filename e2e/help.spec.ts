import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team writes a help article in a collection, publishes it, and a visitor reads it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // A collection to put it in.
  await team.getByRole("link", { name: "Help center" }).click();
  await expect(team.getByText("No articles yet")).toBeVisible();
  await team.getByRole("button", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Getting started");
  await dialog.getByLabel("Description").fill("The basics, in five minutes.");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(team.getByText("0 articles")).toBeVisible();
  await checkpoint(team, "team-help-center");

  // A draft: title, collection, a heading, text and a table.
  await team.getByRole("link", { name: "New article" }).click();
  // A refused save keeps what was typed.
  await team.getByLabel("Title").fill("Hi");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByText("Title is too short")).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Hi");
  await team.getByLabel("Title").fill("Inviting your team");
  await team.getByLabel("Collection").click();
  await team.getByRole("option", { name: "Getting started" }).click();
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.getByRole("button", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Who can invite");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Owners and admins send invites from the Team page.");
  await team.keyboard.press("Enter");
  await team.getByRole("button", { name: "Table", exact: true }).click();
  for (const cell of ["Role", "Can invite", "", "Admin", "Yes"]) {
    await team.keyboard.type(cell);
    await team.keyboard.press("Tab");
  }
  await checkpoint(team, "team-help-article-draft");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team`);
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();

  // Visitors don't see it yet.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);
  expect((await visitor.request.get(`${portalUrl(slug)}/help/inviting-your-team.md`)).status()).toBe(404);
  await visitor.goto("/help");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();

  await team.getByRole("button", { name: "Publish" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("search engines can find it");
  await confirm.getByRole("button", { name: "Publish" }).click();
  await expect(team.getByText("Published", { exact: true }).first()).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await checkpoint(team, "team-help-article-published");

  // The visitor finds it under its collection on the Help tab, and reads it.
  await visitor.goto("/");
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Help" }).click();
  const collection = visitor.getByRole("region", { name: "Getting started" });
  await expect(collection).toContainText("The basics, in five minutes.");
  await checkpoint(visitor, "portal-help-center");
  await collection.getByRole("link", { name: "Inviting your team" }).click();
  await visitor.waitForURL(/\/help\/inviting-your-team$/);
  const article = visitor.getByRole("article", { name: "Inviting your team" });
  await expect(article.getByRole("heading", { name: "Who can invite", level: 2 })).toBeVisible();
  await expect(article.getByRole("columnheader", { name: "Can invite" })).toBeVisible();
  await expect(article.getByRole("cell", { name: "Admin" })).toBeVisible();
  // Search engines get its own title and description.
  await expect(visitor).toHaveTitle("Inviting your team · Acme");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", /^Who can invite Owners and admins send invites/);
  await checkpoint(visitor, "portal-help-article");

  // AI tools get it as Markdown: at its .md URL, copied, or opened in ChatGPT or Claude with that URL.
  const markdownUrl = `${portalUrl(slug)}/help/inviting-your-team.md`;
  const markdown = await visitor.request.get(markdownUrl);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toBe(
    "# Inviting your team\n\n## Who can invite\n\nOwners and admins send invites from the Team page.\n\n" +
      "| Role | Can invite |  |\n| --- | --- | --- |\n| Admin | Yes |  |\n|  |  |  |\n",
  );
  const prompt = encodeURIComponent(`Read ${markdownUrl} and answer questions about it.`);
  await expect(visitor.getByRole("link", { name: "Open in ChatGPT" })).toHaveAttribute("href", `https://chatgpt.com/?q=${prompt}`);
  await expect(visitor.getByRole("link", { name: "Open in Claude" })).toHaveAttribute("href", `https://claude.ai/new?q=${prompt}`);
  await visitor.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await visitor.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(visitor.getByText("Copied as Markdown")).toBeVisible();
  expect(await visitor.evaluate(() => navigator.clipboard.readText())).toBe(await markdown.text());
  await checkpoint(visitor, "portal-help-article-copied");

  // Search finds it with the passage that matched; a search with no match says so.
  await visitor.goto("/help");
  const searchBox = visitor.getByRole("searchbox", { name: "Search the help center" });
  await searchBox.fill("send invites");
  await visitor.getByRole("button", { name: "Search" }).click();
  await visitor.waitForURL(/\/help\?q=send\+invites$/);
  const results = visitor.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results).toContainText("Owners and admins send invites from the Team page.");
  await checkpoint(visitor, "portal-help-search");
  await searchBox.fill("refunds");
  await searchBox.press("Enter");
  await expect(visitor.getByText("No articles match “refunds”")).toBeVisible();
  await checkpoint(visitor, "portal-help-search-empty");
  await visitor.getByRole("link", { name: "All articles" }).click();
  await expect(visitor.getByRole("region", { name: "Getting started" })).toBeVisible();

  // The visitor (signed out) says the article didn't help, and what was missing.
  await visitor.getByRole("link", { name: "Inviting your team" }).click();
  const helpful = visitor.getByRole("region", { name: "Was this helpful?" });
  await helpful.getByRole("button", { name: "No" }).click();
  await helpful.getByLabel("What were you looking for? (optional)").fill("How do I invite by email?");
  await checkpoint(visitor, "portal-help-article-feedback");
  await helpful.getByRole("button", { name: "Send" }).click();
  await expect(helpful.getByText("Thanks for letting us know.")).toBeVisible();

  // The team sees it in the help center's insights, with the article's views and the search that found nothing.
  await team.getByRole("link", { name: "Help center" }).first().click();
  await team.waitForURL(`**/app/${slug}/help`);
  await team.getByRole("link", { name: "Insights" }).click();
  await team.waitForURL(`**/app/${slug}/help/insights`);
  await expect(team.getByText("The last 30 days: 2 article views, 2 searches, 1 failed search.")).toBeVisible();
  await expect(team.getByText("2 views · 0% found it helpful (0 of 1)")).toBeVisible();
  await expect(team.getByText("How do I invite by email?")).toBeVisible();
  await expect(team.getByText("refunds", { exact: true })).toBeVisible();
  await expect(team.getByText("1 search", { exact: true })).toBeVisible();
  await checkpoint(team, "team-help-insights");

  // Deleting the collection keeps its article. While it runs (slowed down here), Delete can't be clicked again.
  await team.getByRole("link", { name: "Help center" }).first().click();
  await team.waitForURL(`**/app/${slug}/help`);
  await expect(team.getByText("1 article", { exact: true })).toBeVisible();
  await team.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await team.getByRole("button", { name: "Delete" }).click();
  const deleting = team.getByRole("alertdialog");
  await expect(deleting).toContainText("Its articles stay, without a collection.");
  await deleting.getByRole("button", { name: "Delete" }).click();
  await expect(deleting.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(deleting.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(team.getByText("Getting started deleted")).toBeVisible();
  await team.unroute("**/*");
  await expect(team.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await visitor.goto("/help");
  await expect(visitor.getByRole("link", { name: "Inviting your team" })).toBeVisible();
});
