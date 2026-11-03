import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team adds a collapsible block to an article; readers open it on the portal and in the widget", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.getByRole("link", { name: "Docs", exact: true }).click();
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  await team.getByLabel("Title").fill("Exporting your data");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("Common questions:");
  await team.keyboard.press("Enter");
  // From the / menu, the cursor in its summary (which says so while it's empty); Enter goes on to its body.
  await team.keyboard.type("/coll");
  await expect(team.getByRole("listbox", { name: "Blocks" }).getByRole("option")).toHaveText(["Collapsible"]);
  await team.keyboard.press("Enter");
  const block = editor.locator(".rich-details");
  await expect(block.locator(".rich-details-summary")).toHaveAttribute("data-placeholder", "Summary");
  await checkpoint(team, "team-article-collapsible-new", { fullPage: false });
  // Backspace in its empty summary takes it away again.
  await team.keyboard.press("Backspace");
  await expect(block).toHaveCount(0);
  await team.keyboard.type("/coll");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Can I export my votes?");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Yes, as a CSV file from Settings.");
  // Enter on an empty last line leaves it.
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Still stuck? Write to us.");
  await expect(block.locator(".rich-details-body p")).toHaveText(["Yes, as a CSV file from Settings."]);
  await expect(editor.locator("xpath=./p").filter({ hasText: "Still stuck? Write to us." })).toBeVisible();
  await checkpoint(team, "team-article-collapsible");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/exporting-your-data`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // On the portal it's closed: its summary opens it.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/exporting-your-data");
  const article = visitor.getByRole("article", { name: "Exporting your data" });
  const answer = article.getByText("Yes, as a CSV file from Settings.");
  await expect(article.getByText("Can I export my votes?")).toBeVisible();
  await expect(answer).toBeHidden();
  await checkpoint(visitor, "portal-article-collapsible-closed");
  await article.getByText("Can I export my votes?").click();
  await expect(answer).toBeVisible();
  await checkpoint(visitor, "portal-article-collapsible-open");
  // AI tools read it all: the summary in bold, then its body.
  const markdown = await (await visitor.request.get(`${portalUrl(slug)}/docs/exporting-your-data.md`)).text();
  expect(markdown).toContain("**Can I export my votes?**\n\nYes, as a CSV file from Settings.\n\nStill stuck? Write to us.");

  // The widget's help pane too.
  await visitor.goto("/widget?tab=docs&article=exporting-your-data");
  await expect(visitor.getByText("Yes, as a CSV file from Settings.")).toBeHidden();
  await visitor.getByText("Can I export my votes?").click();
  await expect(visitor.getByText("Yes, as a CSV file from Settings.")).toBeVisible();
  await checkpoint(visitor, "widget-article-collapsible-open");
});
