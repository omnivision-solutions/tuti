import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, postFeedback, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("people hear when what they asked for ships, and can unsubscribe", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada verifies her email on the portal and asks for something.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");

  // The team ships it, told first who that emails.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask).toContainText("This emails up to 1 person who asked for it that it shipped.");
  await checkpoint(team, "team-post-complete-asks");
  await ask.getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();

  const email = await latestEmailTo(ada.email);
  expect(email.subject).toBe("Done: Dark mode");
  expect(email.text).toContain(`${portalUrl(slug)}/feedback/feature-requests/dark-mode-1`);

  // The email's unsubscribe link asks first (link scanners open links), then stops Acme's emails.
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "Stop emails from Acme?" })).toBeVisible();
  await checkpoint(ada, "unsubscribe");
  await ada.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await checkpoint(ada, "unsubscribed");
});
