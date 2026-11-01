import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, fillSignUp, postFeedback, signUp } from "./helpers";

test("a portal post: the team's reply stands out, its status history and voters; signed out, the comment box asks to sign in and keeps what was written", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada posts, Bo votes for it.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await postFeedback(ada, "Offline mode");
  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests/dark-mode-1");
  await bo.getByRole("button", { name: "Upvote" }).click();
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");

  // The team answers and plans it.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByRole("textbox", { name: "Comment" }).fill("Thanks! We're on it.");
  await team.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(team.getByText("Thanks! We're on it.")).toBeVisible();
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();

  // Someone signed out opens it, at desktop and phone widths, light and dark.
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const visitor = await (await browser.newContext({ baseURL: portalUrl(slug), viewport, colorScheme })).newPage();
      await visitor.goto("/feedback/feature-requests/dark-mode-1");
      const activity = visitor.getByRole("region", { name: "Comments" });
      // The team's reply: "Team" by the name, on a tint.
      const reply = activity.getByRole("listitem").filter({ hasText: "Thanks! We're on it." });
      await expect(reply.getByText("Team", { exact: true })).toBeVisible();
      await expect(reply).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      // Its status history, after the reply: the change and when, not who made it.
      await expect(activity.getByRole("listitem").last()).toHaveText(/^Open → Planned · /);
      // Who wants it: their faces (Bo's, the latest, first) and how many.
      const voters = visitor.getByRole("group", { name: "Voters" });
      await expect(voters.locator('[data-slot="avatar"]')).toHaveText(["B", "A"]);
      await expect(voters.getByText("2 people want this", { exact: true })).toBeVisible();
      // The comment box is there.
      await expect(visitor.getByRole("textbox", { name: "Comment" })).toBeVisible();
      await expect(visitor.getByText("You'll sign in to post it.", { exact: true })).toBeVisible();
      // Nothing wider than the screen.
      expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await checkpoint(visitor, `portal-post-signed-out-${name}-${colorScheme}`);
      await visitor.context().close();
    }
  }

  // What's written is kept in this tab only: a tab opened afterwards starts with an empty box.
  const other = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await other.goto("/feedback/feature-requests/dark-mode-1");
  await expect(async () => {
    await other.getByRole("textbox", { name: "Comment" }).fill("Never mind");
    await expect(other.getByRole("textbox", { name: "Comment" })).toHaveText("Never mind", { timeout: 1000 });
  }).toPass();
  await other.getByRole("button", { name: "Comment", exact: true }).click();
  await other.waitForURL((url) => url.pathname === "/sign-in");
  const newTab = await other.context().newPage();
  await other.close();
  await newTab.goto("/feedback/feature-requests/dark-mode-1");
  await expect(newTab.getByRole("textbox", { name: "Comment" })).toBeVisible();
  await expect(newTab.getByRole("textbox", { name: "Comment" })).toHaveText("");
  await newTab.context().close();

  // Sending asks them to sign in, and what they wrote is back in the box after.
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  const box = visitor.getByRole("textbox", { name: "Comment" });
  // Typed once the page is ready for it (before then, the editor isn't there to take it).
  await expect(async () => {
    await box.fill("Me too, please!");
    await expect(box).toHaveText("Me too, please!", { timeout: 1000 });
  }).toPass();
  await visitor.getByRole("button", { name: "Comment", exact: true }).click();
  await visitor.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === "/feedback/feature-requests/dark-mode-1");
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await fillSignUp(visitor, "Cy", `e2e-${randomUUID()}@example.com`);
  await visitor.waitForURL("**/feedback/feature-requests/dark-mode-1");
  await expect(box).toHaveText("Me too, please!");
  await expect(visitor.getByText("You'll sign in to post it.")).toHaveCount(0);
  // Only in that post's box: not on another post's.
  await visitor.goto("/feedback/feature-requests/offline-mode-2");
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  await expect(box).toHaveText("Me too, please!");
  // Emptied, it's thrown away.
  await box.fill("");
  await visitor.reload();
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");

  // Never in the team's reply box, even in a tab where the app and the portal share storage.
  const postId = await team.locator('input[name="postId"]').first().inputValue();
  await team.evaluate(
    (key) => sessionStorage.setItem(key, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Never mind" }] }] })),
    `tuti:comment-draft:${postId}`,
  );
  await team.reload();
  await expect(team.getByRole("textbox", { name: "Comment" })).toBeVisible();
  await expect(team.getByRole("textbox", { name: "Comment" })).toHaveText("");

  // Written again and sent: posted, and not kept any more.
  await expect(async () => {
    await box.fill("Me too, please!");
    await expect(box).toHaveText("Me too, please!", { timeout: 1000 });
  }).toPass();
  await visitor.getByRole("button", { name: "Comment", exact: true }).click();
  const mine = visitor.getByRole("region", { name: "Comments" }).getByRole("listitem").filter({ hasText: "Me too, please!" });
  await expect(mine).toBeVisible();
  // Not the team's: no tint, no badge.
  await expect(mine).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(mine.getByText("Team", { exact: true })).toHaveCount(0);
  await expect(box).toHaveText("");
  await visitor.reload();
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");
  await checkpoint(visitor, "portal-post-commented");
});
