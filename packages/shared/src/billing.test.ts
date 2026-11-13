import { readFileSync } from "node:fs";
import { join } from "node:path";

import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { billingConfig, billingSchema } from "./billing";

afterEach(() => vi.unstubAllEnvs());

test("billing.schema.json is the schema's (pnpm test -u rewrites it)", async () => {
  await expect(`${JSON.stringify(z.toJSONSchema(billingSchema, { io: "input", unrepresentable: "any" }), null, 2)}\n`).toMatchFileSnapshot("../billing.schema.json");
});

test("the example file is valid, and the test file is too", () => {
  billingSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../billing.example.json"), "utf8")));
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(billingConfig()?.plans.map(({ key }) => key)).toEqual(["free", "pro", "business"]);
});

test("an invalid file stops the server, naming what's wrong", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => {
    config.defaultPlan = "starter";
    pro.limits.boards = -1;
    pro.prices.month!.stripe = pro.prices.year!.stripe;
  }));
  expect(() => billingConfig()).toThrow(/"starter" isn't one of the plans\n {2}→ at defaultPlan/);
  expect(() => billingConfig()).toThrow(/plans\[1\]\.limits\.boards/);
  expect(() => billingConfig()).toThrow(/is listed twice/);
});

test("the default plan is free while projects store the database's plans", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.defaultPlan = "pro"; }));
  expect(() => billingConfig()).toThrow(/must be free for now\n {2}→ at defaultPlan/);
});

test("the settings the file replaced, left without one, stop the server rather than turn billing off", () => {
  vi.stubEnv("BILLING_CONFIG", "");
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro");
  expect(() => billingConfig()).toThrow("PLANS, STRIPE_PRICE_PRO_MONTHLY are set, but plans and the \"Powered by tuti\" add-on (licences too) are now sold from the file at BILLING_CONFIG");
  // Any other PLANS was billing off, as no file is.
  vi.stubEnv("PLANS", "off");
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "");
  expect(billingConfig()).toBeNull();
});

test("each plan has everything the one before it has, as its card says", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => {
    business.features = business.features.filter((feature) => feature !== "emailDomain");
    business.limits.boards = 3;
  }));
  expect(() => billingConfig()).toThrow(/lacks emailDomain, which pro has[\s\S]*plans\[2\]\.features/);
  expect(() => billingConfig()).toThrow(/is lower than pro's\n {2}→ at plans\[2\]\.limits\.boards/);
});

test("prices are whole dollars", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.prices.month!.perMonth = 8.33; }));
  expect(() => billingConfig()).toThrow(/plans\[1\]\.prices\.month\.perMonth/);
});

test("a plan's Reporting range is no shorter than the plan before it's, counted only where a plan has Reporting", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro, business }) => {
    pro.limits.reportingDays = 90;
    business.limits.reportingDays = 31;
  }));
  expect(() => billingConfig()).toThrow(/is lower than pro's\n {2}→ at plans\[2\]\.limits\.reportingDays/);
  // Free has no Reporting: its range counts as none, so a Pro with 7 days still has more.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.limits.reportingDays = 7; }));
  expect(billingConfig()?.plans[1]?.limits.reportingDays).toBe(7);
});
