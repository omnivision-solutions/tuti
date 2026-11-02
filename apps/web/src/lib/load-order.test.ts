import { expect, test } from "vitest";

import { askedBy, loadOrder } from "./load-order";

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

test("a request's answer counts only while whoever it asked for is still who's here", () => {
  let who: string | null = "visitor-a";
  const asked = askedBy(() => who);
  expect(asked()).toBe(true);
  // Another visitor now: the first one's answer (an expired token, say) is ignored.
  who = "visitor-b";
  expect(asked()).toBe(false);
  // Gone (the list unmounted).
  who = null;
  expect(asked()).toBe(false);
  // Asked while nobody was here: nobody's answer.
  expect(askedBy(() => null)()).toBe(false);
});
