// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import type { PlanFacts, PricingPlan } from "@/lib/pricing-plans";

const subscribe = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/server/credits", () => ({ subscribe, manageSubscription: vi.fn(), setBadge: vi.fn() }));
vi.mock("@/server/plan-licenses", () => ({ unassignPlanLicense: vi.fn() }));

const { PlanPicker } = await import("./plan-picker");

const facts: PlanFacts = {
  credits: 1000,
  startCredits: null,
  creditsBuy: null,
  articles: null,
  versions: 5,
  boards: 5,
  emails: 10_000,
  historyDays: 30,
  team: null,
  aiAnswers: true,
  features: { customDomain: true, sitePath: false, privatePortal: false, codeChanges: true, aiTuning: false, emailDomain: false },
  extras: [],
};
const plan = (key: string, price: PricingPlan["price"]): PricingPlan & { facts: PlanFacts } => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  price,
  highlights: [],
  features: [],
  cta: { label: "Start", href: "/app/auth/sign-up" },
  facts,
});

test("a plan sold only yearly is bought yearly while Monthly is picked", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    createRoot(root).render(h(PlanPicker, { projectSlug: "acme", current: "free", pricingPage: null, plans: [plan("free", null), plan("pro", { month: null, year: 32 })] }));
  });
  expect(root.querySelector<HTMLInputElement>('input[value="month"]')?.checked).toBe(true);
  const upgrade = [...root.querySelectorAll("button")].find((button) => button.textContent === "Upgrade to Pro")!;
  await act(async () => upgrade.click());
  expect(subscribe).toHaveBeenCalledWith("acme", "pro", "year");
});

test("a plan's numbers read as one line each, in lower case after the number like the others: 1,000 credits a month", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    createRoot(root).render(h(PlanPicker, { projectSlug: "acme", current: "free", pricingPage: null, plans: [plan("free", null), plan("pro", { month: 39, year: 32 })] }));
  });
  const labels = [...root.querySelectorAll("dt")].map((dt) => dt.textContent);
  expect(labels).toContain("credits a month");
  expect(labels).not.toContain("Credits a month");
});
