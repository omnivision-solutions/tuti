import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { articleLimit, articleVersionsKept, articleVersionsNote, articleVersionsStored, badgePrice, boardLimit, historyDays, historyKeptDays, isBadgePrice, longestHistoryDays, planCredits, planDisplay, planFor, planIncludes, planNeeded, planOfPrice, planPrice, plansWith, reportingDays, reportingRangeNeeded, roomierPlan, teamLimit, upgradeFor } from "./plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("without a billing file (self-hosted), every project has everything, and nothing is sold", () => {
  vi.stubEnv("BILLING_CONFIG", "");
  expect(planIncludes("FREE", "privatePortal")).toBe(true);
  expect([teamLimit("FREE"), boardLimit("FREE"), articleLimit("FREE"), historyDays("FREE"), reportingDays("FREE")]).toEqual([null, null, null, null, null]);
  expect([planPrice("PRO", "month"), badgePrice("month"), planCredits("PRO"), plansWith("customDomain")]).toEqual([null, null, 0, null]);
  expect([articleVersionsKept("FREE"), articleVersionsStored(), historyKeptDays()]).toEqual([50, 50, null]);
});

test("a path to a missing file is billing off too", () => {
  vi.stubEnv("BILLING_CONFIG", "/nonexistent/billing.json");
  expect(planIncludes("FREE", "privatePortal")).toBe(true);
});

test("each plan's features and limits are the file's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const features = ["customDomain", "codeChanges", "privatePortal", "sitePath"] as const;
  expect(features.map((feature) => planIncludes("FREE", feature))).toEqual([false, true, false, false]);
  expect(features.map((feature) => planIncludes("PRO", feature))).toEqual([true, true, false, false]);
  expect(features.map((feature) => planIncludes("BUSINESS", feature))).toEqual([true, true, true, true]);
  expect(plansWith("privatePortal")).toEqual(["BUSINESS"]);
  expect([teamLimit("FREE"), teamLimit("PRO"), teamLimit("BUSINESS")]).toEqual([3, null, null]);
  expect([boardLimit("FREE"), boardLimit("PRO"), boardLimit("BUSINESS")]).toEqual([2, 5, null]);
  expect([articleLimit("FREE"), articleLimit("PRO"), articleLimit("BUSINESS")]).toEqual([50, null, null]);
  expect([planCredits("FREE"), planCredits("PRO"), planCredits("BUSINESS")]).toEqual([0, 1000, 5000]);
  expect(features.map((feature) => planFor(feature)?.name ?? null)).toEqual(["Pro", "Pro", "Business", "Business"]);
});

test("a plan the file doesn't list gets the default plan's terms, and isn't sold", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    config.plans = config.plans.filter(({ key }) => key !== "business");
  }));
  expect([planIncludes("BUSINESS", "privatePortal"), boardLimit("BUSINESS"), planPrice("BUSINESS", "month")]).toEqual([false, 2, null]);
  expect(plansWith("codeChanges")).toEqual(["FREE", "PRO", "BUSINESS"]);
  expect(planDisplay("BUSINESS")).toEqual({ name: "Business", price: { month: null, year: null } });
});

test("a plan's Stripe prices: the first is sold, older ones still recognised; the add-on's likewise", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => {
    pro.prices.month!.stripe = ["price_new", "price_old"];
    config.badge = { month: { perMonth: 49, stripe: ["price_badge"] } };
  }));
  expect([planPrice("PRO", "month"), planPrice("FREE", "month")]).toEqual(["price_new", null]);
  expect([planOfPrice("price_new"), planOfPrice("price_old"), planOfPrice("price_other")]).toEqual([
    { plan: "PRO", interval: "month" },
    { plan: "PRO", interval: "month" },
    null,
  ]);
  expect([badgePrice("month"), badgePrice("year"), isBadgePrice("price_badge"), isBadgePrice("price_new")]).toEqual(["price_badge", null, true, false]);
});

test("upgrades name the first plan above with more room, and none where no plan has more", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect([roomierPlan("FREE", boardLimit)?.name, roomierPlan("PRO", boardLimit)?.name, roomierPlan("BUSINESS", boardLimit)]).toEqual(["Pro", "Business", null]);
  expect(roomierPlan("FREE", teamLimit)?.name).toBe("Pro");
  expect(upgradeFor("FREE", teamLimit, " to invite more.")).toBe("Upgrade to Pro to invite more.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.boards = 2; }));
  expect(roomierPlan("FREE", boardLimit)?.name).toBe("Business");
  expect(upgradeFor("BUSINESS", boardLimit, " to add more.", "none")).toBe("none");
});

test("history: by plan, kept for historyKeptDays, never less than the longest plan's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect([historyDays("FREE"), historyDays("PRO"), historyDays("BUSINESS"), longestHistoryDays(), historyKeptDays()]).toEqual([7, 30, 90, 90, 365]);
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { business }) => {
    business.limits.historyDays = 400;
    config.historyKeptDays = 30;
  }));
  expect([longestHistoryDays(), historyKeptDays()]).toEqual([400, 400]);
});

test("versions kept per article: by plan, and stored up to the largest plan's", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.articleVersions = 80; }));
  expect([articleVersionsKept("FREE"), articleVersionsKept("PRO"), articleVersionsKept("BUSINESS"), articleVersionsStored()]).toEqual([2, 80, 50, 80]);
  expect(articleVersionsNote("FREE")).toBe("The latest 2 are kept.");
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.articleVersions = 1; }));
  expect(articleVersionsNote("FREE")).toBe("Only the latest is kept.");
});

test("Reporting: by plan, and what's needed is named from the file", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect((["FREE", "PRO", "BUSINESS"] as const).map((plan) => [planIncludes(plan, "reporting"), reportingDays(plan)])).toEqual([
    [false, 31],
    [true, 31],
    [true, null],
  ]);
  expect([planNeeded("reporting"), reportingRangeNeeded()]).toEqual(["Reporting needs the Pro plan.", "Longer ranges need the Business plan."]);
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => {
    pro.name = "Growth";
    business.features = business.features.filter((feature) => feature !== "aiTuning");
  }));
  expect([planNeeded("reporting"), planNeeded("aiTuning")]).toEqual(["Reporting needs the Growth plan.", "Advanced tuning needs a plan this server doesn't sell."]);
});
