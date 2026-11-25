import { createHmac, randomInt } from "node:crypto";

import { expect } from "@playwright/test";
import { FAKE_GITHUB_WEBHOOK_SECRET } from "@tuti/testkit";

import { APP_URL } from "./env";
import type { TestPage } from "./helpers";

/**
 * Connects the project to GitHub from its settings, as `admin`, and adds `add` (by default every
 * listed repository, by its full name) to it; returns the installation's id. A new installation on "acme" by
 * default, with one repository, acme/app, whose id is the installation's.
 */
export async function connectGithub(
  admin: TestPage,
  slug: string,
  installation: { id?: number; account?: string; repositories?: { id: number; fullName: string }[]; add?: string[] } = {},
): Promise<number> {
  const id = installation.id ?? randomInt(1_000_000, 2_000_000_000);
  const repositories = installation.repositories ?? [{ id, fullName: "acme/app" }];
  await nextInstall(admin, { id, account: installation.account ?? "acme", repositories });
  await admin.goto(`/app/${slug}/settings/integrations`);
  // GitHub (the fake) says which accounts they have the app on; they pick this one.
  await admin.getByRole("link", { name: "Connect GitHub" }).click();
  await admin.waitForURL(`**/app/${slug}/settings/integrations?github=choose`);
  await admin.getByRole("link", { name: `Connect @${installation.account ?? "acme"}` }).click();
  await admin.waitForURL(`**/app/${slug}/settings/integrations/github?github=connected`);
  for (const name of installation.add ?? repositories.map((repo) => repo.fullName)) {
    await admin.getByRole("button", { name: "Add repository" }).click();
    await admin.getByRole("list", { name: "Repositories to add" }).getByRole("button", { name, exact: true }).click();
    await expect(admin.getByRole("list", { name: "This project's repositories" }).getByText(name, { exact: true })).toBeVisible();
    // The list shows it at once; the toast says it's saved (so a merge right after reaches the project).
    await expect(admin.getByText(`${name} added`)).toBeVisible();
  }
  return id;
}

/** The installation GitHub (the fake) offers `admin` next, as the only account they have the app on. */
export async function nextInstall(admin: TestPage, installation: { id: number; account: string; repositories: { id: number; fullName: string }[] }) {
  const response = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/next-install`, {
    method: "POST",
    body: JSON.stringify({ forwardedFor: admin.ip, setupUrl: `${APP_URL}/api/github/setup`, ...installation, code: `code-${installation.id}` }),
  });
  expect(response.ok).toBe(true);
}

/**
 * A pull request on acme/app (as connectGithub set it up; or `repo`, whose id is the installation's too) merging into
 * `base` (main): GitHub (the fake) has it for the App to read, and Tuti gets the signed webhook delivery.
 */
export async function mergePullRequest(
  installationId: number,
  { repo = "acme/app", base = "main", ...pr }: { number: number; title: string; body?: string; files?: { filename: string; patch?: string }[]; repo?: string; base?: string },
) {
  const fake = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/pull-request`, {
    method: "POST",
    // Its merge commit's archive, as GitHub has one, so Autopilot reads the code (and checks its edits against it).
    body: JSON.stringify({ repo, author: "octo", mergedAt: new Date().toISOString(), archived: true, ...pr }),
  });
  expect(fake.ok).toBe(true);
  const body = JSON.stringify({
    action: "closed",
    installation: { id: installationId },
    repository: { id: installationId, full_name: repo },
    pull_request: {
      base: { ref: base },
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      html_url: `https://github.com/${repo}/pull/${pr.number}`,
      merged: true,
      merged_at: new Date().toISOString(),
      user: { login: "octo" },
      labels: [],
    },
  });
  await deliver("pull_request", body);
}

/** A pull request merged on `repo` that GitHub (the fake) has, with no webhook delivered: one merged before the project connected GitHub. */
export async function mergedOnGithub(repo: string, pr: { number: number; title: string; author?: string; mergedAt: string }) {
  const response = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/pull-request`, { method: "POST", body: JSON.stringify({ repo, ...pr }) });
  expect(response.ok).toBe(true);
}

/** Repository `repo` on GitHub (the fake): its default branch (`branch`, main) at a commit, with these files. */
export async function repositoryFiles(repo: string, files: Record<string, string>, branch = "main") {
  const response = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({ repo, commit: `c-${randomInt(1_000_000_000)}`, branch, files }),
  });
  expect(response.ok).toBe(true);
}

/** A release published on acme/app (as connectGithub set it up): Tuti gets the signed webhook delivery. */
export async function publishRelease(installationId: number, release: { tag: string; name?: string }) {
  const body = JSON.stringify({
    action: "published",
    installation: { id: installationId },
    repository: { id: installationId, full_name: "acme/app" },
    release: {
      tag_name: release.tag,
      name: release.name ?? null,
      html_url: `https://github.com/acme/app/releases/tag/${release.tag}`,
      published_at: new Date().toISOString(),
    },
  });
  await deliver("release", body);
}

/** A webhook delivery from GitHub, signed with the fake's secret. */
async function deliver(event: string, body: string) {
  const response = await fetch(`${APP_URL}/api/github/webhook`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", FAKE_GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  });
  expect(response.status).toBe(200);
}
