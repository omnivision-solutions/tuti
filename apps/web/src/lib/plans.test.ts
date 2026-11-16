import { expect, test } from "vitest";

import { billedAs, licenseBilling, planPriceText, yearlyNote } from "./plans";

test("tuti.so/app/license describes only the billing it sells", () => {
  expect(licenseBilling(49, { month: true, year: true })).toEqual({ price: "$49 a month", billed: "each month or each year" });
  expect(licenseBilling(49, { month: true, year: false })).toEqual({ price: "$49 a month", billed: "each month" });
  expect(licenseBilling(49, { month: false, year: true })).toEqual({ price: "$49 a month, billed yearly", billed: "each year" });
});

test("a plan's price, monthly or yearly, and none where it isn't sold that way", () => {
  expect([planPriceText({ month: 39, year: 32 }, "month"), planPriceText({ month: 39, year: 32 }, "year")]).toEqual(["$39 a month", "$32 a month, billed yearly"]);
  expect(planPriceText({ month: null, year: 60 }, "month")).toBe("Not billed monthly");
  expect([yearlyNote([{ month: 39, year: 32 }, { month: 99, year: 79 }]), yearlyNote([{ month: 39, year: null }])]).toEqual(["Save up to 20%", null]);
});

test("a plan sold only one way is billed that way, whichever way is picked", () => {
  expect([billedAs({ month: 39, year: 32 }, "month"), billedAs({ month: 39, year: 32 }, "year")]).toEqual(["month", "year"]);
  expect([billedAs({ month: 39, year: null }, "year"), billedAs({ month: null, year: 32 }, "month")]).toEqual(["month", "year"]);
  expect([billedAs(null, "month"), billedAs({ month: null, year: null }, "year")]).toEqual([null, null]);
});
