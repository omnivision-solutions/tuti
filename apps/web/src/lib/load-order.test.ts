import { expect, test } from "vitest";

import { loadOrder } from "./load-order";

test("an older answer shows when the newer load fails, and the newer failure still counts", () => {
  const order = loadOrder();
  const retry = order.start();
  const refresh = order.start();
  expect(order.shows(retry, true)).toBe(true);
  expect(order.shows(refresh, false)).toBe(true);
});

test("an older answer doesn't replace a newer one, and an older failure doesn't count", () => {
  const order = loadOrder();
  const first = order.start();
  const second = order.start();
  expect(order.shows(second, true)).toBe(true);
  expect(order.shows(first, true)).toBe(false);
  expect(order.shows(first, false)).toBe(false);
  // The newest answers in turn.
  expect(order.shows(order.start(), true)).toBe(true);
});
