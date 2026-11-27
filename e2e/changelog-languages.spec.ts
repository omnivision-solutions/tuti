import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("the team writes a published entry's German from its editor's language pill, and its sidebar says where each language stands", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // German written by the team (Manual): nothing goes to the model.
  await api("/languages", { languages: [{ code: "de", newPages: "manual" }] }, "PATCH");
  await api("/changelog", { title: "Dark mode", body: "Switch themes from your profile menu." });
  await api("/changelog/1/publish", {});

  await team.setViewportSize({ width: 1280, height: 800 });
  await team.goto(`${APP_URL}/app/${slug}/changelog/1`);
  const languages = team.getByRole("region", { name: "Languages" });
  await expect(languages.getByRole("link", { name: /Deutsch/ })).toContainText("Not written");
  await checkpoint(team, "team-changelog-languages");

  // The pill: English, and Deutsch not written yet.
  await team.getByRole("button", { name: "Language: English" }).click();
  await expect(team.getByRole("menuitem", { name: /Deutsch/ })).toContainText("Not written");
  await team.getByRole("menuitem", { name: /Deutsch/ }).click();
  await expect(team).toHaveURL(/\?language=de$/);
  await expect(team.getByText("Not written yet: it starts as the English text.")).toBeVisible();
  // It starts as the English text, to write over.
  const title = team.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Dark mode");
  await title.fill("Dunkler Modus");
  await team.getByRole("textbox", { name: "What changed" }).fill("Wechsle das Design im Profilmenü.");
  await checkpoint(team, "team-changelog-version");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Saved", { exact: true })).toBeVisible();
  await expect(languages.getByRole("link", { name: /Deutsch/ })).toContainText("Written by your team");
  await expect(team.getByRole("switch", { name: /Keep up to date/ })).not.toBeChecked();

  // On a phone: the pill under the top bar, the text and its settings in one column, Save at the bottom.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.reload();
  await expect(team.getByRole("button", { name: "Language: Deutsch" })).toBeVisible();
  await expect(title).toHaveValue("Dunkler Modus");
  await checkpoint(team, "team-changelog-version-phone", { fullPage: false });
  // Back to English: its own editor, Deutsch in its sidebar.
  await team.getByRole("button", { name: "Language: Deutsch" }).click();
  await team.getByRole("menuitem", { name: /English/ }).click();
  await expect(team.getByRole("textbox", { name: "Title" })).toHaveValue("Dark mode");
  await expect(languages.getByRole("link", { name: /Deutsch/ })).toContainText("Written by your team");
  await checkpoint(team, "team-changelog-languages-phone");
});
