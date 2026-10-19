import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("people hear when what they asked for ships, and can unsubscribe", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada verifies her email on the portal and asks for something.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

  // The team ships it.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();

  const email = await latestEmailTo(ada.email);
  expect(email.subject).toBe("Done: Dark mode");
  expect(email.text).toContain(`${portalUrl(slug)}/p/dark-mode-1`);

  // The email's unsubscribe link asks first (link scanners open links), then stops Acme's emails.
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "Stop emails from Acme?" })).toBeVisible();
  await checkpoint(ada, "unsubscribe");
  await ada.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await checkpoint(ada, "unsubscribed");
});
