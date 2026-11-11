import { randomUUID } from "node:crypto";

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
  // Picked with the keyboard too (native radios): Yearly, then back.
  await owner.getByRole("radio", { name: "Monthly" }).focus();
  await owner.keyboard.press("ArrowRight");
  await expect(owner.getByRole("radio", { name: "Yearly" })).toBeChecked();
  await expect(owner.getByText("$32 a month, billed yearly")).toBeVisible();
  // What yearly saves, as on the pricing page.
  await expect(owner.getByText("Save up to 20%")).toBeVisible();
  await owner.getByText("Monthly", { exact: true }).click();
  await expect(owner.getByText("$39 a month", { exact: true })).toBeVisible();
  // Free beside Pro and Business, each with what it includes, as on the pricing page; Pro's button is the page's one primary.
  await expect(owner.getByText("3 team members")).toBeVisible();
  await expect(owner.getByText("Unlimited team members")).toBeVisible();
  await expect(owner.getByText("A private help center")).toBeVisible();
  await expect(owner.getByText("Email from your own domain")).toBeVisible();
  await expect(owner.getByText("2 versions kept per help article")).toBeVisible();
  const primary = await owner.getByRole("main").locator('[data-slot="button"]').evaluateAll((buttons) =>
    buttons.filter((button) => button.className.includes("bg-primary ")).map((button) => button.textContent),
  );
  expect(primary).toEqual(["Upgrade to Pro"]);
  // The badge's card has a way to it on the free plan too: to the plans, billed as picked there.
  await expect(owner.getByRole("link", { name: "Choose a plan" })).toHaveAttribute("href", "#plans");
  await checkpoint(owner, "team-settings-billing-free-plan");
  await owner.getByRole("button", { name: "Upgrade to Pro" }).click();

  // Stripe's page (the fake), then back to Billing on Pro, with its credits for the month.
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);
  await expect(owner.getByText("Pro plan", { exact: true })).toBeVisible();
  await expect(owner.getByText(/^\$39 a month · Renews on /)).toBeVisible();
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Plan/ })).toContainText("1,000");
  await checkpoint(owner, "team-settings-billing-pro-plan");

  // The "Powered by tuti" add-on: added to the plan, the badge is gone from the portal.
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  const confirm = owner.getByRole("alertdialog", { name: 'Hide "Powered by tuti"?' });
  await expect(confirm).toContainText("$49 a month is added to this project's plan.");
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await expect(owner.getByText('"Powered by tuti" is hidden')).toBeVisible();
  await expect(owner.getByText("Hidden: $49 a month on this project's plan. It ends with the plan.")).toBeVisible();
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
  await expect(owner.getByText(/^\$39 a month · Ends on /)).toBeVisible();
});

test("on Tuti's cloud, hiding \"Powered by tuti\" on the free plan points to Billing, where paid plans can add it", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await expect(owner.getByText("Hiding it is an add-on to a paid plan.")).toBeVisible();
  await owner.getByLabel('Show "Powered by tuti" in the footer').click();
  const dialog = owner.getByRole("dialog", { name: 'Keep "Powered by tuti"?' });
  await expect(dialog).toContainText("add it to its plan in Billing: $49 a month, on Pro or Business.");
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
  await expect(owner.getByText("Projects on the Free plan have up to 3 team members, invites included (1 now)")).toBeVisible();
  const invite = async (email: string) => {
    await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(email);
    await owner.getByRole("button", { name: "Send invite" }).click();
  };
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

  // A domain of its own is on Pro, a path of the team's site on Business.
  await owner.goto(`/app/${slug}/customize/address`);
  const options = owner.getByRole("radiogroup", { name: "Where your portal goes live" });
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toContainText("A custom domain needs the Pro plan.");
  await expect(options.getByRole("radio", { name: /Sub-folder/ })).toContainText("A portal under a path of your site needs the Business plan.");
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "true");
  await checkpoint(owner, "customize-address-free-plan");

  // A private portal and reader groups are on Business.
  await owner.goto(`/app/${slug}/settings/access`);
  await expect(owner.getByRole("alert").filter({ hasText: "A private portal and reader groups need the Business plan." })).toHaveText(
    "A private portal and reader groups need the Business plan. Without it, a private portal and content for reader groups are your team's only. Your settings are kept. See Billing",
  );
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("A private portal and reader groups need the Business plan. See Settings → Billing.", { exact: true })).toBeVisible();
  await checkpoint(owner, "settings-access-free-plan");
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

  await owner.goto(`/app/${slug}/customize/widget`);
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
  await expect(owner.getByRole("heading", { name: "See how your help center, AI and inbox are doing" })).toBeVisible();
  await expect(owner.getByText("Reporting needs the Pro plan.")).toBeVisible();
  // The page behind it (made-up numbers) is out of reach.
  await expect(owner.getByRole("group", { name: "Article views" })).toHaveCount(0);
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
  await expect(owner.getByText("Ranges longer than a month need the Business plan.")).toBeVisible();
  await checkpoint(owner, "team-reporting-pro-ranges", { fullPage: false });
  await owner.getByRole("menuitem", { name: "Last month" }).click();
  await owner.waitForURL(`**/app/${slug}/reporting?range=last-month`);
  await expect(owner.getByRole("button", { name: "Date range: Last month" })).toBeVisible();
});

test("on Tuti's cloud, signing up (or continuing with Google or GitHub from sign-in) agrees to the Terms of Service and Privacy Policy, linked there and in the footer; a self-hosted server has neither the line nor the links", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const page = await browser.newPage({ baseURL: CLOUD_URL });
  await page.goto("/app/auth/sign-up");
  await expect(page.getByText("By signing up, you agree to the Terms of Service and Privacy Policy.")).toBeVisible();
  await checkpoint(page, "sign-up-terms");
  // Sign-in's Continue with Google or GitHub signs up someone new, so it says so too.
  await page.goto("/app/auth/sign-in");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("By continuing, you agree to the Terms of Service and Privacy Policy.")).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Terms of Service" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await checkpoint(page, "terms");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await checkpoint(page, "privacy");

  const selfHosted = await browser.newPage({ baseURL: APP_URL });
  await selfHosted.goto("/app/auth/sign-up");
  await expect(selfHosted.getByRole("button", { name: "Sign up" })).toBeVisible();
  await expect(selfHosted.getByText("By signing up")).toHaveCount(0);
  await selfHosted.goto("/app/auth/sign-in");
  await expect(selfHosted.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(selfHosted.getByText("By continuing")).toHaveCount(0);
  await selfHosted.goto("/");
  await expect(selfHosted.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Terms" })).toHaveCount(0);
});

test("Tuti's cloud's home page has a pricing section; a self-hosted server's has none", async ({ browser }) => {
  const cloud = await browser.newPage({ baseURL: CLOUD_URL });
  await cloud.goto("/");
  await expect(cloud.getByRole("heading", { name: /Free to start/ })).toBeVisible();
  const own = await browser.newPage({ baseURL: APP_URL });
  await own.goto("/");
  await expect(own.getByRole("heading", { level: 1 })).toContainText("in sync with your code");
  await expect(own.getByRole("heading", { name: /Free to start/ })).toHaveCount(0);
});
