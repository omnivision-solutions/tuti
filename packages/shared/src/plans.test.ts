import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { articleLimit, articleVersionsKept, badgeOffered, badgePerMonth, articleVersionsNote, articleVersionsStored, badgePrice, boardLimit, historyDays, historyKeptDays, isBadgePrice, longestHistoryDays, planCredits, planDisplay, planFor, planIncludes, planNeeded, planOfPrice, planPrice, plansWith, reportingDays, reportingRangeNeeded, roomierPlan, teamLimit, trialState, trialTerms, upgradeFor, effectivePlan } from "./plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("without a billing file (self-hosted), every project has everything, and nothing is sold", () => {
  vi.stubEnv("BILLING_CONFIG", "");
  expect(planIncludes("free", "privatePortal")).toBe(true);
  expect([teamLimit("free"), boardLimit("free"), articleLimit("free"), historyDays("free"), reportingDays("free")]).toEqual([null, null, null, null, null]);
  expect([planPrice("pro", "month"), badgePrice("month"), planCredits("pro"), plansWith("customDomain")]).toEqual([null, null, 0, null]);
  expect([articleVersionsKept("free"), articleVersionsStored(), historyKeptDays()]).toEqual([50, 50, null]);
});

test("a path to a file that can't be read stops it, never billing off", () => {
  vi.stubEnv("BILLING_CONFIG", "/nonexistent/billing.json");
  expect(() => planIncludes("free", "privatePortal")).toThrow(/BILLING_CONFIG \(\/nonexistent\/billing.json\) can't be read/);
});

test("each plan's features and limits are the file's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const features = ["customDomain", "codeChanges", "privatePortal", "sitePath"] as const;
  expect(features.map((feature) => planIncludes("free", feature))).toEqual([false, true, false, false]);
  expect(features.map((feature) => planIncludes("pro", feature))).toEqual([true, true, false, false]);
  expect(features.map((feature) => planIncludes("business", feature))).toEqual([true, true, true, true]);
  expect(plansWith("privatePortal")).toEqual({ keys: ["business"], orDefault: false, listed: ["free", "pro", "business"] });
  // None stored is the default plan's.
  expect([teamLimit(null), planIncludes(null, "codeChanges"), planIncludes(null, "customDomain")]).toEqual([3, true, false]);
  expect([teamLimit("free"), teamLimit("pro"), teamLimit("business")]).toEqual([3, null, null]);
  expect([boardLimit("free"), boardLimit("pro"), boardLimit("business")]).toEqual([2, 5, null]);
  expect([articleLimit("free"), articleLimit("pro"), articleLimit("business")]).toEqual([50, null, null]);
  expect([planCredits("free"), planCredits("pro"), planCredits("business")]).toEqual([0, 1000, 5000]);
  expect(features.map((feature) => planFor(feature)?.name ?? null)).toEqual(["Pro", "Pro", "Business", "Business"]);
});

test("a plan the file doesn't list gets the default plan's terms, and isn't sold", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    config.plans = config.plans.filter(({ key }) => key !== "business");
  }));
  expect([planIncludes("business", "privatePortal"), boardLimit("business"), planPrice("business", "month")]).toEqual([false, 2, null]);
  expect(plansWith("codeChanges")).toEqual({ keys: ["free", "pro"], orDefault: true, listed: ["free", "pro"] });
  // Shown as the plan it gets.
  expect(planDisplay("business")).toEqual({ name: "Free", price: { month: null, year: null } });
});

test("a plan's Stripe prices: the first is sold, older ones still recognised; the add-on's likewise", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => {
    pro.prices.month!.stripe = ["price_new", "price_old"];
    config.badge = { month: { perMonth: 49, stripe: ["price_badge"] }, year: { perMonth: 39, stripe: ["price_badge_yearly"] } };
  }));
  expect([planPrice("pro", "month"), planPrice("free", "month")]).toEqual(["price_new", null]);
  expect([planOfPrice("price_new"), planOfPrice("price_old"), planOfPrice("price_other")]).toEqual([
    { plan: "pro", interval: "month" },
    { plan: "pro", interval: "month" },
    null,
  ]);
  expect([badgePrice("month"), badgePrice("year"), isBadgePrice("price_badge"), isBadgePrice("price_new")]).toEqual(["price_badge", "price_badge_yearly", true, false]);
  // What it shows a month: each billing's own, or monthly's before a plan is picked.
  expect([badgePerMonth("month"), badgePerMonth("year"), badgePerMonth()]).toEqual([49, 39, 49]);
  // For a project: its plan's billing, or on the default plan what it starts at.
  expect([badgeOffered({ planStatus: "active", planInterval: "year" }), badgeOffered({ planStatus: "active", planInterval: "month" }), badgeOffered({ planStatus: null, planInterval: null })]).toEqual([39, 49, 49]);
});

test("upgrades name the first plan above with more room, and none where no plan has more", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect([roomierPlan("free", boardLimit)?.name, roomierPlan("pro", boardLimit)?.name, roomierPlan("business", boardLimit)]).toEqual(["Pro", "Business", null]);
  expect(roomierPlan("free", teamLimit)?.name).toBe("Pro");
  expect(upgradeFor("free", teamLimit, " to invite more.")).toBe("Upgrade to Pro to invite more.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.boards = 2; }));
  expect(roomierPlan("free", boardLimit)?.name).toBe("Business");
  expect(upgradeFor("business", boardLimit, " to add more.", "none")).toBe("none");
});

test("history: by plan, kept for historyKeptDays, never less than the longest plan's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect([historyDays("free"), historyDays("pro"), historyDays("business"), longestHistoryDays(), historyKeptDays()]).toEqual([7, 30, 90, 90, 365]);
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { business }) => {
    business.limits.historyDays = 400;
    config.historyKeptDays = 400;
  }));
  expect([longestHistoryDays(), historyKeptDays()]).toEqual([400, 400]);
});

test("versions kept per article: by plan, and stored up to the largest plan's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => { pro.limits.articleVersions = 80; business.limits.articleVersions = 80; }));
  expect([articleVersionsKept("free"), articleVersionsKept("pro"), articleVersionsKept("business"), articleVersionsStored()]).toEqual([2, 80, 80, 80]);
  expect(articleVersionsNote("free")).toBe("The latest 2 are kept.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.articleVersions = 1; }));
  expect(articleVersionsNote("free")).toBe("Only the latest is kept.");
});

test("Reporting: by plan, and what's needed is named from the file", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect((["free", "pro", "business"] as const).map((plan) => [planIncludes(plan, "reporting"), reportingDays(plan)])).toEqual([
    [false, 31],
    [true, 31],
    [true, null],
  ]);
  expect([planNeeded("reporting"), reportingRangeNeeded("pro"), reportingRangeNeeded("business")]).toEqual([
    "Reporting needs the Pro plan.",
    "Longer ranges need the Business plan.",
    "Your plan doesn't include longer ranges.",
  ]);
  // A longer range that isn't every range still counts.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.limits.reportingDays = 365; }));
  expect(reportingRangeNeeded("pro")).toBe("Longer ranges need the Business plan.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => {
    pro.name = "Growth";
    business.features = business.features.filter((feature) => feature !== "aiTuning");
  }));
  expect([planNeeded("reporting"), planNeeded("aiTuning")]).toEqual(["Reporting needs the Growth plan.", "Advanced tuning needs a plan this server doesn't sell."]);
});

test("upgrades never name a plan that isn't sold (no prices: by quote)", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  expect([roomierPlan("pro", boardLimit), planFor("privatePortal"), planFor("customDomain")?.name]).toEqual([null, null, "Pro"]);
  expect(reportingRangeNeeded("pro")).toBe("Your plan doesn't include longer ranges.");
  expect(planNeeded("sitePath")).toBe("A portal under a path of your site needs a plan this server doesn't sell.");
});

test("a price no longer sold is recognised but neither sold nor shown, and a plan with none sold is by quote", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro, business }) => {
    pro.prices.year!.sold = false;
    business.prices.month!.sold = false;
    business.prices.year!.sold = false;
    config.badge!.year!.sold = false;
  }));
  expect([planPrice("pro", "year"), planOfPrice("price_fake_pro_yearly")]).toEqual([null, { plan: "pro", interval: "year" }]);
  expect(planDisplay("pro").price).toEqual({ month: 39, year: null });
  expect([badgePrice("year"), isBadgePrice("price_fake_badge_yearly"), badgePerMonth("year")]).toEqual([null, true, null]);
  expect([planFor("privatePortal"), roomierPlan("pro", boardLimit)]).toEqual([null, null]);
});

test("a trial's plan holds until it ends, only on the default plan, and never after", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const later = new Date("2026-11-20T12:00:00Z");
  vi.stubEnv("BILLING_CONFIG", billingFile());
  // No trial in the file: none given, whatever is stored.
  expect([trialTerms(), effectivePlan(null, later, now)]).toEqual([null, null]);
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    config.trial = { plan: "business", days: 7, credits: 500, emails: 1000 };
  }));
  expect(trialTerms()).toEqual({ plan: "business", days: 7, credits: 500, emails: 1000 });
  expect([effectivePlan(null, later, now), effectivePlan("free", later, now), effectivePlan(null, null, now)]).toEqual(["business", "business", null]);
  // Ended: the plan stored, at once.
  expect([effectivePlan(null, now, now), effectivePlan(null, later, later)]).toEqual([null, null]);
  // A plan of its own wins.
  expect(effectivePlan("pro", later, now)).toBe("pro");
  expect(trialState({ plan: null, planStatus: null, trialEndsAt: later }, now)).toEqual({ endsAt: later, ended: false });
  expect(trialState({ plan: null, planStatus: null, trialEndsAt: now }, now)).toEqual({ endsAt: now, ended: true });
  expect([trialState({ plan: null, planStatus: null, trialEndsAt: null }, now), trialState({ plan: "pro", planStatus: "active", trialEndsAt: later }, now)]).toEqual([null, null]);
  // The file stops offering a trial: a project mid-trial isn't told it ended (it just has no trial).
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(trialState({ plan: null, planStatus: null, trialEndsAt: later }, now)).toBeNull();
  // Billing off: no trials, every project has everything.
  vi.stubEnv("BILLING_CONFIG", "");
  expect([trialTerms(), effectivePlan(null, later, now), trialState({ plan: null, planStatus: null, trialEndsAt: later }, now)]).toEqual([null, null, null]);
});
