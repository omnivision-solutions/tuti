import { expect, test } from "vitest";

import { costOf, credits, money } from "./usage-format";

test("dollars: cents, four places below a cent, and a sliver said so", () => {
  expect([money(12.345), money(0.0044), money(0.00002), money(0)]).toEqual(["$12.35", "$0.0044", "under $0.0001", "$0.00"]);
});

test("a feature the provider priced none of isn't shown as free", () => {
  expect(costOf({ requests: 2, cost: 0, unpriced: 2 })).toBe("No price");
  expect(costOf({ requests: 3, cost: 0.01, unpriced: 1 })).toBe("$0.01");
  expect(costOf({ requests: 1, cost: 0, unpriced: 0 })).toBe("$0.00");
});

test("credits: whole from 100 up, two places below, and a sliver said so; a debt is negative", () => {
  expect([credits(1234.56), credits(12.345), credits(0.004), credits(0), credits(-3.5)]).toEqual(["1,235", "12.35", "under 0.01", "0", "-3.5"]);
});
