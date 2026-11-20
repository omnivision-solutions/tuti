import { randomUUID } from "node:crypto";

import pg from "pg";

import { expect, test } from "./fixtures";

import { seedArticles } from "./articles";
import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";
import { verifyEmail } from "./mail";

// On Tuti's cloud, which sells plans.
test("an owner starts Pro on Stripe, gets its month's AI credits, hides \"Powered by tuti\" with the add-on, and cancels the plan in Stripe's portal", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("Free plan", { exact: true })).toBeVisible();
  // Its email to its users this month, against its plan's limit.
  await expect(owner.getByText("1,000 of 1,000 left")).toBeVisible();
  // Picked with the keyboard too (native radios): Yearly, then back.
  await owner.getByRole("radio", { name: "Monthly" }).focus();
  await owner.keyboard.press("ArrowRight");
  await expect(owner.getByRole("radio", { name: "Yearly" })).toBeChecked();
  const pro = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: "Pro", exact: true }) });
  await expect(pro).toContainText("$32a month$384 billed yearly");
  // What yearly saves, as on the pricing page.
  await expect(owner.getByText("Save up to 20%")).toBeVisible();
  await owner.getByText("Monthly", { exact: true }).click();
  await expect(pro).toContainText("$39a monthBilled monthly");
  // Free beside Pro and Business, as the pricing page's cards show them: the numbers, then what each adds to the one
  // before. Pro's button is the page's one primary.
  await expect(pro.getByText("Most popular")).toBeVisible();
  await expect(owner.getByText("Your plan", { exact: true })).toBeVisible();
  await expect(pro.getByRole("definition")).toHaveText(["1,000", "5", "10k"]);
  await expect(pro.getByText("Everything in Free, plus")).toBeVisible();
  await expect(pro.getByRole("listitem")).toContainText(["Your own domain"]);
  const business = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: "Business", exact: true }) });
  await expect(business.getByRole("listitem")).toContainText(["Subpath on your domain", "Private help center", "Fine-tune Autopilot", "Priority support"]);
  // Every feature is on Tuti's pricing page, linked only on Tuti's own cloud (tuti.so); this server opens each plan's lines here.
  await expect(owner.getByRole("link", { name: /Compare all features/ })).toHaveCount(0);
  const primary = await owner.getByRole("main").locator('[data-slot="button"]').evaluateAll((buttons) =>
    buttons.filter((button) => button.className.includes("bg-primary ")).map((button) => button.textContent),
  );
  expect(primary).toEqual(["Upgrade to Pro"]);
  // The badge's card has a way to it on the free plan too: to the plans, billed as picked there.
  await expect(owner.getByRole("link", { name: "Choose a plan" })).toHaveAttribute("href", "#plans");
  await checkpoint(owner, "team-settings-billing-free-plan");
  await owner.getByText("Compare all features").click();
  await expect(owner.getByText("3 team members")).toBeVisible();
  await owner.getByText("3 team members").scrollIntoViewIfNeeded();
  await checkpoint(owner, "team-settings-billing-plans-compared");
  // From the keyboard: while Stripe's page is being opened (its request held here), Upgrade is off but keeps the focus.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route("**/settings/billing", async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.fallback();
  });
  const upgrade = owner.getByRole("button", { name: "Upgrade to Pro" });
  await upgrade.focus();
  await owner.keyboard.press("Enter");
  await expect(upgrade).toBeDisabled();
  await expect(upgrade).toBeFocused();
  release();

  // Stripe's page (the fake), then back to Billing on Pro, with its credits for the month.
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);
  await expect(owner.getByRole("heading", { name: "Pro plan", exact: true })).toBeVisible();
  await expect(owner.getByText(/^\$39 a month · Renews on \d{1,2} [A-Z][a-z]+ \d{4}$/)).toBeVisible();
  await expect(owner.getByText("10,000 of 10,000 left")).toBeVisible();
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Pro plan/ })).toContainText("1,000");
  await checkpoint(owner, "team-settings-billing-pro-plan");

  // Branding, open in another tab since before the add-on: its switch is on.
  const stale = await owner.context().newPage();
  await stale.goto(`/app/${slug}/settings/branding`);
  await expect(stale.getByRole("switch", { name: '"Powered by tuti"' })).toBeChecked();

  // The "Powered by tuti" add-on: added to the plan, the badge is gone from the portal.
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  const confirm = owner.getByRole("alertdialog", { name: 'Hide "Powered by tuti"?' });
  await expect(confirm).toContainText("$49 a month is added to this project's plan.");
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await expect(owner.getByText('"Powered by tuti" is hidden')).toBeVisible();
  await expect(owner.getByText("Hidden on this project's plan. It ends with the plan.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Show the badge again" })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-badge-add-on");
  // Saving something else from the tab opened before leaves the badge hidden: its switch wasn't touched, so it isn't
  // sent, and then shows what's saved.
  await stale.getByLabel("Text beside it").fill("Acme");
  await stale.getByRole("button", { name: "Save changes" }).click();
  await expect(stale.getByText("Branding saved")).toBeVisible();
  await expect(stale.getByRole("switch", { name: '"Powered by tuti"' })).not.toBeChecked();
  await expect(stale.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await stale.close();
  const reader = await owner.context().newPage();
  await reader.goto(cloudPortalUrl(slug));
  await expect(reader.getByRole("banner")).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  // Nor under the widget's tabs.
  await reader.goto(`${cloudPortalUrl(slug)}/widget`);
  await expect(reader.getByRole("navigation", { name: "Widget" })).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await expect(owner.getByText("Hidden with the add-on on this project's plan.")).toBeVisible();
  await expect(owner.getByRole("switch", { name: '"Powered by tuti"' })).not.toBeChecked();
  // Showing the badge again here leaves the add-on billing: the field says where it's removed.
  await owner.getByRole("switch", { name: '"Powered by tuti"' }).click();
  await expect(owner.getByRole("switch", { name: '"Powered by tuti"' })).toHaveAccessibleDescription("The add-on is still on this project's plan: remove it in Billing.");
  await expect(owner.getByText("The add-on is still on").getByRole("link", { name: "Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "customize-branding-badge-shown-with-add-on");
  // Saved with "Save changes", the badge is back on the portal. Switched off again while that was being saved, it
  // stays off and still to save once the save lands; switched back on, there's nothing left to save.
  const save = owner.getByRole("button", { name: "Save changes" });
  const badgeSwitch = owner.getByRole("switch", { name: '"Powered by tuti"' });
  let land!: () => void;
  const saving = new Promise<void>((resolve) => (land = resolve));
  await owner.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) await saving;
    await route.fallback();
  });
  await save.click();
  await expect(owner.getByRole("button", { name: "Saving…" })).toBeVisible();
  await badgeSwitch.click();
  land();
  await owner.unroute("**/*");
  await expect(owner.getByText("Branding saved")).toBeVisible();
  // Once the page has what's saved (the badge on): the pick made meanwhile is what shows, not what's saved.
  await expect(owner.locator('input[name="poweredBy"]')).toHaveAttribute("data-saved", "on");
  await expect(save).toBeEnabled();
  await expect(badgeSwitch).not.toBeChecked();
  await badgeSwitch.click();
  await expect(save).toBeDisabled();
  await owner.reload();
  await expect(badgeSwitch).toBeChecked();
  await reader.goto(cloudPortalUrl(slug));
  await expect(reader.getByRole("link", { name: /Powered by/ })).toBeVisible();
  // Switched off and back on here with nothing being saved: a pick taken back, forgotten.
  await badgeSwitch.click();
  await badgeSwitch.click();
  await expect(save).toBeDisabled();
  // Switched off and saved in another tab, it's gone again.
  const other = await owner.context().newPage();
  await other.goto(`/app/${slug}/settings/branding`);
  await other.getByRole("switch", { name: '"Powered by tuti"' }).click();
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByText("Branding saved")).toBeVisible();
  await other.close();
  await reader.reload();
  await expect(reader.getByRole("banner")).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  // And stays gone when this tab, which saved it shown, saves something else: its switch then shows what's saved.
  await owner.getByLabel("Links to").fill("https://acme.example");
  await save.click();
  await expect(owner.getByRole("switch", { name: '"Powered by tuti"' })).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(owner.getByText("Hidden with the add-on on this project's plan.")).toBeVisible();
  await reader.reload();
  await expect(reader.getByRole("banner")).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  await reader.close();
  await owner.goto(`/app/${slug}/settings/billing`);

  // Cancelled in Stripe's portal, it lasts until the period it's paid for ends.
  await owner.getByRole("button", { name: "Manage plan" }).click();
  await owner.getByRole("button", { name: "Cancel plan" }).click();
  await owner.getByRole("link", { name: "Return to Tuti" }).click();
  await expect(owner.getByText(/^\$39 a month · Ends on \d{1,2} [A-Z][a-z]+ \d{4}$/)).toBeVisible();
});

test("on Tuti's cloud, hiding \"Powered by tuti\" on the free plan points to Billing, where paid plans can add it", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await owner.locator("#powered-by").getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText("The badge at the foot of your portal. Hiding it is an add-on to a paid plan.")).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("switch", { name: '"Powered by tuti"' })).toHaveAccessibleDescription("Hiding it is an add-on to a paid plan.");
  await owner.getByRole("switch", { name: '"Powered by tuti"' }).click();
  const dialog = owner.getByRole("dialog", { name: 'Keep "Powered by tuti"?' });
  await expect(dialog).toContainText("add it to its plan in Billing: $49 a month, on a paid plan.");
  await expect(dialog.getByRole("link", { name: "Get a licence" })).toHaveCount(0);
  await dialog.getByRole("link", { name: "See Billing" }).click();
  await expect(owner).toHaveURL(`${CLOUD_URL}/app/${slug}/settings/billing`);
  await expect(owner.getByText("Paid plans can hide the badge at the foot of the portal for $49 a month.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Hide the badge" })).toHaveCount(0);
});

test("on the free plan, a project has up to 3 team members, invites included, 2 boards, 50 published articles and Autopilot; its own address and a private portal need a paid plan", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await verifyEmail(owner);
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/team`);
  const invite = async (email: string) => {
    await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(email);
    await owner.getByRole("button", { name: "Send invite" }).click();
  };
  // The plan's room is said where inviting happens: in Invite people's dialog, which stays open between invites.
  // Opened from the keyboard, it starts in the email field, not on the note's "upgrade" link above it.
  await owner.getByRole("button", { name: "Invite people" }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("textbox", { name: "Email of the person to invite" })).toBeFocused();
  await expect(owner.getByRole("dialog", { name: "Invite people" })).toContainText("Projects on the Free plan have up to 3 team members, invites included (1 now); upgrade for more.");
  for (const email of [`e2e-${randomUUID()}@example.com`, `e2e-${randomUUID()}@example.com`]) {
    await invite(email);
    await expect(owner.getByText(`Invite sent to ${email}`)).toBeVisible();
  }
  await invite(`e2e-${randomUUID()}@example.com`);
  await expect(
    owner.getByText("Projects on the Free plan have up to 3 team members, invites included. Upgrade to Pro in Settings → Billing to invite more."),
  ).toBeVisible();
  await checkpoint(owner, "team-free-plan-full");

  // Two feedback boards on Free: at the limit, "New board" makes way for the way to upgrade.
  await owner.goto(`/app/${slug}/feedback/boards`);
  await owner.getByRole("button", { name: "New board" }).click();
  const newBoard = owner.getByRole("dialog", { name: "New board" });
  await newBoard.getByLabel("Name").fill("Bug reports");
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(owner.getByText("Board created")).toBeVisible();
  await expect(owner.getByRole("alert").filter({ hasText: "Projects on the Free plan have up to 2 feedback boards." })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await expect(owner.getByRole("button", { name: "New board" })).toHaveCount(0);
  await checkpoint(owner, "boards-free-plan-full");

  // Fifty published docs articles on Free: a draft saves, but publishing it is refused, saying the way out.
  await seedArticles(slug, 50);
  await owner.goto(`/app/${slug}/docs/one-too-many`);
  await owner.getByRole("button", { name: "Publish" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(owner.getByText("Your plan publishes up to 50 articles. Unpublish some, or upgrade to Pro.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Publish" })).toBeVisible();
  await checkpoint(owner, "docs-free-plan-full");

  // Autopilot is on every plan: no notice, and GitHub is a click away.
  await owner.goto(`/app/${slug}/autopilot`);
  await expect(owner.getByText("Connect GitHub and add your repositories: each pull request merged there shows up here.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute("href", `/app/${slug}/settings/integrations`);
  await expect(owner.getByText("Autopilot needs the Pro plan.")).toHaveCount(0);
  await checkpoint(owner, "autopilot-free-plan");
  // On a phone, with nothing in its list: the page's heading first, then why there's nothing (no empty list too).
  await owner.setViewportSize({ width: 390, height: 844 });
  const heading = (await owner.getByRole("heading", { name: "Autopilot", level: 1 }).boundingBox())!;
  expect((await owner.getByText("Nothing from Autopilot yet").boundingBox())!.y).toBeGreaterThan(heading.y);
  await expect(owner.getByText("Nothing to review")).toBeHidden();
  await checkpoint(owner, "autopilot-empty-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });

  // A domain of its own is on Pro, a path of the team's site on Business.
  await owner.goto(`/app/${slug}/customize/address`);
  const options = owner.getByRole("radiogroup", { name: "Where your portal goes live" });
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toContainText("A custom domain needs the Pro plan.");
  await expect(options.getByRole("radio", { name: /Sub-folder/ })).toContainText("A portal under a path of your site needs the Business plan.");
  // Like any other option, described by the plan it needs; picking it opens the upgrade prompt and leaves the Tuti address picked.
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "false");
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toHaveAccessibleDescription("A custom domain needs the Pro plan.");
  await options.getByRole("radio", { name: /Custom domain/ }).click();
  const needsPro = owner.getByRole("dialog", { name: "A custom domain needs the Pro plan." });
  await expect(needsPro.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await needsPro.getByRole("button", { name: "Not now" }).click();
  await expect(needsPro).toBeHidden();
  await expect(options.getByRole("radio", { name: /Tuti address/ })).toHaveAttribute("aria-checked", "true");
  await checkpoint(owner, "customize-address-free-plan");

  // Its own address for emails needs a plan too: "Set up" looks like any other, says what it needs and opens the upgrade prompt, not its steps.
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  const setUp = owner.getByRole("button", { name: "Set up", exact: true });
  await expect(setUp).toHaveAccessibleDescription(/^Emailing from your own domain needs the \w+ plan\.$/);
  await setUp.click();
  const ownAddress = owner.getByRole("dialog", { name: /^Emailing from your own domain needs the \w+ plan\.$/ });
  await expect(ownAddress.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await ownAddress.getByRole("button", { name: "Not now" }).click();
  await expect(ownAddress).toBeHidden();
  await expect(setUp).toBeVisible();
  await expect(owner.getByLabel("Your company's address")).toHaveCount(0);

  // A private portal and reader groups are on Business: Private looks like any other option and says what it needs.
  await owner.goto(`/app/${slug}/settings/access`);
  await expect(owner.getByText("A private portal and reader groups need the Business plan.")).toBeHidden();
  const access = owner.getByRole("combobox", { name: "Who can see your portal" });
  await access.click();
  const makePrivate = owner.getByRole("option", { name: "Private" });
  await expect(makePrivate).toBeEnabled();
  await expect(makePrivate).toHaveAccessibleDescription("A private portal and reader groups need the Business plan.");
  // Choosing it opens the upgrade prompt, and the portal stays public.
  await makePrivate.click();
  const upgrade = owner.getByRole("dialog", { name: "A private portal and reader groups need the Business plan." });
  await expect(upgrade.getByRole("link", { name: "See plans" })).toBeVisible();
  await checkpoint(owner, "settings-access-upgrade-prompt");
  await upgrade.getByRole("button", { name: "Not now" }).click();
  await expect(upgrade).toBeHidden();
  await expect(access).toContainText("Public");
  await access.click();
  await makePrivate.click();
  await upgrade.getByRole("link", { name: "See plans" }).click();
  await expect(owner).toHaveURL(`${CLOUD_URL}/app/${slug}/settings/billing`);
  await owner.goto(`/app/${slug}/settings/access`);
  await expect(access).toContainText("Public");
  // A portal made private while its plan had that (as before a downgrade) says what happens to it now, and can go public.
  const database = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await database.connect();
  try {
    await database.query(`UPDATE project SET "portalAccess" = 'PRIVATE' WHERE slug = $1`, [slug]);
  } finally {
    await database.end();
  }
  await owner.reload();
  await expect(owner.getByRole("alert").filter({ hasText: "A private portal and reader groups need the Business plan." })).toHaveText(
    "A private portal and reader groups need the Business plan. Without it, a private portal and content for reader groups are your team's only. Your settings are kept. See Billing",
  );
  await checkpoint(owner, "settings-access-private-free-plan");
  await access.click();
  await owner.getByRole("option", { name: "Public" }).click();
  await expect(owner.getByText("Portal is now public")).toBeVisible();
  await expect(upgrade).toBeHidden();
  await expect(owner.getByRole("alert").filter({ hasText: "A private portal and reader groups need the Business plan." })).toHaveCount(0);
  // Groups, in Users, says so too.
  await owner.goto(`/app/${slug}/settings/groups`);
  await expect(owner.getByRole("alert").filter({ hasText: "A private portal and reader groups need the Business plan." })).toHaveText(
    "A private portal and reader groups need the Business plan. Without it, content for groups is your team's only. Your groups are kept. See Billing",
  );
});

test("on Tuti's cloud, the widget launcher's icon on the free plan opens the upgrade prompt, its colour saves", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.setViewportSize({ width: 1440, height: 900 });

  await owner.goto(`/app/${slug}/settings/widget`);
  // Like any other choice, not faded, described by the plan it needs.
  const icons = owner.getByRole("radiogroup", { name: "Icon" });
  await expect(icons).toHaveAccessibleDescription("Choosing the launcher's icon needs the Pro plan.");
  await expect(icons).toHaveCSS("opacity", "1");
  await expect(icons.getByRole("radio", { name: "Megaphone" })).toBeEnabled();
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  // Choosing one opens the upgrade prompt, and the chat bubble stays. Chosen again until it opens: before the page
  // hydrates, a click only checks the radio (Chat first puts it back).
  const needsPro = owner.getByRole("dialog", { name: "Choosing the launcher's icon needs the Pro plan." });
  await expect(async () => {
    await icons.locator("label").filter({ hasText: "Chat" }).click();
    await icons.locator("label").filter({ hasText: "Megaphone" }).click();
    await expect(needsPro).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(needsPro.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "widget-settings-icon-upgrade");
  await needsPro.getByRole("button", { name: "Not now" }).click();
  await expect(needsPro).toBeHidden();
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await expect(icons.getByRole("radio", { name: "Megaphone" })).not.toBeChecked();
  // From the keyboard, an arrow key only moves between the icons (no prompt at each); Space chooses one.
  await icons.getByRole("radio", { name: "Chat" }).focus();
  await owner.keyboard.press("ArrowRight");
  await expect(icons.getByRole("radio", { name: "Help" })).toBeFocused();
  await owner.keyboard.press("ArrowLeft");
  await owner.keyboard.press("ArrowLeft");
  await expect(icons.getByRole("radio", { name: "Your own" })).toBeFocused();
  await expect(needsPro).toHaveCount(0);
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await owner.keyboard.press("Space");
  await expect(needsPro).toBeVisible();
  await needsPro.getByRole("button", { name: "Not now" }).click();
  await expect(needsPro).toBeHidden();
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await checkpoint(owner, "widget-settings-icon-locked");

  // On a phone nothing runs off the side, and the icons go under the plan's line (beside it, a word or two a line).
  await owner.setViewportSize({ width: 390, height: 844 });
  const settings = owner.locator('[data-slot="portal-settings"]');
  await expect(icons).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await settings.evaluate((pane) => pane.scrollWidth - pane.clientWidth)).toBeLessThanOrEqual(0);
  const line = (await owner.locator("#widget-icon-plan").boundingBox())!;
  expect((await icons.boundingBox())!.y).toBeGreaterThanOrEqual(line.y + line.height);
  await checkpoint(owner, "widget-settings-icon-locked-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  await owner.getByLabel("Colour", { exact: true }).fill("#5b21b6");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();

  // An icon set while the plan had it (as before a downgrade) is kept and says so; going back to the chat bubble, and
  // to it again, needs no plan.
  const database = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await database.connect();
  try {
    await database.query(`UPDATE project SET "widgetIcon" = 'megaphone' WHERE slug = $1`, [slug]);
  } finally {
    await database.end();
  }
  await owner.reload();
  await expect(icons).toHaveAccessibleDescription(
    "Choosing the launcher's icon needs the Pro plan. Until it's back, the launcher shows the chat bubble; the icon you picked is kept.",
  );
  await expect(icons.getByRole("radio", { name: "Megaphone" })).toBeChecked();
  // Another icon still opens the prompt (chosen again until the page has hydrated), and the kept one stays.
  await expect(async () => {
    await icons.locator("label").filter({ hasText: "Megaphone" }).click();
    await icons.locator("label").filter({ hasText: "Help" }).click();
    await expect(needsPro).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await needsPro.getByRole("button", { name: "Not now" }).click();
  await expect(needsPro).toBeHidden();
  await expect(icons.getByRole("radio", { name: "Megaphone" })).toBeChecked();
  await icons.locator("label").filter({ hasText: "Chat" }).click();
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await icons.locator("label").filter({ hasText: "Megaphone" }).click();
  await expect(icons.getByRole("radio", { name: "Megaphone" })).toBeChecked();
  await expect(needsPro).toHaveCount(0);
  // Back to the kept icon is no change: nothing to save, and the preview shows the chat bubble again.
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  // Left as it was, it isn't sent: a teammate's switch to the chat bubble meanwhile stays, and the colour saves.
  const teammate = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await teammate.connect();
  try {
    await teammate.query(`UPDATE project SET "widgetIcon" = 'chat' WHERE slug = $1`, [slug]);
  } finally {
    await teammate.end();
  }
  await owner.getByLabel("Colour", { exact: true }).fill("#4c1d95");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  // The page, refreshed by the save, shows the icon as stored, so the next save works too.
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await expect(icons).toHaveAccessibleDescription("Choosing the launcher's icon needs the Pro plan.");
  await expect(owner.getByText("Widget saved")).toBeHidden();
  await owner.getByLabel("Colour", { exact: true }).fill("#3b0764");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await owner.reload();
  await expect(icons.getByRole("radio", { name: "Chat" })).toBeChecked();
  await expect(owner.getByLabel("Colour", { exact: true })).toHaveValue("#3b0764");

  // The kept icon swapped for the chat bubble and saved: the page, refreshed with it, has nothing more to save, and an
  // edit taken back leaves nothing to save either.
  const kept = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await kept.connect();
  try {
    await kept.query(`UPDATE project SET "widgetIcon" = 'megaphone' WHERE slug = $1`, [slug]);
  } finally {
    await kept.end();
  }
  await owner.reload();
  await expect(icons.getByRole("radio", { name: "Megaphone" })).toBeChecked();
  await expect(async () => {
    await icons.locator("label").filter({ hasText: "Chat" }).click();
    await expect(owner.getByRole("button", { name: "Save changes" })).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await expect(icons).toHaveAccessibleDescription("Choosing the launcher's icon needs the Pro plan.");
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  const onPortal = owner.getByRole("switch", { name: "Show on your portal" });
  await onPortal.click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await onPortal.click();
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

test("on Tuti's cloud, Reporting on the free plan is blurred under a card pointing to Billing; on Pro, ranges up to a month, the longer ones locked", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  await owner.goto(`/app/${slug}/reporting`);
  await expect(owner.getByRole("heading", { name: "See how your help center, AI and inbox are doing", level: 2 })).toBeVisible();
  await expect(owner.getByText("Reporting needs the Pro plan.")).toBeVisible();
  // The page behind it (made-up numbers) is out of reach.
  await expect(owner.getByRole("group", { name: "Article views" })).toHaveCount(0);
  // So is the range picker: no ranges to pick until the plan has Reporting.
  await expect(owner.getByRole("button", { name: /^Date range: / })).toHaveCount(0);
  await checkpoint(owner, "team-reporting-free-plan");
  // On a phone, less blurred: the chart's thin bars stay bars.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.locator("[inert]").filter({ hasText: "Article views" })).toHaveCSS("filter", "blur(3px)");
  await checkpoint(owner, "team-reporting-free-plan-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.getByRole("link", { name: "See plans" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Upgrade to Pro" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);

  // On Pro: the numbers, and a year (past a month) shows the default range instead.
  await owner.goto(`/app/${slug}/reporting?range=year`);
  await expect(owner.getByRole("group", { name: "Article views" })).toBeVisible();
  await expect(owner.getByText("Reporting needs the Pro plan.")).toHaveCount(0);
  await owner.getByRole("button", { name: "Date range: Past 30 days" }).click();
  await expect(owner.getByRole("menuitem", { name: "Past year" })).toHaveAttribute("aria-disabled", "true");
  await expect(owner.getByRole("menuitem", { name: "Past quarter" })).toHaveAttribute("aria-disabled", "true");
  // Not faded, so they read in dark mode too: their lock says they can't be picked.
  await expect(owner.getByRole("menuitem", { name: "Past year" })).toHaveCSS("opacity", "1");
  await expect(owner.getByText("Longer ranges need the Business plan.")).toBeVisible();
  await checkpoint(owner, "team-reporting-pro-ranges", { fullPage: false });
  await owner.getByRole("menuitem", { name: "Last month" }).click();
  await owner.waitForURL(`**/app/${slug}/reporting?range=last-month`);
  await expect(owner.getByRole("button", { name: "Date range: Last month" })).toBeVisible();
});

test("on Tuti's cloud, signing up (or continuing with Google or GitHub from sign-in) agrees to the Terms of Service and Privacy Policy; a self-hosted server has no such line", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const page = await browser.newPage({ baseURL: CLOUD_URL });
  await page.goto("/app/auth/sign-up");
  await expect(page.getByText("By signing up, you agree to the Terms of Service and Privacy Policy.")).toBeVisible();
  // Selling plans without a trial in its billing file: no trial on offer.
  await expect(page.getByText("Create an account", { exact: true })).toBeVisible();
  await expect(page.getByText(/free trial/)).toHaveCount(0);
  await checkpoint(page, "sign-up-terms");
  // Sign-in's Continue with Google or GitHub signs up someone new, so it says so too.
  await page.goto("/app/auth/sign-in");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("By continuing, you agree to the Terms of Service and Privacy Policy.")).toBeVisible();
  // The pages are the marketing site's (apps/marketing), on the same domain.
  await expect(page.getByRole("main").getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  await expect(page.getByRole("main").getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");

  const selfHosted = await browser.newPage({ baseURL: APP_URL });
  await selfHosted.goto("/app/auth/sign-up");
  await expect(selfHosted.getByRole("button", { name: "Sign up" })).toBeVisible();
  // No trials on a self-hosted server: the same pitch without one.
  await expect(selfHosted.getByRole("heading", { name: "Ship code. Your help center keeps up." })).toBeVisible();
  await expect(selfHosted.getByText("Create an account", { exact: true })).toBeVisible();
  await expect(selfHosted.getByText(/free trial/)).toHaveCount(0);
  await expect(selfHosted.getByText("By signing up")).toHaveCount(0);
  await selfHosted.goto("/app/auth/sign-in");
  await expect(selfHosted.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(selfHosted.getByText("By continuing")).toHaveCount(0);
});

test("Tuti's cloud serves its plans to its marketing site; a self-hosted server sells none, and its home is the app", async ({ browser }) => {
  const cloud = await browser.newPage({ baseURL: CLOUD_URL });
  const plans = await cloud.request.get("/api/plans");
  expect(plans.status()).toBe(200);
  expect((await plans.json()).plans.map((plan: { name: string }) => plan.name)).toEqual(["Free", "Pro", "Business"]);
  const own = await browser.newPage({ baseURL: APP_URL });
  expect((await own.request.get("/api/plans")).status()).toBe(404);
  await own.goto("/");
  await own.waitForURL("**/app/auth/sign-in");
});
