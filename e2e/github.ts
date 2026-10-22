import { createHmac, randomInt } from "node:crypto";

import { expect } from "@playwright/test";
import { FAKE_GITHUB_WEBHOOK_SECRET } from "@tuti/testkit";

import { APP_URL } from "./env";
import type { TestPage } from "./helpers";

/**
 * Connects the project to GitHub from its settings, as `admin`, and adds `add` (by default every
 * listed repository) to it; returns the installation's id. A new installation on "acme" by
 * default, with one repository, acme/app, whose id is the installation's.
 */
export async function connectGithub(
  admin: TestPage,
  slug: string,
  installation: { id?: number; account?: string; repositories?: { id: number; fullName: string }[]; add?: string[] } = {},
): Promise<number> {
  const id = installation.id ?? randomInt(1_000_000, 2_000_000_000);
  const repositories = installation.repositories ?? [{ id, fullName: "acme/app" }];
  const response = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/next-install`, {
    method: "POST",
    body: JSON.stringify({
      forwardedFor: admin.ip,
      setupUrl: `${APP_URL}/api/github/setup`,
      id,
      account: installation.account ?? "acme",
      repositories,
      code: `code-${id}`,
    }),
  });
  expect(response.ok).toBe(true);
  await admin.goto(`/app/${slug}/settings/integrations`);
  // GitHub (the fake) says which accounts they have the app on; they pick this one.
  await admin.getByRole("link", { name: "Connect GitHub" }).click();
  await admin.waitForURL(`**/app/${slug}/settings/integrations?github=choose`);
  await admin.getByRole("link", { name: `Connect @${installation.account ?? "acme"}` }).click();
  await admin.waitForURL(`**/app/${slug}/settings/integrations/github?github=connected`);
  for (const name of installation.add ?? repositories.map((repo) => repo.fullName)) {
    await admin.getByRole("button", { name: "Add repository" }).click();
    await admin.getByRole("list", { name: "Repositories to add" }).getByRole("button", { name }).click();
    await expect(admin.getByRole("list", { name: "This project's repositories" }).getByText(name, { exact: true })).toBeVisible();
  }
  return id;
}

/** GitHub telling Tuti about a pull request on acme/app (a signed webhook delivery), as connectGithub set it up. */
export async function pullRequestEvent(installationId: number, action: string, pr: { number: number; title: string; body?: string }) {
  const body = JSON.stringify({
    action,
    installation: { id: installationId },
    repository: { id: installationId, full_name: "acme/app" },
    pull_request: { number: pr.number, title: pr.title, body: pr.body ?? "", html_url: `https://github.com/acme/app/pull/${pr.number}` },
  });
  const response = await fetch(`${APP_URL}/api/github/webhook`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", FAKE_GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  });
  expect(response.status).toBe(200);
}
