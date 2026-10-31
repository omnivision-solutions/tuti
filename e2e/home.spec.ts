import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("Home: the numbers open their lists, what needs the team has its action, and Get set up says what's left", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  // One already planned: new this week too, though not waiting for triage.
  await api("/posts", { board: "feature-requests", title: "Exports" });
  await api("/posts/2", { status: "planned" }, "PATCH");

  await owner.goto(`/app/${slug}`);
  // The post waits for triage, with its action.
  const attention = owner.getByRole("listitem").filter({ hasText: "Dark mode" }).filter({ hasText: "New post" });
  await expect(attention).toContainText("New post");
  await expect(attention.getByRole("link", { name: "Triage" })).toHaveAttribute("href", `/app/${slug}/p/1`);
  // Get set up: what's left, each a link to do it.
  const setup = owner.getByRole("list", { name: "Get set up" });
  await expect(setup.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
  await expect(setup.getByRole("link", { name: "Publish an article" })).toBeVisible();
  await checkpoint(owner, "home");
  // A number opens its list: every post, newest first.
  await owner.getByRole("link", { name: /^2\s*New posts this week$/ }).click();
  await owner.waitForURL(`**/app/${slug}/feedback?status=all&sort=new`);
  await expect(owner.getByRole("main").getByRole("listitem").getByRole("link", { name: /^(Dark mode|Exports)$/ })).toHaveText(["Exports", "Dark mode"]);
});
