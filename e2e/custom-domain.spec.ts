import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { issueCertificate, publishTxt } from "./dns";
import { APP_URL, portalUrl } from "./env";
import { apiFor, backToPortal, createProject, fillSignUp, newPerson, signUp } from "./helpers";

test("the team puts the portal on its own domain: adds it, verifies it with a TXT record, and people sign up and post there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // *.localhost reaches this machine in Chromium, like a domain pointed at Tuti.
  const domain = `help.${slug}.localhost`;
  const domainUrl = `http://${domain}:${new URL(APP_URL).port}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/domain`);
  // Settings → Domain: three ways to go live; they pick a domain of their own.
  await expect(owner.getByRole("radio", { name: /Tuti address/ })).toHaveAttribute("aria-checked", "true");
  await owner.getByRole("radio", { name: /Custom domain/ }).click();
  await owner.getByRole("textbox", { name: "Custom domain" }).fill(domain);
  await owner.getByRole("button", { name: "Connect domain" }).click();
  // In steps: the domain's done, its DNS records are next.
  const domainStep = owner.getByRole("region", { name: "Domain", exact: true });
  await expect(domainStep.getByText("Waiting for DNS")).toBeVisible();
  await expect(owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: "DNS records" }) })).toHaveAttribute("aria-current", "step");
  // The records to add in a table, each part selectable, with its Copy button; neither found yet.
  const records = owner.getByRole("table", { name: `DNS records for ${domain}` });
  const txt = records.getByRole("row").filter({ hasText: "TXT" });
  await expect(txt).toContainText(`_tuti.${domain}`);
  await expect(txt).toContainText("Pending");
  await expect(records.getByRole("row").filter({ hasText: "CNAME" })).toContainText("customers.example.com");
  await expect(txt.getByRole("button", { name: "Copy TXT content" })).toBeVisible();
  // While it's connected, switching waits for it to be removed (the others are aria-disabled, and say why when clicked).
  await owner.getByRole("radio", { name: /Sub-folder/ }).click({ force: true });
  await expect(owner.getByText(`Remove ${domain} before switching.`)).toBeVisible();
  await expect(owner.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-checked", "true");
  await checkpoint(owner, "settings-custom-domain-pending");
  // On a phone each record is a block, its parts labelled.
  const desktop = owner.viewportSize()!;
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "settings-custom-domain-pending-phone");
  await owner.setViewportSize(desktop);

  // Before the record is there, it says what's missing; nobody can reach the portal there yet.
  const visitor = await newPerson(browser, domainUrl);
  expect((await visitor.request.get("/")).status()).toBe(404);
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(`We couldn't find the TXT record _tuti.${domain}`, { exact: false })).toBeVisible();

  await publishTxt(`_tuti.${domain}`, await txt.locator("code").nth(1).innerText());
  // Copying a part puts it on the clipboard.
  await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await txt.getByRole("button", { name: "Copy TXT name" }).click();
  await expect(owner.getByText("Copied")).toBeVisible();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(`_tuti.${domain}`);
  // Back from their DNS provider's one-click flow ("Add with Cloudflare") having cancelled it: nothing's checked.
  await owner.goto(`/app/${slug}/settings/domain?dns=added&error=access_denied`);
  await owner.waitForLoadState("networkidle");
  await owner.reload();
  await expect(domainStep.getByText("Waiting for DNS")).toBeVisible();
  // Back with the records added: checked at once, without Check DNS, and only the once.
  await owner.goto(`/app/${slug}/settings/domain?dns=added`);
  await expect(owner.getByText(`${domain} is verified`)).toBeVisible();
  // The page drops `?dns=added` once it has checked (waited for: it's replaced after the check renders).
  await expect.poll(() => new URL(owner.url()).search).toBe("");
  // Cloudflare gets its certificate once the CNAME points at Tuti.
  await expect(domainStep.getByText("Certificate pending", { exact: true })).toBeVisible();
  // The TXT record's found; the CNAME waits for the certificate.
  await expect(txt).toContainText("Verified");
  await expect(records.getByRole("row").filter({ hasText: "CNAME" })).toContainText("Pending");
  await checkpoint(owner, "settings-custom-domain-certificate-pending");
  await issueCertificate(domain);
  await owner.getByRole("button", { name: "Check again" }).click();
  // The domain's own badge: the records below say Verified too.
  await expect(domainStep.locator('[data-slot="badge"]', { hasText: /^Verified$/ })).toBeVisible();
  await expect(records.getByRole("row").filter({ hasText: "CNAME" })).toContainText("Verified");
  await expect(owner.getByRole("region", { name: "Live" })).toContainText(`Your portal answers at ${domain}`);
  await checkpoint(owner, "settings-custom-domain-verified");

  // From now on its Tuti address sends people to the domain.
  const elsewhere = await newPerson(browser, portalUrl(slug));
  await expect(async () => {
    await elsewhere.goto("/roadmap?from=old");
    expect(elsewhere.url()).toBe(`${domainUrl}/roadmap?from=old`);
  }).toPass({ timeout: 20_000 });

  // The portal answers there (within seconds: servers keep lookups briefly), and its forms work there.
  await expect(async () => {
    await visitor.goto("/feedback/feature-requests");
    await expect(visitor.getByRole("heading", { name: "Feature requests" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  // The project's own widget (Customize → Widget, on by default): its panel is on this domain, where the reader's session is.
  await expect(visitor.locator("script[data-on-portal]")).toHaveCount(1);
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await expect(visitor.locator('iframe[title="Feedback"]')).toHaveAttribute("src", `${domainUrl}/widget`);

  // The team's own HTML (Customize → Custom code) runs on their domain, scripts too, and never on a Tuti address.
  await owner.goto(`/app/${slug}/settings/custom-code`);
  await expect(owner.getByText(`It runs on ${domain}`, { exact: false })).toBeVisible();
  // An external script, then one that needs it: they run in that order, as on a page of their own.
  await owner
    .getByLabel("Custom HTML")
    .fill(
      // A script that isn't JavaScript (and so never loads) holds nothing up.
      // In an element too.
      '<p id="team-html">From the team</p><script type="text/plain" src="data:text/plain,x"></script><div><script src="data:text/javascript,window.teamLib={ready:\'ran\'}"></script><script>document.body.dataset.teamScript = window.teamLib.ready</script></div>',
    );
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Custom code saved")).toBeVisible();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator("#team-html")).toHaveText("From the team");
  await expect(visitor.locator("body")).toHaveAttribute("data-team-script", "ran");
  const onTuti = await newPerson(browser, portalUrl(slug));
  await onTuti.goto("/feedback/feature-requests?customize=1");
  await expect(onTuti.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  await expect(onTuti.locator("#team-html")).toHaveCount(0);
  await expect(onTuti.locator("body")).not.toHaveAttribute("data-team-script", "ran");

  // Another tool's widget.js (here only named, in a comment) isn't Tuti's: the portal keeps its own.
  await owner.getByLabel("Custom HTML").fill("<!-- https://chat.example.com/js/widget.js -->");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator("script[data-on-portal]")).toHaveCount(1);

  // Custom code that adds the widget its own way (here without its launcher): it gives way to the portal's own, which Ask AI
  // and the reader's sign-in here need. One launcher, the portal's. On the Tuti address, where their code doesn't run, the
  // portal's is there too.
  await owner.getByLabel("Custom HTML").fill(`<script src="${APP_URL}/api/widget.js" data-project="${slug}" data-hide-launcher async></script>`);
  await owner.getByRole("button", { name: "Save changes" }).click();
  // Saved once it has nothing left to save (the first save's toast may still be up).
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator('script[src$="/widget.js"]')).toHaveCount(1);
  await expect(visitor.locator("script[data-on-portal]")).toHaveCount(1);
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(1);
  await onTuti.reload();
  await expect(onTuti.locator("script[data-on-portal]")).toHaveCount(1);
  // With the portal's own turned off, Custom code's still gives way (Ask AI and sign-in need the portal's), and brings the
  // portal's launcher back.
  const api = await apiFor(owner, slug);
  await api("/widget", { onPortal: false }, "PATCH");
  await owner.goto(`/app/${slug}/settings/custom-code`);
  await owner.getByLabel("Custom HTML").fill(`<script src="${APP_URL}/api/widget.js" data-project="${slug}" async></script>`);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator("script[data-on-portal]")).not.toHaveAttribute("data-hide-launcher");
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(1);
  // Its panel is the portal's, on this domain.
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await expect(visitor.locator('iframe[title="Feedback"]')).toHaveAttribute("src", `${domainUrl}/widget`);
  // Added without its launcher (data-hide-launcher), it brings none back.
  await owner.getByLabel("Custom HTML").fill(`<script src="${APP_URL}/api/widget.js" data-project="${slug}" data-hide-launcher async></script>`);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator("script[data-on-portal]")).toHaveAttribute("data-hide-launcher", "");
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(0);
  // Nor hidden through TutiSettings.
  await owner
    .getByLabel("Custom HTML")
    .fill(`<script>window.TutiSettings = { hideLauncher: true };</script><script src="${APP_URL}/api/widget.js" data-project="${slug}" async></script>`);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.locator("script[data-on-portal]")).toHaveAttribute("data-hide-launcher", "");
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(0);
  await api("/widget", { onPortal: true }, "PATCH");

  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${domainUrl}/sign-in?next=%2Ffeedback%2Ffeature-requests`);
  // The account is made on the app (a password is never typed on the team's domain), and back.
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await visitor.waitForURL((url) => url.origin === APP_URL && url.pathname === "/app/auth/sign-up");
  await fillSignUp(visitor, "Ada", `e2e-${randomUUID()}@example.com`);
  await visitor.waitForURL((url) => url.pathname === "/app/auth/continue");
  await backToPortal(visitor);
  await expect(visitor).toHaveURL(`${domainUrl}/feedback/feature-requests`);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  await visitor.goto("/feedback/feature-requests");
  await visitor.getByRole("button", { name: "New idea" }).click();
  await visitor.getByLabel("Title").fill("Dark mode on our own domain");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await visitor.getByRole("link", { name: "Dark mode on our own domain" }).click();
  // Its page is on that domain too.
  await visitor.waitForURL((url) => url.origin === domainUrl && url.pathname.startsWith("/feedback/feature-requests/"));
  await expect(visitor.getByRole("heading", { name: "Dark mode on our own domain" })).toBeVisible();
  await checkpoint(visitor, "portal-on-custom-domain");

  // Removed, it stops answering there.
  await owner.goto(`/app/${slug}/settings/domain`);
  // A destructive button, hovered: its text reads on the tint (colours.test.ts holds the contrast).
  await owner.getByRole("button", { name: "Remove domain" }).hover();
  await checkpoint(owner, "settings-custom-domain-remove");
  await owner.getByRole("button", { name: "Remove domain" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${domain} removed`)).toBeVisible();
  await expect(owner.getByRole("textbox", { name: "Custom domain" })).toBeVisible();
  await expect(owner.getByRole("radio", { name: /Sub-folder/ })).toHaveAttribute("aria-disabled", "false");
  await expect(async () => expect((await visitor.request.get("/")).status()).toBe(404)).toPass({ timeout: 20_000 });
  // And the Tuti address is the portal's again.
  await expect(async () => {
    await elsewhere.goto("/roadmap");
    expect(elsewhere.url()).toBe(`${portalUrl(slug)}/roadmap`);
  }).toPass({ timeout: 20_000 });
});
