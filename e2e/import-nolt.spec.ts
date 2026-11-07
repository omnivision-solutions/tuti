import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_NOLT_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { signUp } from "./helpers";

test("in the first run the team comes from Nolt: a bad key is refused, a good one brings its users and feedback, the board turned off till the team turns it on", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: Nolt, with its key and what it has to bring (no team, changelog, help center or inbox).
  await owner.waitForURL(`**/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Nolt/ }).check();
  await expect(owner.getByText("Bring your users and feedback across with an API key.")).toBeVisible();
  await expect(owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ })).toHaveAttribute("href", "https://nolt.io/docs/publicapi/authentication/");
  await expect(owner.getByText("In Nolt, your board's Settings → APIs. It's kept only while the import runs.")).toBeVisible();
  for (const part of ["Team", "Changelog", "Help center", "Inbox"]) {
    await expect(owner.getByRole("checkbox", { name: new RegExp(`^${part}`) })).toHaveCount(0);
  }
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await expect(owner.getByText(/It comes turned off \(seen only by your team\), as Nolt's API doesn't say who can see it: turn it on in Feedback → Boards once you've checked\./)).toBeVisible();
  await checkpoint(owner, "setup-nolt");

  const key = owner.getByRole("textbox", { name: "API key" });
  await key.fill("not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Nolt didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();

  await key.fill(FAKE_NOLT_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Nolt" });
  await expect(status).toContainText("Imported from Nolt. 3 contacts, 1 board, 4 posts, 6 votes, 3 comments, 2 images, 1 profile picture brought across.", { timeout: 30_000 });
  await expect(status).toContainText("1 post waiting for moderation");
  await checkpoint(owner, "setup-nolt-imported");

  // In the app: the post with its text and comments.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(owner.getByText("Night owls need it.")).toBeVisible();
  await expect(owner.getByText("Yes please!")).toBeVisible();
  await checkpoint(owner, "app-nolt-post");

  // On the portal: a visitor sees none of it while the board is off.
  const visitor = await browser.newPage({ baseURL: portalUrl(slug) });
  await visitor.goto("/feedback/acme-feedback/dark-mode-1");
  await expect(visitor.getByRole("heading", { name: "Dark mode" })).toHaveCount(0);

  // The team turns it on once they've checked: everyone sees its posts.
  await owner.goto(`/app/${slug}/feedback/boards`);
  await owner.getByRole("button", { name: "Turn on" }).click();
  await expect(owner.getByText("Acme Feedback is on the portal")).toBeVisible();
  await visitor.goto("/feedback/acme-feedback/dark-mode-1");
  const post = visitor.getByRole("article");
  await expect(post.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(post.getByText("Night owls need it.")).toBeVisible();
  await expect(visitor.getByRole("region", { name: "Comments" }).getByText("Yes please!")).toBeVisible();
  await checkpoint(visitor, "portal-nolt-post");
});
