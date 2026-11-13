import { prisma } from "@tuti/db";
import { billingFile, FAKE_STRIPE_KEY, FAKE_STRIPE_WEBHOOK_SECRET } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import BillingSettingsPage from "./page";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
// Each month's AI use, an async server component a static render can't run: not what these tests check.
vi.mock("@/components/usage-months", () => ({ UsageMonths: () => null }));

let slug: string;
let projectId: string;
beforeEach(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", FAKE_STRIPE_KEY);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", FAKE_STRIPE_WEBHOOK_SECRET);
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  ({ slug, id: projectId } = project);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

const billing = async () =>
  renderToStaticMarkup(
    (await BillingSettingsPage({ params: Promise.resolve({ project: slug }), searchParams: Promise.resolve({}) } as PageProps<"/app/[project]/settings/billing">)) as React.ReactElement,
  ).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

test("on the default plan, its own card says so; the plans for sale have Upgrade, one sold by quote neither a price nor Upgrade", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  let page = await billing();
  expect(page.match(/this project's plan/g)).toHaveLength(1);
  expect(page).toContain("$0, this project's plan");
  expect(page).toContain("Upgrade to Pro");
  expect(page).toContain("Upgrade to Business");

  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  page = await billing();
  // By quote: a way to ask, as on the pricing page.
  expect(page).toContain("By quote");
  expect(page).toMatch(/href="mailto:[^"]*"[^>]*>Contact us</);
  expect(page).not.toContain("Upgrade to Business");
  expect(page.match(/this project's plan/g)).toHaveLength(1);
});

test("the add-on's card shows only where it's sold", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(await billing()).toContain('Hide "Powered by tuti"');
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { delete config.badge; }));
  expect(await billing()).not.toContain('Hide "Powered by tuti"');
});

test("a project on a plan sold by quote sees its plan, with no price", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "BUSINESS", planStatus: "active" } });
  const page = await billing();
  expect(page).toContain("Business plan");
  expect(page).not.toContain("Not billed");
});

test("an add-on that's on shows no amount: it may be billed at an older price than the file's", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: projectId }, data: { plan: "PRO", planInterval: "month", planStatus: "active", badgeAddOn: true, stripeSubscriptionId: `sub_${projectId}` } });
  const page = await billing();
  expect(page).toContain("Hidden on this project's plan. It ends with the plan.");
  expect(page).toContain("Show the badge again");
});

test("an add-on that's on keeps its card where it's no longer sold for the plan's billing (sold: false), so it can be removed", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile(({ badge }) => { badge!.year!.sold = false; }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "PRO", planInterval: "year", planStatus: "active", badgeAddOn: true, stripeSubscriptionId: `sub_${projectId}` } });
  const page = await billing();
  expect(page).toContain("Hidden on this project's plan. It ends with the plan.");
  expect(page).toContain("Show the badge again");
  expect(page).not.toContain("Hide the badge");
});
