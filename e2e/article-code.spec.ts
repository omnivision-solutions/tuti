import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

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

  /**
   * Waits for the editor's own cursor to be in the code (tab) with this text, at `at` (start, end or anywhere): it takes a
   * click a moment later, and a key pressed meanwhile would act where the cursor was.
   */
  const caretIn = (code: string, at: "start" | "end" | "any" = "any") =>
    expect
      .poll(() =>
        editor.evaluate((element, at) => {
          type Position = { parentOffset: number; parent: { textContent: string; content: { size: number } } };
          const { $from } = (element as unknown as { editor: { state: { selection: { $from: Position } } } }).editor.state.selection;
          const offset = at === "start" ? 0 : at === "end" ? $from.parent.content.size : $from.parentOffset;
          return $from.parentOffset === offset ? $from.parent.textContent : null;
        }, at),
      )
      .toBe(code);

  // Pasted code tabs keep their labels as save has them: trimmed. (Undone: the article starts from the / menu.)
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/html", '<div data-code-tabs=""><pre data-filename="  npm  "><code>npm i acme</code></pre><pre data-filename="pnpm"><code>pnpm add acme</code></pre></div>');
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.filename))).toEqual(["npm", "pnpm"]);
  await team.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("[data-code-tabs]")).toHaveCount(0);

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
  await caretIn("pnpm add acme");
  await team.keyboard.press("Home");
  await caretIn("pnpm add acme", "start");
  await team.keyboard.press("Backspace");
  await editor.getByText("npm install acme").click();
  await caretIn("npm install acme");
  await team.keyboard.press("End");
  await caretIn("npm install acme", "end");
  for (let i = 0; i < 3; i++) {
    await team.keyboard.press("Enter");
  }
  await expect
    .poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => tab.textContent)))
    .toEqual(["npm install acme", "pnpm add acme", "yarn add acme"]);
  // Shift+Enter is a new line in the tab, not a tab without a label.
  await editor.getByText("npm install acme").click();
  await caretIn("npm install acme");
  await team.keyboard.press("End");
  await caretIn("npm install acme", "end");
  await team.keyboard.press("Shift+Enter");
  await expect(editor.locator("[data-code-tabs] pre")).toHaveCount(3);
  await team.keyboard.press("Backspace");
  await expect
    .poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => [tab.dataset.filename, tab.textContent])))
    .toEqual([
      ["npm", "npm install acme"],
      ["pnpm", "pnpm add acme"],
      ["yarn", "yarn add acme"],
    ]);

  // With a selection running from one tab into the next, Rename tab shows and renames the first (saved unchanged,
  // every label stays as it was).
  await editor.evaluate((element) => {
    type Doc = { descendants: (visit: (node: { type: { name: string } }, pos: number) => void) => void };
    const { editor } = element as unknown as { editor: { state: { doc: Doc }; commands: { setTextSelection: (range: { from: number; to: number }) => boolean } } };
    const starts: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") {
        starts.push(pos + 1);
      }
    });
    editor.commands.setTextSelection({ from: starts[0]! + 2, to: starts[1]! + 2 });
  });
  await bar.getByRole("button", { name: "Rename tab" }).click();
  await expect(naming.getByRole("textbox")).toHaveValue("npm");
  await naming.getByRole("button", { name: "Save" }).click();
  await expect(naming).toBeHidden();
  // Back in the text (a frame later, putting its cursor back): a click before then would be undone.
  await expect(editor).toBeFocused();
  await expect
    .poll(() => editor.locator("[data-code-tabs] pre").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.filename)))
    .toEqual(["npm", "pnpm", "yarn"]);

  // Down from the end of the last tab leaves them. Removing one of two tabs leaves the other as a named code block,
  // which gets its own file name; one that isn't a single line is refused in the dialog.
  await editor.getByText("yarn add acme").click();
  await caretIn("yarn add acme");
  await team.keyboard.press("End");
  await caretIn("yarn add acme", "end");
  await team.keyboard.press("ArrowDown");
  await team.keyboard.type("/code tabs");
  await team.keyboard.press("Enter");
  await expect(editor.locator("[data-code-tabs]")).toHaveCount(2);
  await bar.getByRole("button", { name: "Remove tab" }).click();
  await expect(editor.locator("[data-code-tabs]")).toHaveCount(1);
  await expect(editor.locator('pre[data-filename="Tab 2"]')).toHaveCount(1);
  await team.keyboard.type('{ "project": "acme" }');
  await bar.getByRole("button", { name: "File name" }).click();
  await naming.getByRole("textbox").fill("acme\t.json");
  await naming.getByRole("button", { name: "Save" }).click();
  await expect(naming.getByText("A file name is one line of up to 80 characters.")).toBeVisible();
  await naming.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeFocused();
  await name("File name", "acme.json");
  await expect(editor.locator('pre[data-filename="acme.json"]')).toBeVisible();
  // A third Enter at the end of a tab opens a line right after the tabs, also when a block comes next.
  await editor.getByText("yarn add acme").click();
  await caretIn("yarn add acme");
  await team.keyboard.press("End");
  await caretIn("yarn add acme", "end");
  for (let i = 0; i < 3; i++) {
    await team.keyboard.press("Enter");
  }
  await team.keyboard.type("Then run it.");
  await expect(editor.locator('[data-code-tabs] + p + pre[data-filename="acme.json"]')).toHaveCount(1);
  await expect(editor.locator("[data-code-tabs] + p")).toHaveText("Then run it.");
  await checkpoint(team, "team-article-code-tabs-editor");

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/installing-acme`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  // Unpublish is behind "More actions", with Delete.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await team.keyboard.press("Escape");

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
  // Each block's Copy copies its code alone: the named one's in its strip, the tab shown's at its corner.
  await visitor.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await article.getByRole("figure", { name: "acme.json" }).getByRole("button", { name: "Copy code" }).click();
  await expect.poll(() => visitor.evaluate(() => navigator.clipboard.readText())).toBe('{ "project": "acme" }');
  await article.getByRole("button", { name: "Copy code" }).first().click();
  await expect.poll(() => visitor.evaluate(() => navigator.clipboard.readText())).toBe("yarn add acme");
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
