import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";

test("the team asks AI to rewrite part of a changelog entry, sees its version in place, accepts it and saves; undo takes it back", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Asha Ask");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const marker = randomUUID().slice(0, 8);
  await api("/changelog", { title: "Faster exports", body: `Exports are quick now (${marker}).\n\nThey run in the background and email you when they're done.` });

  await team.goto(`/app/${slug}/changelog/1`);
  const text = team.getByRole("textbox", { name: "What changed" });
  // The second line, selected from the keyboard.
  await text.getByText("They run in the background").click();
  await team.keyboard.press("Home");
  await team.keyboard.press("Shift+End");
  await team.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Ask AI" }).click();
  const dialog = team.getByRole("dialog", { name: "Ask AI" });
  await expect(dialog.getByRole("group", { name: "Presets" }).getByRole("button")).toHaveText(["Shorter", "Clearer", "Friendlier", "Fix grammar", "For non-developers", "Make a list"]);
  await checkpoint(team, "ask-ai-dialog", { fullPage: false });

  await nextModelReply(JSON.stringify({ notes: "Exports run quietly and email you when done." }), marker);
  await dialog.getByRole("button", { name: "Shorter" }).click();
  await expect(dialog).toBeHidden();
  // The AI's version under the old text, which is struck through: nothing changed yet.
  const version = team.getByRole("group", { name: "The AI's version" });
  await expect(version).toContainText("Exports run quietly and email you when done.");
  await expect(text.locator('[data-ask-ai="old"]')).toHaveText("They run in the background and email you when they're done.");
  await checkpoint(team, "ask-ai-version-in-place", { fullPage: false });
  // It got the selected line to edit, and the whole entry for context, as the instruction asks.
  const request = (await modelRequests()).findLast((each) => each.user.includes(marker))!;
  expect(request.user).toMatch(/^Edit this text as the team's instruction says/);
  expect(request.user).toContain('"textToEdit": "They run in the background and email you when they\'re done."');
  expect(request.user).toContain('"teamInstruction": "Make it shorter, keeping every change it mentions."');

  await version.getByRole("button", { name: "Accept" }).click();
  await expect(version).toBeHidden();
  await expect(text).toContainText(`Exports are quick now (${marker}).`);
  await expect(text).toContainText("Exports run quietly and email you when done.");
  await expect(text).not.toContainText("in the background");
  // An edit like any other: undo takes it back, redo puts it in again.
  await team.keyboard.press("ControlOrMeta+z");
  await expect(text).toContainText("They run in the background");
  await team.keyboard.press("ControlOrMeta+Shift+z");
  await expect(text).toContainText("Exports run quietly");

  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  await team.reload();
  await expect(text).toContainText("Exports run quietly and email you when done.");
  await expect(text).not.toContainText("in the background");
});
