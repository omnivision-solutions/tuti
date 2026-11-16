import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, postFeedback, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("people hear when what they asked for is started and when it ships, and can unsubscribe", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada verifies her email on the portal and asks for something.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");

  // The team plans it, told first who that emails.
  await team.goto(`/app/${slug}/p/1`);
  const status = team.getByLabel("Status", { exact: true });
  await status.click();
  await team.getByRole("option", { name: "Planned" }).click();
  const plan = team.getByRole("alertdialog", { name: "Mark “Dark mode” planned?" });
  await expect(plan).toContainText("This emails up to 1 person who asked for it that it's planned.");
  await checkpoint(team, "team-post-plan-asks", { fullPage: false });
  await plan.getByRole("button", { name: "Mark planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();
  await latestEmailTo(ada.email, { subject: /^Planned:/ });
  // Moved back, it emails nobody: no asking.
  await status.click();
  await team.getByRole("option", { name: "Open" }).click();
  await expect(team.getByText("Status: Open")).toBeVisible();
  await expect(team.getByRole("alertdialog")).toHaveCount(0);

  // The team starts on it, told first again: Ada hears that too.
  await status.click();
  await team.getByRole("option", { name: "In progress" }).click();
  const start = team.getByRole("alertdialog", { name: "Mark “Dark mode” in progress?" });
  await expect(start).toContainText("This emails up to 1 person who asked for it that it's in progress.");
  await start.getByRole("button", { name: "Mark in progress" }).click();
  await expect(team.getByText("Status: In progress")).toBeVisible();
  const started = await latestEmailTo(ada.email, { subject: /^In progress:/ });
  expect(started.subject).toBe("In progress: Dark mode");
  expect(started.text).toContain("The team has started building it. We'll email you again when it ships.");

  // The team ships it, told first who that emails.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status", { exact: true }).click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask).toContainText("This emails up to 1 person who asked for it that it shipped.");
  await checkpoint(team, "team-post-complete-asks");
  await ask.getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();

  const email = await latestEmailTo(ada.email, { subject: /^Done:/ });
  expect(email.subject).toBe("Done: Dark mode");
  expect(email.text).toContain(`${portalUrl(slug)}/feedback/feature-requests/dark-mode-1`);
  // Acme's email: its name at the top, Tuti's credit at the end, linking to Tuti's site.
  const mail = await (await browser.newContext()).newPage();
  await mail.setContent(email.html);
  await expect(mail.getByText("Acme", { exact: true })).toBeVisible();
  // The post's card: its votes, board, title and the portal's Completed pill.
  await expect(mail.getByRole("heading", { name: "Dark mode is done" })).toBeVisible();
  expect(email.text.replace(/\s+/g, " ")).toContain("1 vote Feature requests Dark mode Completed");
  await expect(mail.getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://tuti.so/?utm_source=email&utm_medium=powered_by&utm_campaign=badge");
  await checkpoint(mail, "shipped-email");

  // The email's unsubscribe link asks first (link scanners open links), then stops Acme's emails.
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "Stop emails from Acme?" })).toBeVisible();
  // It says all the emails it stops: post updates and replies, and the changelog.
  await expect(ada.getByText("You'll stop getting Acme's emails: news and replies on posts you follow, wrote, voted or commented on, and its changelog.")).toBeVisible();
  await checkpoint(ada, "unsubscribe");
  await ada.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await checkpoint(ada, "unsubscribed");
});
