import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team writes install steps as code tabs and a config file as named code; a reader switches tabs, also in the widget", async ({
  browser,
}, testInfo) => {
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
  const blocks = team.getByRole("listbox", { name: "Blocks" });
  const bar = team.getByRole("toolbar", { name: "Formatting" });
  const naming = team.getByRole("dialog", { name: "Name the code" });
  /** Names the code block the cursor is in from the bar's `button`; the cursor goes back where it was. */
  const name = async (button: string, value: string) => {
    await bar.getByRole("button", { name: button }).click();
    await naming.getByRole("textbox").fill(value);
    await naming.getByRole("button", { name: "Save" }).click();
    await expect(naming).toBeHidden();
    await expect(editor).toBeFocused();
  };

  // Code tabs from the / menu: two to start with, the cursor in the first.
  await team.keyboard.type("/code");
  await expect(blocks.getByRole("option")).toHaveText(["Code block", "Code tabs"]);
  await team.keyboard.press("ArrowDown");
  await team.keyboard.press("Enter");
  await team.keyboard.type("npm install acme");
  // The bar over the tabs renames, adds and removes them; text formatting doesn't apply to code.
  await expect(bar.getByRole("button", { name: "Bold" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Rename tab" }).click();
  await expect(naming.getByRole("textbox")).toHaveValue("Tab 1");
  await team.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await name("Rename tab", "npm");
  // Down from the end of a tab goes to the next.
  await team.keyboard.press("ArrowDown");
  await team.keyboard.type("pnpm add acme");
  await bar.getByRole("button", { name: "Rename tab" }).click();
  // A tab needs a label.
  await naming.getByRole("textbox").fill("");
  await naming.getByRole("button", { name: "Save" }).click();
  await expect(naming.getByText("A tab needs a label.")).toBeVisible();
  await naming.getByRole("textbox").fill("pnpm");
  await naming.getByRole("button", { name: "Save" }).click();
  await expect(naming).toBeHidden();
  await expect(editor).toBeFocused();
  await bar.getByRole("button", { name: "Add tab" }).click();
  await team.keyboard.type("yarn add acme");
  await name("Rename tab", "yarn");
  // One too many, removed.
  await bar.getByRole("button", { name: "Add tab" }).click();
  await team.keyboard.type("bun add acme");
  await bar.getByRole("button", { name: "Remove tab" }).click();
  await expect(editor.getByText("bun add acme")).toHaveCount(0);
  await expect(editor.locator("[data-code-tabs] pre")).toHaveCount(3);
  expect(await editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => [tab.dataset.filename, tab.textContent]))).toEqual([
    ["npm", "npm install acme"],
    ["pnpm", "pnpm add acme"],
    ["yarn", "yarn add acme"],
  ]);

  // Backspace at the start of a tab doesn't join it to the one before; a third Enter at the end of one leaves the tabs
  // (no tab without a label).
  await editor.getByText("pnpm add acme").click();
  await team.keyboard.press("Home");
  await team.keyboard.press("Backspace");
  await editor.getByText("npm install acme").click();
  await team.keyboard.press("End");
  for (let i = 0; i < 3; i++) {
    await team.keyboard.press("Enter");
  }
  await expect
    .poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => tab.textContent)))
    .toEqual(["npm install acme", "pnpm add acme", "yarn add acme"]);
  // Shift+Enter is a new line in the tab (not a tab without a label), and a selection across two tabs can't join them.
  await editor.getByText("npm install acme").click();
  await team.keyboard.press("End");
  await team.keyboard.press("Shift+Enter");
  await expect(editor.locator("[data-code-tabs] pre")).toHaveCount(3);
  await team.keyboard.press("Backspace");
  await team.keyboard.press("Shift+ArrowDown");
  await team.keyboard.press("Backspace");
  await team.keyboard.type("x");
  await expect
    .poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => [tab.dataset.filename, tab.textContent])))
    .toEqual([
      ["npm", "npm install acme"],
      ["pnpm", "pnpm add acme"],
      ["yarn", "yarn add acme"],
    ]);

  // Down from the end of the last tab leaves them; a code block there gets a file name.
  await editor.getByText("yarn add acme").click();
  await team.keyboard.press("End");
  await team.keyboard.press("ArrowDown");
  await team.keyboard.type("/code block");
  await team.keyboard.press("Enter");
  await team.keyboard.type('{ "project": "acme" }');
  await name("File name", "acme.json");
  await expect(editor.locator('pre[data-filename="acme.json"]')).toBeVisible();
  await checkpoint(team, "team-article-code-tabs-editor");

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/installing-acme`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // A reader sees the first tab's code, and switches with a click or the arrow keys.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/installing-acme");
  const article = visitor.getByRole("article", { name: "Installing Acme" });
  const tab = (name: string) => article.getByRole("radio", { name, exact: true });
  await expect(tab("npm")).toBeChecked();
  await expect(article.getByText("npm install acme")).toBeVisible();
  await expect(article.getByText("pnpm add acme")).toBeHidden();
  await article.getByText("pnpm", { exact: true }).click();
  await expect(tab("pnpm")).toBeChecked();
  await expect(article.getByText("pnpm add acme")).toBeVisible();
  await expect(article.getByText("npm install acme")).toBeHidden();
  await visitor.keyboard.press("ArrowRight");
  await expect(tab("yarn")).toBeChecked();
  await expect(article.getByText("yarn add acme")).toBeVisible();
  // The config file under its name.
  await expect(article.getByRole("figure", { name: "acme.json" })).toContainText('{ "project": "acme" }');
  await checkpoint(visitor, "portal-article-code-tabs");

  // In Markdown, each tab under its label.
  const markdown = await (await visitor.request.get(`${portalUrl(slug)}/docs/installing-acme.md`)).text();
  expect(markdown).toContain("`npm`\n\n```\nnpm install acme\n```\n\n`pnpm`\n\n```\npnpm add acme\n```\n\n`yarn`\n\n```\nyarn add acme\n```");
  expect(markdown).toContain('`acme.json`\n\n```\n{ "project": "acme" }\n```');

  // The widget's help pane shows them the same way.
  await visitor.goto("/widget?tab=docs&article=installing-acme");
  await expect(visitor.getByRole("radio", { name: "npm", exact: true })).toBeChecked();
  await visitor.getByText("yarn", { exact: true }).click();
  await expect(visitor.getByText("yarn add acme")).toBeVisible();
  await expect(visitor.getByText("npm install acme")).toBeHidden();
  await checkpoint(visitor, "widget-article-code-tabs");
});
