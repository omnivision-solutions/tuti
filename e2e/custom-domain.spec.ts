import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { issueCertificate, publishTxt } from "./dns";
import { APP_URL } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team puts the portal on its own domain: adds it, verifies it with a TXT record, and people sign up and post there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // *.localhost reaches this machine in Chromium, like a domain pointed at Tuti.
  const domain = `help.${slug}.localhost`;
  const domainUrl = `http://${domain}:${new URL(APP_URL).port}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings`);
  await owner.getByLabel("Domain").fill(domain);
  await owner.getByRole("button", { name: "Add domain" }).click();
  await expect(owner.getByText("Waiting for DNS")).toBeVisible();
  const txt = owner.getByRole("definition").filter({ hasText: `_tuti.${domain}` });
  await expect(owner.getByRole("definition").filter({ hasText: "customers.example.com" })).toBeVisible();
  await checkpoint(owner, "settings-custom-domain-pending");

  // Before the record is there, it says what's missing; nobody can reach the portal there yet.
  const visitor = await newPerson(browser, domainUrl);
  expect((await visitor.request.get("/")).status()).toBe(404);
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(`We couldn't find the TXT record _tuti.${domain}`, { exact: false })).toBeVisible();

  await publishTxt(`_tuti.${domain}`, await txt.locator("code").nth(1).innerText());
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(`${domain} is verified`)).toBeVisible();
  // Cloudflare gets its certificate once the CNAME points at Tuti.
  await expect(owner.getByText("Certificate pending", { exact: true })).toBeVisible();
  await checkpoint(owner, "settings-custom-domain-certificate-pending");
  await issueCertificate(domain);
  await owner.getByRole("button", { name: "Check again" }).click();
  await expect(owner.getByText("Verified", { exact: true })).toBeVisible();
  await checkpoint(owner, "settings-custom-domain-verified");

  // The portal answers there (within seconds: servers keep lookups briefly), and its forms work there.
  await expect(async () => {
    await visitor.goto("/feedback/feature-requests");
    await expect(visitor.getByRole("heading", { name: "Feature requests" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${domainUrl}/sign-in?next=%2Ffeedback%2Ffeature-requests`);
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await visitor.getByLabel("Name").fill("Ada");
  await visitor.getByLabel("Email").fill(`e2e-${randomUUID()}@example.com`);
  await visitor.getByLabel("Password").fill("correct horse battery staple");
  await visitor.getByRole("button", { name: "Sign up" }).click();
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  await visitor.goto("/feedback/feature-requests");
  await visitor.getByLabel("Title").fill("Dark mode on our own domain");
  await visitor.getByRole("button", { name: "Submit feedback" }).click();
  await visitor.getByRole("link", { name: "Dark mode on our own domain" }).click();
  // Its page is on that domain too.
  await visitor.waitForURL((url) => url.origin === domainUrl && url.pathname.startsWith("/feedback/feature-requests/"));
  await expect(visitor.getByRole("heading", { name: "Dark mode on our own domain" })).toBeVisible();
  await checkpoint(visitor, "portal-on-custom-domain");

  // Removed, it stops answering there.
  await owner.getByRole("button", { name: "Remove" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${domain} removed`)).toBeVisible();
  await expect(owner.getByLabel("Domain")).toBeVisible();
  await expect(async () => expect((await visitor.request.get("/")).status()).toBe(404)).toPass({ timeout: 20_000 });
});
