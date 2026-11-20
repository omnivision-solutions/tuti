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

  // The "Powered by tuti" add-on: added to the plan, the badge is gone from the portal.
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  const confirm = owner.getByRole("alertdialog", { name: 'Hide "Powered by tuti"?' });
  await expect(confirm).toContainText("$49 a month is added to this project's plan.");
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await expect(owner.getByText('"Powered by tuti" is hidden')).toBeVisible();
  await expect(owner.getByText("Hidden on this project's plan. It ends with the plan.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Show the badge again" })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-badge-add-on");
  const reader = await owner.context().newPage();
  await reader.goto(cloudPortalUrl(slug));
  await expect(reader.getByRole("banner")).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  // Nor under the widget's tabs.
  await reader.goto(`${cloudPortalUrl(slug)}/widget`);
  await expect(reader.getByRole("navigation", { name: "Widget" })).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  await reader.close();
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await expect(owner.getByText("Hidden with the add-on on this project's plan.")).toBeVisible();
  await expect(owner.getByLabel('Show "Powered by tuti" in the footer')).not.toBeChecked();
  // Showing the badge again here leaves the add-on billing: the field says where it's removed.
  await owner.getByLabel('Show "Powered by tuti" in the footer').click();
  await expect(owner.getByLabel('Show "Powered by tuti" in the footer')).toHaveAccessibleDescription("The add-on is still on this project's plan: remove it in Billing.");
  await expect(owner.getByText("The add-on is still on").getByRole("link", { name: "Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "customize-branding-badge-shown-with-add-on");
  await owner.getByLabel('Show "Powered by tuti" in the footer').click();
  await expect(owner.getByText("Hidden with the add-on on this project's plan.")).toBeVisible();
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
  await expect(owner.getByText("Hiding it is an add-on to a paid plan.")).toBeVisible();
  await owner.getByLabel('Show "Powered by tuti" in the footer').click();
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
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "true");
  await checkpoint(owner, "customize-address-free-plan");

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

test("on Tuti's cloud, the widget launcher's icon is locked on the free plan, its colour isn't", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  await owner.goto(`/app/${slug}/settings/widget`);
  await expect(owner.getByText("Choosing the launcher's icon needs the Pro plan.")).toBeVisible();
  await expect(owner.getByRole("radio", { name: "Megaphone" })).toBeDisabled();
  await expect(owner.getByRole("radio", { name: "Chat" })).toBeChecked();
  await owner.getByLabel("Colour", { exact: true }).fill("#5b21b6");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await checkpoint(owner, "widget-settings-icon-locked");
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
