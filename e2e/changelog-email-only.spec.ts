import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { emailsTo, latestEmailTo } from "./mail";

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

  // In the editor's Published in: all three on for a draft; the changelog list off, saved, makes it email only.
  await team.goto(`/app/${slug}/changelog/1`);
  const goesTo = team.getByRole("group", { name: "Published in" });
  const list = goesTo.getByRole("switch", { name: "Changelog list" });
  const popup = goesTo.getByRole("switch", { name: "Widget" });
  const email = goesTo.getByRole("switch", { name: "Email" });
  for (const each of [list, popup, email]) {
    await expect(each).toBeChecked();
  }
  await expect(email).toHaveAccessibleDescription("1 subscriber");
  await checkpoint(team, "editor-goes-to");
  await list.uncheck();
  // The popup needs the list: off and disabled, saying so.
  await expect(popup).not.toBeChecked();
  await expect(popup).toBeDisabled();
  await expect(popup).toHaveAccessibleDescription("Needs the changelog list");
  await expect(email).toBeChecked();
  // Not saved yet: Publish waits.
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Save before publishing" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await checkpoint(team, "editor-email-only");
  await team.reload();
  await expect(list).not.toBeChecked();
  await expect(popup).toBeDisabled();
  await team.getByRole("button", { name: "Publish" }).click();
  await expect(dialog).toContainText("It's listed nowhere, and sends 1 email.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  // In no widget, so not announced (marked new), though the popup was on by default.
  expect(((await api("/changelog/1", undefined, "GET")) as unknown as { announced: boolean }).announced).toBe(false);

  // Kim gets it in full, with no link to a page.
  const received = await latestEmailTo(kim, { subject: /^Acme: Pricing change$/ });
  expect(received.text).toContain("Plans cost less from May.");
  expect(received.text).not.toContain("/changelog/1");

  // A visitor finds it nowhere: not on the changelog, nor at its address.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();
  await visitor.goto("/changelog/1");
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();

  // Published: Published in says what happened, nothing to change but the list.
  await team.reload();
  await expect(email).toBeChecked();
  await expect(email).toBeDisabled();
  await expect(email).toHaveAccessibleDescription("Sent to 1 subscriber");
});

test("an owner publishes a release note without email: Email off, no subscriber is emailed, and the popup turned off and on comes back as it was", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const kim = `e2e-${randomUUID()}@example.com`;
  await api("/changelog-subscribers", { emails: [kim] });
  await api("/changelog", { title: "Quiet fix", body: "Exports keep their dates." });
  await team.goto(`/app/${slug}/changelog/1`);
  const goesTo = team.getByRole("group", { name: "Published in" });
  const list = goesTo.getByRole("switch", { name: "Changelog list" });
  const popup = goesTo.getByRole("switch", { name: "Widget" });
  const email = goesTo.getByRole("switch", { name: "Email" });
  // The list off and on again: the popup is back on, as it was.
  await list.uncheck();
  await expect(popup).not.toBeChecked();
  await list.check();
  await expect(popup).toBeChecked();
  await expect(popup).toBeEnabled();
  await email.uncheck();
  await checkpoint(team, "editor-no-email");
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog).toContainText("It goes on your portal and in your widget.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  expect(((await api("/changelog/1", undefined, "GET")) as unknown as { announced: boolean }).announced).toBe(true);
  // Nobody emailed: the sidebar says so, and Kim has only the next entry's, published with email after it.
  await team.reload();
  await expect(email).not.toBeChecked();
  await expect(email).toHaveAccessibleDescription("Published without it");
  await api("/changelog", { title: "Loud fix", body: "Imports keep their dates." });
  await api("/changelog/2/publish", { emailSubscribers: true });
  await latestEmailTo(kim, { subject: /^Acme: Loud fix$/ });
  expect(emailsTo(kim).map((each) => each.subject)).not.toContain("Acme: Quiet fix");
});
