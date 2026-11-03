import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team writes an article's how-to as numbered steps, and a visitor follows them", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  await team.getByLabel("Title").fill("Connecting GitHub");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("It takes a minute.");
  await team.keyboard.press("Enter");
  // "Steps" in the / menu: a block with one step, the cursor in its title.
  const blocks = team.getByRole("listbox", { name: "Blocks" });
  await team.keyboard.type("/step");
  await expect(blocks.getByRole("option")).toHaveText(["Steps"]);
  await team.keyboard.press("Enter");
  await expect(editor.locator("p.is-empty")).toHaveAttribute("data-placeholder", "Step title");
  await team.keyboard.type("Install the app");
  // Enter after the title starts the step's body; Enter on its empty last line starts the next step.
  await team.keyboard.press("Enter");
  await team.keyboard.type("Open Settings, then Integrations, and click Install.");
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Pick your repositories");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Only the ones you pick are read.");
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  // Backspace on a new, empty step takes it out again; back at the end of the step before.
  const steps = editor.locator("ol.rich-steps > li");
  await expect(steps).toHaveCount(3);
  await team.keyboard.press("Backspace");
  await expect(steps).toHaveCount(2);
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Check it worked");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Merged pull requests show up in Autopilot.");
  // Enter, Enter, then Enter on the new step's empty title leaves the steps, onto a line after them.
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  await team.keyboard.press("Enter");
  await team.keyboard.type("That's all.");
  await expect(steps).toHaveCount(3);
  await expect(editor.locator("ol.rich-steps + p")).toHaveText("That's all.");
  await checkpoint(team, "team-article-steps-editor");

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/connecting-github`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // On the portal: a list of numbered steps, each its title and body.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/connecting-github");
  const article = visitor.getByRole("article", { name: "Connecting GitHub" });
  const items = article.locator("ol.rich-steps").getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("Install the appOpen Settings, then Integrations, and click Install.");
  await expect(items.nth(2).locator(".rich-step-title")).toHaveText("Check it worked");
  await expect(article.getByText("That's all.")).toBeVisible();
  await checkpoint(visitor, "portal-article-steps");

  // As Markdown: a numbered list, each title in bold, its body under it.
  const markdown = await (await visitor.request.get(`${portalUrl(slug)}/docs/connecting-github.md`)).text();
  expect(markdown).toContain(
    "1. **Install the app**\n\n   Open Settings, then Integrations, and click Install.\n\n2. **Pick your repositories**\n\n   Only the ones you pick are read.\n\n3. **Check it worked**",
  );
});
