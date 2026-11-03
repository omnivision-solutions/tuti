import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { heldModelReply, nextModelReply, releaseModelReply } from "./model";

test("Verify checks an article against the repository: its history, and its fix approved on the article's review", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Your team ${id}`;
  const { slug: articleSlug } = await api("/articles", { title: article, body: "Each plan has 5 seats.\n\nPeople are admins or members." });
  await api(`/articles/${articleSlug}/publish`, {});
  // Its own repository: GitHub (the fake) is shared by every journey.
  const repo = `acme/verify-${id}`;
  await connectGithub(owner, slug, { repositories: [{ id: randomInt(1_000_000, 2_000_000_000), fullName: repo }] });
  const snapshot = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({ repo, commit: "c0ffee1234567", files: { "src/seats.ts": "export const SEATS_PER_PLAN = 10;", "docs/roles.md": "Roles: admin and member." } }),
  });
  expect(snapshot.ok).toBe(true);
  // The files it picks, then what it finds: seats out of date (fixed), roles still true.
  await nextModelReply(JSON.stringify({ files: ["src/seats.ts", "docs/roles.md"] }), article);
  await nextModelReply(
    JSON.stringify({
      statements: [
        { statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "SEATS_PER_PLAN is 10." },
        { statement: "People are admins or members", verdict: "current", evidence: ["docs/roles.md"], note: "Roles are admin and member." },
      ],
      reason: "Plans have 10 seats now, not 5.",
      sections: { "1": "Each plan has 10 seats.\n\nPeople are admins or members." },
    }),
    article,
  );

  // Verify is behind the editor's "More actions", beside History: a panel saying what it sends where.
  await owner.goto(`/app/${slug}/docs/${articleSlug}`);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("link", { name: "Verify" }).click();
  await owner.waitForURL(`**/app/${slug}/docs/${articleSlug}?verify`);
  const panel = owner.getByRole("dialog", { name: "Verify" });
  await expect(panel).toContainText("It sends the files it reads to");
  await checkpoint(owner, "verify-panel", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "verify-panel-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await panel.getByRole("button", { name: "Verify", exact: true }).click();
  const toast = owner.getByText("Verified: 1 out of date, its fix waits for you");
  await expect(toast).toBeVisible();

  // Its history: the commit, what it found (per statement, folded away), and its fix waiting.
  const run = panel.getByRole("region", { name: /^Checked / });
  await expect(run).toContainText(`${repo}@c0ffee1`);
  await expect(run).toContainText("1 statement still true · 1 out of date · 0 it can't tell");
  await expect(run).toContainText("Its fix waits for you");
  await expect(run.getByText("Each plan has 5 seats", { exact: true })).toBeHidden();
  await run.getByText("What it found").click();
  await expect(run.getByText("Each plan has 5 seats", { exact: true })).toBeVisible();
  await expect(run.getByText("src/seats.ts")).toBeVisible();
  // (Once the toast has gone, so the panel's title shows.)
  await expect(toast).toBeHidden({ timeout: 10_000 });
  await checkpoint(owner, "verify-history", { fullPage: false });
  // In dark, and on a phone.
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "verify-history-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "verify-history-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "verify-history-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Its fix on the article's review: a Verify chip, its part in its popover, approved like a pull request's edit.
  await run.getByRole("link", { name: "Review it" }).click();
  await owner.waitForURL(`**/app/${slug}/autopilot/articles/**`);
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: /^Verify: checked c0ffee1/ }).click();
  const part = owner.getByRole("dialog").filter({ hasText: "Its history" });
  await expect(part).toContainText("Plans have 10 seats now, not 5.");
  await expect(part).toContainText("Waits for you");
  await expect(part.getByRole("link", { name: "Its history" })).toHaveAttribute("href", `/app/${slug}/docs/${articleSlug}?verify`);
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("insertion").filter({ hasText: "Each plan has 10 seats." })).toBeVisible();
  await checkpoint(owner, "verify-review");
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "verify-review-dark");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "verify-review-phone-dark");
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "verify-review-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.getByRole("button", { name: "Approve and publish" }).click();
  await owner.getByRole("alertdialog", { name: `Publish “${article}”?` }).getByRole("button", { name: "Publish" }).click();
  await expect(owner.getByText("Published", { exact: true })).toBeVisible();

  const portal = await owner.context().newPage();
  await portal.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portal.getByText("Each plan has 10 seats.")).toBeVisible();
});

test("Verify all says what it will cost first, then shows its progress, opened again while it runs", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const [seats, billing] = [`Seats ${id}`, `Billing ${id}`];
  for (const title of [seats, billing]) {
    const { slug: articleSlug } = await api("/articles", { title, body: "Each plan has 5 seats." });
    await api(`/articles/${articleSlug}/publish`, {});
  }
  const repo = `acme/verify-all-${id}`;
  await connectGithub(owner, slug, { repositories: [{ id: randomInt(1_000_000, 2_000_000_000), fullName: repo }] });
  const snapshot = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({ repo, commit: "c0ffee1234567", files: { "src/seats.ts": "export const SEATS_PER_PLAN = 10;" } }),
  });
  expect(snapshot.ok).toBe(true);
  const pick = JSON.stringify({ files: ["src/seats.ts"] });
  const check = JSON.stringify({
    statements: [{ statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/seats.ts"], note: "SEATS_PER_PLAN is 10." }],
    reason: "Plans have 10 seats now, not 5.",
    sections: { "1": "Each plan has 10 seats." },
  });
  // The first article is checked at once; the second waits in the AI's answer till the journey has seen the progress.
  await nextModelReply(pick, seats);
  await nextModelReply(check, seats);
  await heldModelReply(pick, billing, `verify-all-${id}`);
  await nextModelReply(JSON.stringify({ statements: [{ statement: "Each plan has 5 seats", verdict: "current", evidence: ["src/seats.ts"], note: "" }], reason: "", sections: {} }), billing);

  // Docs' "More actions": Verify all, saying what it will cost before anything runs.
  await owner.goto(`/app/${slug}/docs`);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Verify all" }).click();
  const confirm = owner.getByRole("dialog", { name: "Verify all 2 published articles?" });
  await expect(confirm).toContainText("Articles verified at that commit and unchanged since are skipped.");
  // Credits are on (like Tuti's cloud): about 5 an article before the project has run any, of its 1,000 free.
  await expect(confirm).toContainText("It will cost up to about 10 AI credits: about 5 an article, what a typical article costs. You have 1,000.");
  await checkpoint(owner, "verify-all-confirm", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "verify-all-confirm-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "verify-all-confirm-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "verify-all-confirm-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await confirm.getByRole("button", { name: "Verify 2 articles" }).click();

  // Started, it shows how far it's got as it goes, keyboard focus on its Close (the button pressed is gone).
  const progress = owner.getByRole("dialog", { name: "Verifying all articles" });
  await expect(progress.locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Close" })).toBeFocused();
  await expect(progress).toContainText("Checked 1 of 2 articles.");
  await expect(progress.getByRole("progressbar", { name: "Articles checked" })).toHaveAttribute("aria-valuenow", "1");
  await checkpoint(owner, "verify-all-progress", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "verify-all-progress-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "verify-all-progress-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "verify-all-progress-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Opened again elsewhere while it runs: the one running, not a new start.
  const other = await owner.context().newPage();
  await other.goto(`/app/${slug}/docs`);
  await other.getByRole("button", { name: "More actions" }).click();
  await other.getByRole("button", { name: "Verify all" }).click();
  await expect(other.getByRole("dialog", { name: "Verifying all articles" })).toContainText("Checked 1 of 2 articles.");
  await releaseModelReply(`verify-all-${id}`);

  // Done: what it found, and its fix to review in Autopilot.
  const done = owner.getByRole("dialog", { name: "Verified all articles" });
  await expect(done).toContainText("Checked 2 of 2 articles: 1 article out of date, its fix waits for you.");
  await checkpoint(owner, "verify-all-done", { fullPage: false });
  // The open one catches up as it checks again.
  await expect(other.getByRole("dialog", { name: "Verified all articles" })).toBeVisible();
  await done.getByRole("link", { name: "Review in Autopilot" }).click();
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await expect(owner.getByText(seats).first()).toBeVisible();
});
