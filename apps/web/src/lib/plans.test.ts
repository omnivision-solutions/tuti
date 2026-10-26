import { expect, test } from "vitest";

import { licenseBilling } from "./plans";

test("tuti.so/license describes only the billing it sells", () => {
  expect(licenseBilling({ month: true, year: true })).toEqual({ price: "$49 a month", billed: "each month or each year" });
  expect(licenseBilling({ month: true, year: false })).toEqual({ price: "$49 a month", billed: "each month" });
  expect(licenseBilling({ month: false, year: true })).toEqual({ price: "$49 a month, billed yearly", billed: "each year" });
});
