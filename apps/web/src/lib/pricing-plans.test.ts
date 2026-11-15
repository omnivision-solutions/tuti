import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { planFacts, pricingPlans, pricingTerms } from "./pricing-plans";

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
    "About 50 AI answers for your customers",
    "Or about 2 changes you ship, checked by Autopilot against your help center and feedback",
  ]);
  expect(line("Pro", "1,000 AI credits a month")?.more?.points).toEqual([
    "About 500 AI answers for your customers",
    "Or about 25 changes you ship, checked by Autopilot against your help center and feedback",
  ]);
  expect(line("Business", "5,000 AI credits a month")?.more?.points[1]).toMatch(/^Or about 120 changes/);

  // Too few credits for one checked change (40 credits each here): no "about 0 changes" line, and "1 change" singular.
  vi.stubEnv("AI_CREDITS_FREE", "30");
  expect(line("Free", "30 AI credits")?.more?.points).toEqual(["About 15 AI answers for your customers"]);
  vi.stubEnv("AI_CREDITS_FREE", "50");
  expect(line("Free", "50 AI credits")?.more?.points[1]).toBe("Or about 1 change you ship, checked by Autopilot against your help center and feedback");
  // One answer's worth: "answer" singular; less: the line alone, with no empty card.
  vi.stubEnv("AI_CREDITS_FREE", "2");
  expect(line("Free", "2 AI credits")?.more?.points).toEqual(["About 1 AI answer for your customers"]);
  vi.stubEnv("AI_CREDITS_FREE", "1");
  expect(line("Free", "1 AI credits")).toEqual({ text: "1 AI credits to start" });
  vi.stubEnv("AI_CREDITS_FREE", "100");

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

test("each plan lists how many emails a month it sends its users", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(["Free", "Pro", "Business"].map((plan) => lines(plan).find(({ text }) => text.includes("email"))?.text)).toEqual([
    "1,000 emails a month to your users",
    "10,000 emails a month to your users",
    "No monthly email limit",
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

test("with a free trial, each plan sold starts one at sign-up", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { business }) => {
    config.trial = { plan: "pro", days: 7 };
    business.prices = {};
  }));
  expect(pricingPlans().map(({ cta }) => [cta.label, cta.href.startsWith("mailto:") ? "mailto" : cta.href])).toEqual([
    ["Start free", "/app/auth/sign-up"],
    ["Start free trial", "/app/auth/sign-up"],
    ["Contact us", "mailto"],
  ]);
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
  // The comparison still shows it with AI answers: its credits are agreed with it.
  expect(planFacts()[2]).toMatchObject({ credits: null, aiAnswers: true });
});

test("a hidden plan (a default nobody picks) is left off, and the first plan shown lists everything", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.hidden = true; }));
  const [pro, business] = pricingPlans();
  expect(pricingPlans().map(({ name }) => name)).toEqual(["Pro", "Business"]);
  expect([pro!.intro, pro!.features.some(({ text }) => text === "Unlimited end users")]).toEqual([undefined, true]);
  expect(business!.intro).toBe("Everything in Pro, plus:");
});

test("the pricing page's comparison gets each plan's numbers and features from the billing file", () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.stubEnv("AI_CREDITS_FREE", "");
  vi.stubEnv("AI_CREDITS_PER_USAGE_DOLLAR", "500");
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "");
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7 }; }));
  const [free, pro, business] = planFacts();
  expect(free).toMatchObject({ credits: null, creditsBuy: null, aiAnswers: false, boards: 2, emails: 1000, articles: 50, versions: 2, historyDays: 7, team: 3, extras: [] });
  expect(pro).toMatchObject({ credits: 1000, creditsBuy: { answers: 500, changes: 25 }, aiAnswers: true, boards: 5, team: null, articles: null });
  // Fewer credits than a checked change costs (40 here): no changes estimate; under one answer's worth, no estimate at all.
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => { config.trial = { plan: "pro", days: 7 }; pro.monthlyCredits = 30; }));
  expect(planFacts()[1]!.creditsBuy).toEqual({ answers: 15, changes: null });
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => { config.trial = { plan: "pro", days: 7 }; pro.monthlyCredits = 1; }));
  expect(planFacts()[1]!.creditsBuy).toBeNull();
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7 }; }));
  expect(business).toMatchObject({ credits: 5000, boards: null, emails: null, historyDays: 90, versions: 50, extras: ["Priority support"] });
  // Free has no credits, so Autopilot's checks don't run there either, though its plan lists it.
  expect([free, pro, business].map(({ features }) => [features.customDomain, features.sitePath, features.privatePortal, features.aiTuning, features.codeChanges])).toEqual([
    [false, false, false, false, false],
    [true, false, false, false, true],
    [true, true, true, true, true],
  ]);
  // Email from your domain only where the server offers it, as on the cards.
  expect(business!.features.emailDomain).toBe(false);
  expect(pricingTerms()).toEqual({ badgePerMonth: 49, badgeYearPerMonth: 49, trialDays: 7 });
  // A badge sold yearly only has no monthly price, so the page can say it's billed yearly.
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7 }; delete config.badge!.month; }));
  expect(pricingTerms()).toEqual({ badgePerMonth: null, badgeYearPerMonth: 49, trialDays: 7 });
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7 }; }));

  // A priced default plan's monthly credits bring AI, with no starter credits.
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.defaultPlan = "pro"; }));
  expect(planFacts()[1]).toMatchObject({ credits: 1000, aiAnswers: true, features: { codeChanges: true } });
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7 }; }));

  // Free's starter credits bring its AI answers, and Autopilot with them; it buys no monthly credits.
  vi.stubEnv("AI_CREDITS_FREE", "100");
  expect(planFacts()[0]).toMatchObject({ credits: null, startCredits: 100, aiAnswers: true, features: { codeChanges: true } });

  vi.stubEnv("AI_CREDITS", "");
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => { delete config.badge; pro.extras = ["Onboarding call"]; }));
  expect(planFacts().map(({ credits, aiAnswers, extras }) => [credits, aiAnswers, extras])).toEqual([
    [null, true, []],
    [null, true, ["Onboarding call"]],
    [null, true, ["Onboarding call", "Priority support"]],
  ]);
  expect(pricingTerms()).toEqual({ badgePerMonth: null, badgeYearPerMonth: null, trialDays: null });
});
