import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { articleContent, setArticleContent } from "./articles";
import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("an article with something this editor doesn't know opens read-only, shows what it can, and isn't saved over", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  await team.getByLabel("Title").fill("Getting started");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("Welcome.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/getting-started`);

  const welcome = { type: "paragraph", content: [{ type: "text", text: "Welcome." }] };
  // As a newer release saves during a deploy: a block this one doesn't have, then an attribute it doesn't have.
  for (const [name, stored] of [
    ["a new block", { type: "doc", content: [welcome, { type: "callout", attrs: { tone: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }] }] }],
    ["a new attribute", { type: "doc", content: [{ ...welcome, attrs: { textAlign: "center" } }] }],
  ] as const) {
    await test.step(name, async () => {
      await setArticleContent(slug, "getting-started", stored);
      await team.reload();
      // It says so, shows the part it can read, and is read-only; typing does nothing and a save doesn't go.
      await expect(team.getByRole("alert").filter({ hasText: "Reload the page to edit it" })).toBeVisible();
      await expect(editor).toHaveText("Welcome.");
      await expect(editor).toHaveAttribute("contenteditable", "false");
      if (name === "a new block") {
        await checkpoint(team, "article-unreadable", { fullPage: false });
      }
      await editor.click();
      await team.keyboard.press("End");
      await team.keyboard.type(" More.");
      expect(await submitGetsPastTheEditor(team)).toBe(false);
      expect(await articleContent(slug, "getting-started")).toEqual(stored);
    });
  }
});

/**
 * Submits the article's form and says whether the submit reached the page beyond it (where it would be sent): the
 * editor holds it at the form, stopping it there, synchronously.
 */
function submitGetsPastTheEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let reached = false;
    const seen = () => {
      reached = true;
    };
    document.addEventListener("submit", seen);
    (document.getElementById("article-form") as HTMLFormElement).requestSubmit();
    document.removeEventListener("submit", seen);
    return reached;
  });
}
