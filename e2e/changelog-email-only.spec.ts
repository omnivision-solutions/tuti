import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo } from "./mail";

test("an email-only entry: the team marks it in the editor, it's emailed to subscribers in full and listed nowhere on the portal", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const kim = `e2e-${randomUUID()}@example.com`;
  await api("/changelog-subscribers", { emails: [kim] });
  await api("/changelog", { title: "Pricing change", body: "Plans cost less from May." });

  // In the editor's "Who sees it": Email only, saved.
  await team.goto(`/app/${slug}/changelog/1`);
  const whoSees = team.getByRole("group", { name: "Who sees it" });
  await whoSees.getByRole("checkbox", { name: "Email only" }).check();
  await expect(whoSees.getByRole("checkbox", { name: "Email only" })).toHaveAccessibleDescription("Emailed to subscribers and listed nowhere. Its page is your team's only.");
  // Not saved yet: Publish waits.
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Save who sees it before publishing" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await checkpoint(team, "editor-email-only");
  await team.reload();
  await expect(team.getByRole("group", { name: "Who sees it" }).getByRole("checkbox", { name: "Email only" })).toBeChecked();
  await team.getByRole("button", { name: "Publish" }).click();
  await expect(dialog).toContainText("It's listed nowhere, and sends 1 email.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();

  // Kim gets it in full, with no link to a page.
  const email = await latestEmailTo(kim, { subject: /^Acme: Pricing change$/ });
  expect(email.text).toContain("Plans cost less from May.");
  expect(email.text).not.toContain("/changelog/1");

  // A visitor finds it nowhere: not on the changelog, nor at its address.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();
  await visitor.goto("/changelog/1");
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
