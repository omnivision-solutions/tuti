import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { articleContent, setArticleContent } from "./articles";
import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("an article with a block this editor doesn't know opens read-only and doesn't save over it", async ({ browser }, testInfo) => {
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

  // As a newer release, during a deploy, saves a block this one doesn't have.
  const newer = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Welcome." }] },
      { type: "callout", attrs: { tone: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }] },
    ],
  };
  await setArticleContent(slug, "getting-started", newer);
  await team.reload();

  // The editor says so and is read-only; typing in it does nothing, a save is held, and the text stays as stored.
  await expect(team.getByRole("alert").filter({ hasText: "Reload the page to edit it" })).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await checkpoint(team, "article-unreadable", { fullPage: false });
  await editor.click();
  await team.keyboard.press("End");
  await team.keyboard.type(" More.");
  await team.locator("form#article-form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  // Nothing to wait for when nothing is sent: long enough for a save to have landed if one had gone.
  await team.waitForTimeout(2_000);
  await expect(team.getByText("Saved", { exact: true })).toHaveCount(0);
  expect(await articleContent(slug, "getting-started")).toEqual(newer);
});
