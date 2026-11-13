import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { pricingPlans } from "./pricing-plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

const lines = (plan: string) => pricingPlans().flatMap(({ name, highlights, features }) => (name === plan ? [...highlights, ...features] : []));
const line = (plan: string, start: string) => lines(plan).find(({ text }) => text.startsWith(start));

test("AI credits say what they buy, at the server's credit rate", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "100");
  vi.stubEnv("AI_CREDITS_PER_USAGE_DOLLAR", "500");
  // Without Stripe, no top-ups: the cards list only what credits buy.
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  expect(line("Free", "100 AI credits")?.more?.points).toEqual([
    "About 200 AI answers for your customers",
    "Or about 40 changes you ship, checked by Autopilot against your help center and feedback",
  ]);
  expect(line("Pro", "1,000 AI credits a month")?.more?.points).toEqual([
    "About 2,000 AI answers for your customers",
    "Or about 400 changes you ship, checked by Autopilot against your help center and feedback",
  ]);
  expect(line("Business", "5,000 AI credits a month")?.more?.points[1]).toMatch(/^Or about 2,000 changes/);

  // With Stripe, credits can be topped up, and the card says so.
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  expect(line("Pro", "1,000 AI credits a month")?.more?.points.at(-1)).toBe("Need more? Top up any time.");

  vi.stubEnv("AI_CREDITS", "");
  expect(line("Pro", "1,000 AI credits")).toBeUndefined();
});

test("each plan lists its boards, and Autopilot where the plan includes it", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(["Free", "Pro", "Business"].map((plan) => line(plan, "Up to")?.text ?? line(plan, "Unlimited boards")?.text)).toEqual([
    "Up to 2 boards",
    "Up to 5 boards",
    "Unlimited boards",
  ]);
  expect(["Free", "Pro"].map((plan) => line(plan, "Up to 50")?.text ?? line(plan, "Unlimited articles")?.text)).toEqual(["Up to 50 published articles", "Unlimited articles"]);
  // Business has everything in Pro: its own line only where the operator sets it a limit.
  expect(lines("Business").some(({ text }) => text.endsWith("articles"))).toBe(false);
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => { pro.limits.articles = 100; business.limits.articles = 200; }));
  expect(line("Business", "Up to 200")?.text).toBe("Up to 200 published articles");
  expect(["Free", "Pro", "Business"].map((plan) => Boolean(line(plan, "Autopilot")?.more))).toEqual([true, true, true]);
  // Listed first on each plan, not under "Everything in Free, plus:", as every plan has it.
  expect(pricingPlans().map(({ highlights, features }) => [highlights[0]?.text, features.some(({ text }) => text === "Autopilot")])).toEqual([
    ["Autopilot", false],
    ["Autopilot", false],
    ["Autopilot", false],
  ]);
});

test("each plan says how many days of inbox history it shows, as the server sets them", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.historyDays = 45; }));
  expect(["Free", "Pro", "Business"].map((plan) => lines(plan).find(({ text }) => text.endsWith("of inbox history"))?.text)).toEqual([
    "7 days of inbox history",
    "45 days of inbox history",
    "90 days of inbox history",
  ]);
});

test("each plan lists how many versions of a help article it keeps", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free, pro }) => { free.limits.articleVersions = 1; pro.limits.articleVersions = 10; }));
  expect(["Free", "Pro", "Business"].map((plan) => lines(plan).find(({ text }) => text.includes("kept per help article"))?.text)).toEqual([
    "1 version kept per help article",
    "10 versions kept per help article",
    "50 versions kept per help article",
  ]);
});

test("Pro lists Reporting up to a month, Business every range, Free none", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(["Free", "Pro", "Business"].map((plan) => line(plan, "Reporting")?.text)).toEqual([undefined, "Reporting, up to a month", "Reporting, every range"]);
});

test("Pro lists email from your own domain where the server offers it (support email and SES)", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  for (const name of ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_CONFIGURATION_SET", "SES_EVENTS_TOPIC_ARN", "SUPPORT_EMAIL_DOMAIN"]) {
    vi.stubEnv(name, "");
  }
  const texts = (plan: string) => lines(plan).map(({ text }) => text);
  expect(texts("Pro")).not.toContain("Email from your own domain");

  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "mail.example.com");
  vi.stubEnv("SES_REGION", "us-east-1");
  vi.stubEnv("SES_ACCESS_KEY_ID", "test");
  vi.stubEnv("SES_SECRET_ACCESS_KEY", "test");
  vi.stubEnv("SES_CONFIGURATION_SET", "tuti");
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", "arn:aws:sns:us-east-1:000000000000:tuti");
  expect(texts("Pro")).toContain("Email from your own domain");
  expect(texts("Free")).not.toContain("Email from your own domain");
});

test("names, prices and team sizes come from the billing file", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free, pro }) => {
    free.name = "Starter";
    free.limits.seats = 1;
    pro.name = "Growth";
    pro.prices = { year: { perMonth: 60, stripe: ["price_growth_yearly"] } };
  }));
  const [starter, growth, business] = pricingPlans();
  expect([starter!.name, starter!.price, starter!.features[1]?.text]).toEqual(["Starter", null, "1 team member"]);
  // Sold yearly only: no monthly price.
  expect([growth!.name, growth!.price, growth!.intro, growth!.cta.label]).toEqual(["Growth", { month: null, year: 60 }, "Everything in Starter, plus:", "Start with Growth"]);
  expect(business!.intro).toBe("Everything in Growth, plus:");
});

test("the cards are the file's plans, each listing what the file gives it", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => {
    config.plans = config.plans.filter(({ key }) => key !== "business");
    pro.features = pro.features.filter((feature) => feature !== "customDomain");
    pro.limits.reportingDays = 90;
    pro.extras = ["Onboarding call"];
  }));
  expect(pricingPlans().map(({ key, name }) => [key, name])).toEqual([
    ["free", "Free"],
    ["pro", "Pro"],
  ]);
  const pro = lines("Pro").map(({ text }) => text);
  expect(pro).not.toContain("Your own domain");
  expect(pro).toContain("Reporting, up to 90 days");
  expect(pro.at(-1)).toBe("Onboarding call");
  expect(pricingPlans().map(({ featured }) => Boolean(featured))).toEqual([false, true]);
});

test("a plan without prices is free where it's the default, and otherwise by quote, asking to get in touch", () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  const [free, , business] = pricingPlans();
  expect([free!.price, free!.byQuote, free!.cta.label]).toEqual([null, undefined, "Start free"]);
  expect([business!.price, business!.byQuote, business!.cta.label]).toEqual([null, true, "Contact us"]);
  expect(business!.cta.href).toMatch(/^mailto:/);
  // Its credits would come with paid invoices, which it has none of.
  expect(business!.highlights.some(({ text }) => text.includes("AI credits"))).toBe(false);
});

test("a hidden plan (a default nobody picks) is left off, and the first plan shown lists everything", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.hidden = true; }));
  const [pro, business] = pricingPlans();
  expect(pricingPlans().map(({ name }) => name)).toEqual(["Pro", "Business"]);
  expect([pro!.intro, pro!.features.some(({ text }) => text === "Unlimited end users")]).toEqual([undefined, true]);
  expect(business!.intro).toBe("Everything in Pro, plus:");
});
