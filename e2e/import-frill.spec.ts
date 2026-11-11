import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import { FAKE_FRILL_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { signUp } from "./helpers";

test("in the first run the team comes from Frill: a bad key is refused, a good one brings its users, ideas (onto a Public board, as picked) and announcements across, bugs kept private", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: Frill, with its key and what it has to bring (no team, help center or inbox).
  await owner.waitForURL(`**/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Frill/ }).check();
  await expect(owner.getByText("Bring your users, ideas and announcements across with an API key.")).toBeVisible();
  await expect(owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ })).toHaveAttribute("href", "https://app.frill.co/settings/company");
  await expect(owner.getByText("In Frill, Settings → Company. It's kept only while the import runs.")).toBeVisible();
  await expect(owner.getByRole("checkbox", { name: /^Team/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Help center/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Inbox/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await expect(owner.getByText(/Bugs come as Private/)).toBeVisible();
  // Frill can't say which ideas were private: asked, a Private board to begin with.
  const where = owner.getByRole("radiogroup", { name: "Ideas from Frill" });
  await expect(where).toHaveAccessibleDescription("Frill doesn't tell Tuti which ideas only some people could see, so a Public board could show private ones.");
  await expect(where.getByRole("radio", { name: /^On a Private board/ })).toBeChecked();
  await where.getByRole("radio", { name: /^On a Public board/ }).check();
  await owner.getByRole("checkbox", { name: /^Changelog/ }).check();
  await checkpoint(owner, "setup-frill");

  const key = owner.getByRole("textbox", { name: "API key" });
  await key.fill("not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Frill didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();

  await key.fill(FAKE_FRILL_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Frill" });
  await expect(status).toContainText(
    "Imported from Frill. 3 contacts, 1 board, 6 posts, 9 votes, 2 comments, 1 note, 2 images, 3 changelog entries, 1 image in the changelog, 1 profile picture brought across.",
    { timeout: 30_000 },
  );
  await expect(status).toContainText("1 post waiting for moderation");
  await checkpoint(owner, "setup-frill-imported");

  // On the portal: the idea with its details, image, date, votes and comment; never the note, nor the private ideas.
  const visitor = await browser.newPage({ baseURL: portalUrl(slug) });
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  const post = visitor.getByRole("article");
  await expect(post.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(post.getByText("Night owls need it.")).toBeVisible();
  await expect(post.locator("figure img")).toHaveCount(1);
  await expect(post.locator('time[datetime="2024-01-10T08:00:00.000Z"]')).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Upvote (3 votes), sign in to vote" })).toBeVisible();
  await expect(visitor.getByRole("region", { name: "Comments" }).getByText("Yes please!")).toBeVisible();
  await expect(visitor.getByText("Planning it for June.")).toHaveCount(0);
  await checkpoint(visitor, "portal-frill-post");
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.getByText("CSV export")).toBeVisible();
  await expect(visitor.getByText("Secret plan")).toHaveCount(0);
  await expect(visitor.getByText("Crash on login")).toHaveCount(0);

  // The changelog: published announcements at their dates, the draft not on the portal.
  await visitor.goto("/changelog");
  await expect(visitor.getByRole("heading", { name: "Dark mode is here" })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Faster exports" })).toBeVisible();
  await expect(visitor.getByText("Single sign-on")).toHaveCount(0);
  await checkpoint(visitor, "portal-frill-changelog");

  // In the app: the team's note on the idea.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByText("Planning it for June.")).toBeVisible();
  await expect(owner.getByRole("region", { name: "Comments" }).getByRole("listitem").getByText("Internal note", { exact: true })).toBeVisible();
});
