import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { asPreviousRelease, markOutOfDate } from "./autopilot";
import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextModelReply } from "./model";
import { similar } from "./openai";

test("eight pull requests' edits on an article in a collection: the list's tree; three chips, then the rest under +5 more; an out-of-date one is marked; one dismissed from its chip", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Find your way around ${id}`;
  const before = "The sidebar lists Feedback and Docs.";
  await api("/collections", { name: "Billing", icon: "credit-card" });
  const { slug: articleSlug } = await api("/articles", { title: article, body: before, collection: "billing" });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);

  // Each pull request edits the article; from the second on, Autopilot asks whether to Verify it (no).
  const numbers = Array.from({ length: 8 }, (_, i) => randomInt(i * 100_000 + 1_000, (i + 1) * 100_000));
  for (const [i, number] of numbers.entries()) {
    const pr = `Sidebar ${i + 1} ${id}`;
    const summary = `The sidebar changed (${i + 1}, ${id}).`;
    await similar(summary, `${article}\n\n${before}`, 0.9);
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
    await nextModelReply(summary, pr);
    await nextDecision({ effect: { wrong: 0.87, missing: 0.05, unaffected: 0.08 } }, `"article":{"title":"${article}"`);
    await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
    await nextModelReply(JSON.stringify({ reason: `The sidebar list misses item ${i + 1}.`, sections: { "1": `The sidebar lists Feedback, Docs and ${i + 1} more.` } }), article);
    await nextModelReply(JSON.stringify({ why: "", changelog: "Sidebar", proposals: {} }), summary);
    if (i > 0) {
      await nextDecision({ verify: 0.1 }, `"article":"${article}","pull_requests_edits_waiting":${i + 1},`);
    }
    await mergePullRequest(installationId, { number, title: pr });
  }
  // The first one's edit was written on an earlier version of the article.
  await markOutOfDate(slug, numbers[0]!);

  // Autopilot's list, a tree: Help center → its collection (its icon) → the article, its badge at the end.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await expect(list.getByRole("region", { name: "Help center" }).getByRole("list", { name: "Billing" }).getByRole("listitem")).toContainText(article);
  await expect(list.getByRole("list", { name: "Billing" }).getByRole("listitem")).toContainText("Updated");
  await checkpoint(owner, "tree-list", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "tree-phone", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "tree-phone-dark", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Its review: the latest merged first, three chips, then "+5 more", whose dot says one it hides is out of date.
  await list.getByRole("link", { name: article }).click();
  await expect(list.getByRole("link", { name: article })).toHaveAttribute("aria-current", "page");
  await checkpoint(owner, "tree-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "tree", { fullPage: false });
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  const chips = owner.getByRole("list", { name: "Pull requests" });
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveText(numbers.slice(5).reverse().map((number) => `PR #${number}`));
  const more = chips.getByRole("button", { name: "+5 more, 1 out of date" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // Each pull request's part is in its chip's popover, not listed under what changed.
  await expect(owner.getByRole("button", { name: "Write it again" })).toHaveCount(0);
  await checkpoint(owner, "chips-collapsed", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chips-collapsed-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "chips-collapsed-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chips-collapsed-phone", { fullPage: false });

  // From the keyboard: "+5 more" shows the rest.
  await more.focus();
  await owner.keyboard.press("Enter");
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveCount(8);
  // Focus on the first of those shown (they're before the toggle).
  await expect(chips.getByRole("button", { name: /^PR #/ }).nth(3)).toBeFocused();
  await expect(chips.getByRole("button", { name: "Fewer" })).toHaveAttribute("aria-expanded", "true");
  await checkpoint(owner, "chips-expanded-phone", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chips-expanded-phone-dark", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await checkpoint(owner, "chips-expanded-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chips-expanded", { fullPage: false });

  // The out-of-date one says so; its popover has why, what became of it, Write it again and Dismiss.
  const stale = chips.getByRole("button", { name: `PR #${numbers[0]}, out of date: Sidebar 1 ${id}` });
  await stale.click();
  const part = owner.getByRole("dialog").filter({ hasText: `Sidebar 1 ${id}` });
  await expect(part).toContainText("The sidebar list misses item 1.");
  await expect(part).toContainText("Out of date: the article changed since it was written");
  await expect(part.getByRole("button", { name: "Write it again" })).toBeVisible();
  await checkpoint(owner, "chip-out-of-date", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chip-out-of-date-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "chip-out-of-date-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chip-out-of-date-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.keyboard.press("Escape");

  // The newest one dismissed from its popover (an earlier one can't be: a later edit changed the same section): focus
  // is on the chip row. Its chip stays, last now (nothing of it waits), to see what became of it.
  const newest = chips.getByRole("button", { name: `PR #${numbers[7]}: Sidebar 8 ${id}` });
  await newest.click();
  await owner.getByRole("dialog").filter({ hasText: `Sidebar 8 ${id}` }).getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(chips).toBeFocused();
  await expect(chips.getByRole("button", { name: /^PR #/ }).last()).toHaveAccessibleName(`PR #${numbers[7]}: Sidebar 8 ${id}`);
  await newest.click();
  await expect(owner.getByRole("dialog").filter({ hasText: `Sidebar 8 ${id}` })).toContainText("Dismissed by Olive Owner");
  await owner.keyboard.press("Escape");
  // "Fewer" hides them again.
  await chips.getByRole("button", { name: "Fewer" }).click();
  await expect(chips.getByRole("button", { name: "+5 more, 1 out of date" })).toHaveAttribute("aria-expanded", "false");
});

test("an article whose only edit the previous release wrote: its review says there's nothing to show yet and why, and dismisses it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Change the theme ${id}`;
  const before = "Pick Light in Settings.";
  const { slug: articleSlug } = await api("/articles", { title: article, body: before });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme (${id}).`;
  await similar(summary, `${article}\n\n${before}`, 0.9);
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextModelReply(summary, pr);
  await nextDecision({ effect: { wrong: 0.87, missing: 0.05, unaffected: 0.08 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light or Dark in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), summary);
  await mergePullRequest(installationId, { number, title: pr });
  await asPreviousRelease(slug, number);

  // Still to review, but nothing of it shows: the page says why, with what to do.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  const notice = owner.getByText(/^Nothing to show yet: its edit was written on an earlier version of the article/);
  await expect(notice).toBeVisible();
  await expect(owner.getByRole("button", { name: "Write it again" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
  await checkpoint(owner, "nothing-to-show-yet", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "nothing-to-show-yet-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });

  // Dismissed: nothing's left to review.
  await owner.getByRole("button", { name: "Dismiss it" }).click();
  await expect(owner.getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 0" })).toBeVisible();
});
