import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team puts a table of contents in an article; readers jump to its headings on the portal and in the widget", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  await team.getByLabel("Title").fill("Installing Acme");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("Everything you need to get going.");
  await team.keyboard.press("Enter");
  // Not offered in a list (or a quote or table): it goes beside the headings it lists.
  await team.keyboard.type("/bulleted");
  await team.keyboard.press("Enter");
  await team.keyboard.type("/tab");
  await expect(team.getByRole("listbox", { name: "Blocks" }).getByRole("option")).toHaveText(["Table", "Code tabs"]);
  for (let i = 0; i < 4; i++) {
    await team.keyboard.press("Backspace");
  }
  await team.keyboard.press("Enter");
  await expect(editor.locator("ul")).toHaveCount(0);
  // From the / menu; with no headings yet, it says what it will show.
  await team.keyboard.type("/contents");
  await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "Table of contents" }).click();
  await expect(editor.getByText("Table of contents: the headings you add show here.")).toBeVisible();
  // It lists the headings as they're written below it.
  await editor.locator("p").last().click();
  const section = async (block: string, heading: string, paragraphs: number) => {
    await team.keyboard.type(block);
    await team.keyboard.press("Enter");
    await team.keyboard.type(heading);
    for (let i = 1; i <= paragraphs; i++) {
      await team.keyboard.press("Enter");
      await team.keyboard.type(`${heading}, step ${i}: a few words to read.`);
    }
    await team.keyboard.press("Enter");
  };
  await section("/heading", "Download", 6);
  await section("/subheading", "On a Mac", 6);
  await section("/heading", "Next steps", 6);
  const editorToc = editor.getByRole("navigation", { name: "In this article" });
  await expect(editorToc.getByRole("listitem")).toHaveText([/^Download/, "On a Mac", "Next steps"]);
  await editorToc.scrollIntoViewIfNeeded();
  await checkpoint(team, "team-article-table-of-contents", { fullPage: false });

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/installing-acme`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // On the portal, its links jump to the headings, an h3 under its h2.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 700 });
  await visitor.goto("/docs/installing-acme");
  const article = visitor.getByRole("article", { name: "Installing Acme" });
  const toc = article.getByRole("navigation", { name: "In this article" });
  await expect(toc.getByRole("link")).toHaveText(["Download", "On a Mac", "Next steps"]);
  await expect(toc.getByRole("listitem").filter({ hasText: /^Download/ }).getByRole("listitem")).toHaveText("On a Mac");
  // On a phone, where "On this page" is left out.
  await expect(visitor.getByRole("navigation", { name: "On this page" })).toBeHidden();
  await checkpoint(visitor, "portal-article-table-of-contents-phone", { fullPage: false });
  await toc.getByRole("link", { name: "Next steps" }).click();
  await visitor.waitForURL(/\/docs\/installing-acme#next-steps$/);
  await expect(article.getByRole("heading", { name: "Next steps", level: 2 })).toBeInViewport();

  // The widget's help pane gives the headings the same ids.
  await visitor.goto("/widget?tab=docs&article=installing-acme");
  const paneToc = visitor.getByRole("navigation", { name: "In this article" });
  await expect(paneToc.getByRole("link")).toHaveText(["Download", "On a Mac", "Next steps"]);
  await checkpoint(visitor, "widget-article-table-of-contents", { fullPage: false });
  const nextSteps = visitor.getByRole("heading", { name: "Next steps", level: 2 });
  await expect(nextSteps).not.toBeInViewport();
  await paneToc.getByRole("link", { name: "Next steps" }).click();
  await expect(nextSteps).toBeInViewport();
  await checkpoint(visitor, "widget-article-table-of-contents-jumped", { fullPage: false });
});
