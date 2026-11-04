import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { articleContent, setArticleContent } from "./articles";
import { linkPullRequest, setEntryContent } from "./changelog-dates";
import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
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
      await expect(editor).toHaveAttribute("aria-readonly", "true");
      await expect(editor).toHaveAccessibleDescription(/Reload the page to edit it/);
      // Still reached with Tab from the title, so it can be read (and its note heard).
      await team.getByLabel("Title").focus();
      await team.keyboard.press("Tab");
      await expect(editor).toBeFocused();
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

test("a changelog entry with something this editor doesn't know offers no AI rewrite of it", async ({ browser }) => {
  test.setTimeout(90_000);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  await team.goto(`/app/${slug}/changelog`);
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Dark mode");
  await team.getByRole("textbox", { name: "What changed" }).click();
  await team.keyboard.type("It's here.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);
  await expect(team.getByRole("button", { name: "Edit with AI" })).toBeVisible();

  await setEntryContent(slug, 1, {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "It's here." }] }, { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "Try it" }] }] }],
  });
  await team.reload();
  const text = team.getByRole("textbox", { name: "What changed" });
  await expect(text).toHaveText("It's here.");
  await expect(text).toHaveAttribute("aria-readonly", "true");
  // Edit with AI (Shorten, Rewrite this section, Draft with AI) would rewrite it without what it can't show.
  await expect(team.getByRole("button", { name: "Edit with AI" })).toHaveCount(0);

  // Readable again (a newer release saved it): once the form remounts with it (here after publishing, no reload), the text
  // is editable and AI is back.
  await setEntryContent(slug, 1, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "It's here, everywhere." }] }] });
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(text).toHaveText("It's here, everywhere.");
  await expect(text).toHaveAttribute("contenteditable", "true");
  await expect(team.getByRole("button", { name: "Edit with AI" })).toBeVisible();

  // An entry still only its pull requests' titles leads with Draft with AI, which this text locks too.
  await team.goto(`/app/${slug}/changelog`);
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Faster search");
  await team.getByRole("textbox", { name: "What changed" }).click();
  await team.keyboard.type("Soon.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/2`);
  await linkPullRequest(slug, 2, { repo: "acme/app", number: 7, title: "Faster search" });
  const bullet = { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Faster search (acme/app#7)" }] }] };
  await setEntryContent(slug, 2, { type: "doc", content: [{ type: "bulletList", attrs: { marker: "dash" }, content: [bullet] }] });
  await team.reload();
  await expect(team.getByRole("button", { name: "Draft with AI" })).toBeDisabled();
});

test("a portal comment draft this release can't read is left as it is, not restored and saved over", async ({ browser }) => {
  test.setTimeout(90_000);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "Submit post" }).click();
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit post" }).click();
  await ada.getByRole("link", { name: "Dark mode" }).click();
  const box = ada.getByRole("textbox", { name: "Comment" });
  await box.click();
  await ada.keyboard.type("Draft");
  const key = await ada.evaluate(() => Object.keys(sessionStorage).find((name) => name.startsWith("tuti:comment-draft:")));
  expect(key).toBeTruthy();

  // As a newer release's tab would have left it: a mark this one doesn't have.
  const newer = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Love it", marks: [{ type: "highlight" }] }] }] });
  await ada.evaluate(([name, value]) => sessionStorage.setItem(name!, value!), [key, newer]);
  await ada.reload();
  await expect(box).toBeVisible();
  await box.click();
  await ada.keyboard.type("Looks good");
  expect(await ada.evaluate((name) => sessionStorage.getItem(name!), key)).toBe(newer);
  // Posting a comment doesn't take it either: it isn't what was sent.
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  // Posted: the box is made again, empty (its draft clear has run by then).
  await expect(box).toHaveText("");
  await expect(ada.getByText("Looks good")).toBeVisible();
  expect(await ada.evaluate((name) => sessionStorage.getItem(name!), key)).toBe(newer);
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
