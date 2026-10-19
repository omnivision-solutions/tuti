import { createHmac, randomInt } from "node:crypto";

import { expect } from "@playwright/test";
import { FAKE_GITHUB_WEBHOOK_SECRET } from "@tuti/testkit";

import { APP_URL } from "./env";
import type { TestPage } from "./helpers";

/** Connects the project to GitHub from its settings, as `admin`; returns the new installation's id. */
export async function connectGithub(admin: TestPage, slug: string): Promise<number> {
  const id = randomInt(1_000_000, 2_000_000_000);
  const response = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/next-install`, {
    method: "POST",
    body: JSON.stringify({ forwardedFor: admin.ip, setupUrl: `${APP_URL}/api/github/setup`, id, account: "acme", code: `code-${id}` }),
  });
  expect(response.ok).toBe(true);
  await admin.goto(`/app/${slug}/settings`);
  await admin.getByRole("link", { name: "Connect GitHub" }).click();
  await admin.waitForURL(`**/app/${slug}/settings?github=connected`);
  return id;
}

/** GitHub telling Tuti about a pull request on acme/app (a signed webhook delivery). */
export async function pullRequestEvent(installationId: number, action: string, pr: { number: number; title: string; body?: string }) {
  const body = JSON.stringify({
    action,
    installation: { id: installationId },
    repository: { full_name: "acme/app" },
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
